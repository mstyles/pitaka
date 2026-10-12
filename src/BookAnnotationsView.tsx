import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import EmptyState from "./EmptyState";
import { HighlightIcon } from "./icons";
import { SkeletonPassages } from "./Skeleton";
import StatusLine, { failed, type Status } from "./StatusLine";
import type { AnnotatedBook, BookAnnotation } from "./types";
import { useDelayed } from "./useDelayed";

type Props = {
  book: AnnotatedBook;
  onBack: () => void;
  onOpenEntry: (entry: BookAnnotation) => void;
};

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** One book's highlights and notes in reading order, under chapter headings. */
function BookAnnotationsView({ book, onBack, onOpenEntry }: Props) {
  // Null until loaded, so the screen doesn't briefly list nothing.
  const [entries, setEntries] = useState<BookAnnotation[] | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const showSkeleton = useDelayed(entries == null && status == null);

  // Remounted on return from the reader, so this also picks up changes made there.
  useEffect(() => {
    invoke<BookAnnotation[]>("list_book_annotations", { bookId: book.book_id })
      .then(setEntries)
      .catch((err) => setStatus(failed(`Loading highlights and notes failed: ${err}`)));
  }, [book.book_id]);

  // Entries arrive in reading order, so each chapter's are already together.
  const chapters: { id: number; title: string; entries: BookAnnotation[] }[] = [];
  for (const e of entries ?? []) {
    if (chapters[chapters.length - 1]?.id !== e.chapter_id) {
      chapters.push({
        id: e.chapter_id,
        title: e.chapter_title ?? `Chapter ${e.chapter_idx + 1}`,
        entries: [],
      });
    }
    chapters[chapters.length - 1].entries.push(e);
  }

  return (
    <main className="container">
      <div className="folder-header">
        <button className="button-quiet" onClick={onBack}>
          ← Bookmarks &amp; notes
        </button>
        <h2 className="folder-name">{book.title ?? "Untitled"}</h2>
      </div>
      {status ? (
        <StatusLine status={status} className="folder-status" />
      ) : (
        <div className="folder-status">
          {`${plural(book.highlight_count, "highlight")}, ${plural(book.note_count, "note")}`}
        </div>
      )}
      {entries == null && showSkeleton && (
        <SkeletonPassages count={2} label="Loading highlights and notes" />
      )}
      {entries?.length === 0 && (
        <EmptyState icon={<HighlightIcon size={28} />} title="No highlights or notes left">
          Everything in this book was removed. Select text while reading to add more.
        </EmptyState>
      )}
      {chapters.map((ch) => (
        <section key={ch.id} className="annotation-chapter">
          <h3 className="section-label">{ch.title}</h3>
          <ul className="folder-passages">
            {ch.entries.map((e) => (
              <li
                key={e.highlight_id != null ? `h${e.highlight_id}` : `n${e.note_id}`}
                className="folder-passage annotation-entry"
                onClick={() => onOpenEntry(e)}
              >
                <div className={`annotation-quote${e.color ? ` hl-bar-${e.color}` : ""}`}>
                  {e.text}
                </div>
                {e.note_body && <div className="annotation-note">{e.note_body}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </main>
  );
}

export default BookAnnotationsView;
