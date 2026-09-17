import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ChapterContent, ChapterSummary } from "./types";

type Props = {
  bookId: number;
  initialChapterId?: number;
  focusBlockId?: number;
  onBack: () => void;
};

function ReaderView({ bookId, initialChapterId, focusBlockId, onBack }: Props) {
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [activeChapterId, setActiveChapterId] = useState<number | null>(initialChapterId ?? null);
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [flashBlockId, setFlashBlockId] = useState<number | null>(focusBlockId ?? null);
  const [error, setError] = useState("");
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ChapterSummary[]>("get_book_chapters", { bookId })
      .then((chs) => {
        if (cancelled) return;
        setChapters(chs);
        setActiveChapterId((prev) => prev ?? chs[0]?.id ?? null);
      })
      .catch((err) => setError(`Loading chapters failed: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  useEffect(() => {
    if (activeChapterId == null) return;
    let cancelled = false;
    invoke<ChapterContent>("get_chapter_content", { chapterId: activeChapterId })
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((err) => setError(`Loading chapter failed: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [activeChapterId]);

  // Runs only when new chapter content arrives, so the flash timeout clearing
  // flashBlockId doesn't yank the scroll position back to the top.
  useEffect(() => {
    if (!content) return;
    const target = flashBlockId != null ? document.getElementById(`block-${flashBlockId}`) : null;
    if (target) {
      target.scrollIntoView({ block: "center" });
    } else if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [content]);

  useEffect(() => {
    if (flashBlockId == null) return;
    const t = setTimeout(() => setFlashBlockId(null), 2000);
    return () => clearTimeout(t);
  }, [flashBlockId]);

  function selectChapter(chapterId: number) {
    setFlashBlockId(null);
    setActiveChapterId(chapterId);
  }

  return (
    <main className="reader">
      <nav className="reader-sidebar">
        <button onClick={onBack}>← Library</button>
        <ul className="reader-chapter-list">
          {chapters.map((c) => (
            <li key={c.id}>
              <button
                className={c.id === activeChapterId ? "active" : ""}
                onClick={() => selectChapter(c.id)}
              >
                {c.title ?? `Chapter ${c.idx + 1}`}
              </button>
            </li>
          ))}
        </ul>
      </nav>
      <div className="reader-content" ref={contentRef}>
        <div className="reader-text">
          {error && <p className="reader-error">{error}</p>}
          {content?.blocks.map((b) => (
            <p
              key={b.id}
              id={`block-${b.id}`}
              className={b.id === flashBlockId ? "reader-paragraph flash" : "reader-paragraph"}
            >
              {b.text}
            </p>
          ))}
        </div>
      </div>
    </main>
  );
}

export default ReaderView;
