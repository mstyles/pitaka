//! Book cover thumbnails (docs/plans/book-covers.md). `epub.rs` and
//! `pdf.rs` find a book's cover image; this turns it into the small JPEG
//! the library stores and the Books screen shows.

use anyhow::{bail, Result};
use image::imageops::FilterType;
use image::{DynamicImage, ImageReader, Limits, Rgb, RgbImage};
use sha2::{Digest, Sha256};
use std::io::Cursor;

/// The largest thumbnail: twice the grid card's size, for HiDPI screens.
pub(crate) const THUMB_MAX: (u32, u32) = (300, 450);

/// A cover file larger than this isn't decoded. The real library's
/// largest is 3.3 MB.
pub(crate) const MAX_SOURCE_BYTES: usize = 20 << 20;

/// Decoding limits, so a crafted header can't make the decoder allocate
/// gigabytes. The real library's largest cover is 1588×2528.
const MAX_SIDE: u32 = 8000;
const MAX_ALLOC: u64 = 256 << 20;

/// JPEG quality of the stored thumbnail.
const QUALITY: u8 = 80;

/// The paper colour (`--bg`'s cream) that transparent pixels are laid on.
const PAPER: [u8; 3] = [0xff, 0xfc, 0xf6];

/// Decodes a JPEG or PNG cover and returns a JPEG of it that fits within
/// `THUMB_MAX`, never larger than the source. Every stored cover is a
/// JPEG, and re-encoding drops anything odd the source file carried.
pub(crate) fn thumbnail(source: &[u8]) -> Result<Vec<u8>> {
    if source.len() > MAX_SOURCE_BYTES {
        bail!("cover image is too large");
    }
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_ALLOC);
    let mut reader = ImageReader::new(Cursor::new(source)).with_guessed_format()?;
    reader.limits(limits);
    let image = reader.decode()?;

    let rgb = on_paper(image);
    let (max_w, max_h) = THUMB_MAX;
    let rgb = if rgb.width() > max_w || rgb.height() > max_h {
        // `resize` keeps the aspect ratio, fitting within the bounds.
        DynamicImage::ImageRgb8(rgb)
            .resize(max_w, max_h, FilterType::Triangle)
            .into_rgb8()
    } else {
        rgb
    };

    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, QUALITY).encode_image(&rgb)?;
    Ok(out)
}

/// The image as RGB, with any transparency composited onto `PAPER`.
fn on_paper(image: DynamicImage) -> RgbImage {
    if !image.color().has_alpha() {
        return image.into_rgb8();
    }
    let rgba = image.into_rgba8();
    RgbImage::from_fn(rgba.width(), rgba.height(), |x, y| {
        let px = rgba.get_pixel(x, y).0;
        let alpha = u16::from(px[3]);
        let blend = |i: usize| {
            let over = u16::from(px[i]) * alpha + u16::from(PAPER[i]) * (255 - alpha);
            ((over + 127) / 255) as u8
        };
        Rgb([blend(0), blend(1), blend(2)])
    })
}

/// The first 12 hex digits of the thumbnail's SHA-256: the cache key in
/// the cover's URL, so a changed cover is never served from cache.
pub(crate) fn cover_key(thumb: &[u8]) -> String {
    Sha256::digest(thumb)
        .iter()
        .take(6)
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// A solid-colour JPEG, for tests and the UI fixtures.
#[cfg(test)]
pub(crate) fn test_jpeg(width: u32, height: u32) -> Vec<u8> {
    let img = RgbImage::from_pixel(width, height, Rgb([0x4a, 0x5d, 0x73]));
    let mut out = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 90)
        .encode_image(&img)
        .unwrap();
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::GenericImageView;

    fn decode(jpeg: &[u8]) -> DynamicImage {
        assert_eq!(&jpeg[..3], &[0xff, 0xd8, 0xff], "not a JPEG");
        image::load_from_memory(jpeg).unwrap()
    }

    #[test]
    fn thumbnail_fits_and_does_not_upscale() {
        let thumb = decode(&thumbnail(&test_jpeg(600, 900)).unwrap());
        assert_eq!(thumb.dimensions(), (300, 450));

        let (w, h) = decode(&thumbnail(&test_jpeg(1588, 2528)).unwrap()).dimensions();
        assert!(w <= 300 && h <= 450, "{w}x{h}");
        // 1588×2528 is taller than 2:3, so the height is the limit.
        assert_eq!(h, 450);
        let expected_w = 1588.0 * 450.0 / 2528.0;
        assert!((f64::from(w) - expected_w).abs() <= 1.0, "{w}x{h}");

        let small = decode(&thumbnail(&test_jpeg(100, 150)).unwrap());
        assert_eq!(small.dimensions(), (100, 150));
    }

    #[test]
    fn png_with_alpha_becomes_jpeg_on_paper() {
        let clear = image::RgbaImage::from_pixel(10, 10, image::Rgba([0, 0, 0, 0]));
        let mut png = Vec::new();
        DynamicImage::ImageRgba8(clear)
            .write_to(&mut Cursor::new(&mut png), image::ImageFormat::Png)
            .unwrap();

        let thumb = decode(&thumbnail(&png).unwrap()).into_rgb8();
        let centre = thumb.get_pixel(5, 5).0;
        for (got, want) in centre.iter().zip(PAPER) {
            assert!(got.abs_diff(want) <= 3, "{centre:?}");
        }
    }

    #[test]
    fn thumbnail_rejects_bad_input() {
        let noise: Vec<u8> = (0..4096u32)
            .map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8)
            .collect();
        assert!(thumbnail(&noise).is_err());
        assert!(thumbnail(&[]).is_err());
        assert!(thumbnail(&test_jpeg(MAX_SIDE + 1, 10)).is_err());
        let err = thumbnail(&vec![0; MAX_SOURCE_BYTES + 1]).unwrap_err();
        assert!(err.to_string().contains("too large"), "{err}");
    }

    #[test]
    fn cover_key_is_12_hex_and_tracks_content() {
        let a = cover_key(&thumbnail(&test_jpeg(100, 150)).unwrap());
        let b = cover_key(&thumbnail(&test_jpeg(120, 150)).unwrap());
        for key in [&a, &b] {
            assert_eq!(key.len(), 12);
            assert!(key
                .chars()
                .all(|c| c.is_ascii_digit() || ('a'..='f').contains(&c)));
        }
        assert_ne!(a, b);
    }
}
