import { useState, type CSSProperties } from "react";
import { convertFileSrc } from "@tauri-apps/api/core";
import type { BookSummary } from "./types";

/** How many `--cover-N` tints App.css defines for generated covers. */
const TINTS = 6;

/**
 * A book's cover: its thumbnail, served by the app's `cover://` protocol, or
 * a typographic one for a book without a cover. `thumb` is the list rows'
 * small cover, `card` the grid's.
 *
 * Both are decorative (empty `alt`, or `aria-hidden`): the book's title is
 * always right beside the cover.
 */
function BookCover({ book, size }: { book: BookSummary; size: "thumb" | "card" }) {
  // In `npm run dev:mock`, the demo and tests, `cover://` doesn't resolve in a
  // browser, so every image fails and falls back to the generated cover.
  // Kept by URL, so a cover found later (a new key) is tried afresh.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const src = book.cover ? convertFileSrc(`${book.id}-${book.cover}`, "cover") : null;

  if (src && src !== failedSrc) {
    return (
      <img
        className={`cover cover-${size}`}
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => setFailedSrc(src)}
      />
    );
  }

  const title = book.title ?? "Untitled";
  // From the id, which survives editing the title and restoring a backup,
  // and gives neighbouring books different colours.
  const style = { "--cover-tint": `var(--cover-${(book.id % TINTS) + 1})` } as CSSProperties;
  return (
    <div className={`cover cover-${size} cover-generated`} style={style} aria-hidden="true">
      {size === "thumb" ? (
        <span className="cover-initial">{Array.from(title.trim())[0] ?? "U"}</span>
      ) : (
        <>
          <span className="cover-title">{title}</span>
          <span className="cover-author">{book.author ?? "Unknown author"}</span>
        </>
      )}
    </div>
  );
}

export default BookCover;
