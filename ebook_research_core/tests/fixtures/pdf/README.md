# PDF test fixtures

Made with LibreOffice 26.2 (`soffice`) from `test.fodt`, an A6 book of
four pages: a title page with "A Test Book" in a 24pt title (no document
title is set), then "Introduction" and "Methods" as Heading 1 entries,
which become the outline. Pages 2–4 carry a "Running Head N" header. The
Introduction breaks "gradi-" / "ent" across a line and has "saṃsāra",
and the long Methods paragraph runs from page 3 onto page 4.

Rebuild them from this folder with:

```sh
S=$(mktemp -d)

# test.pdf: outline, no metadata title.
soffice --headless --convert-to pdf test.fodt

# no-outline.pdf: the same text without bookmarks, titled "Metadata Title".
sed 's|<office:meta/>|<office:meta><dc:title>Metadata Title</dc:title></office:meta>|' \
  test.fodt > "$S/no-outline.fodt"
soffice --headless --outdir . --convert-to \
  'pdf:writer_pdf_Export:{"ExportBookmarks":{"type":"boolean","value":"false"}}' \
  "$S/no-outline.fodt"

# owner-password.pdf: restricts printing and copying, opens without a password.
cp test.fodt "$S/owner-password.fodt"
soffice --headless --outdir . --convert-to \
  'pdf:writer_pdf_Export:{"RestrictPermissions":{"type":"boolean","value":"true"},"PermissionPassword":{"type":"string","value":"owner"},"Printing":{"type":"long","value":"0"},"Changes":{"type":"long","value":"0"},"EnableCopyingOfContent":{"type":"boolean","value":"false"}}' \
  "$S/owner-password.fodt"

# password.pdf: needs the password "secret" to open.
cp test.fodt "$S/password.fodt"
soffice --headless --outdir . --convert-to \
  'pdf:writer_pdf_Export:{"EncryptFile":{"type":"boolean","value":"true"},"DocumentOpenPassword":{"type":"string","value":"secret"}}' \
  "$S/password.fodt"

# scanned.pdf: one image-only page.
python3 -c "from PIL import Image, ImageDraw; im = Image.new('L', (600, 800), 255); \
ImageDraw.Draw(im).text((50, 50), 'A scanned page', fill=0); im.save('$S/scanned.png')"
soffice --headless --outdir . --convert-to pdf "$S/scanned.png"

# panics.pdf: a valid one-page PDF whose font has an encoding name
# pdf-extract panics on ("unexpected encoding").
python3 make_panics_pdf.py panics.pdf
```
