import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import BookmarkPopover from "./BookmarkPopover";
import type { BlockBookmark, BookmarkFolder, ChapterContent, ChapterSummary } from "./types";

type Props = {
  bookId: number;
  initialChapterId?: number;
  focusBlockId?: number;
  /** e.g. "← Search results": where the book was opened from. */
  backLabel: string;
  onBack: () => void;
};

function ReaderView({ bookId, initialChapterId, focusBlockId, backLabel, onBack }: Props) {
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  const [activeChapterId, setActiveChapterId] = useState<number | null>(initialChapterId ?? null);
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [flashBlockId, setFlashBlockId] = useState<number | null>(focusBlockId ?? null);
  const [error, setError] = useState("");
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  // Which folders each paragraph of the open chapter is bookmarked in.
  const [blockFolders, setBlockFolders] = useState<Map<number, Set<number>>>(new Map());
  const [popoverBlockId, setPopoverBlockId] = useState<number | null>(null);
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
    refreshFolders();
  }, []);

  useEffect(() => {
    if (activeChapterId == null) return;
    let cancelled = false;
    setPopoverBlockId(null);
    invoke<ChapterContent>("get_chapter_content", { chapterId: activeChapterId })
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((err) => setError(`Loading chapter failed: ${err}`));
    refreshBlockFolders(activeChapterId, () => cancelled);
    return () => {
      cancelled = true;
    };
  }, [activeChapterId]);

  async function refreshFolders() {
    try {
      setFolders(await invoke<BookmarkFolder[]>("list_bookmark_folders"));
    } catch (err) {
      setError(`Loading bookmark folders failed: ${err}`);
    }
  }

  async function refreshBlockFolders(chapterId: number, cancelled = () => false) {
    try {
      const marks = await invoke<BlockBookmark[]>("get_chapter_bookmarks", { chapterId });
      if (cancelled()) return;
      const map = new Map<number, Set<number>>();
      for (const m of marks) {
        if (!map.has(m.content_block_id)) map.set(m.content_block_id, new Set());
        map.get(m.content_block_id)!.add(m.folder_id);
      }
      setBlockFolders(map);
    } catch (err) {
      setError(`Loading bookmarks failed: ${err}`);
    }
  }

  function bookmarksChanged() {
    if (activeChapterId != null) refreshBlockFolders(activeChapterId);
    refreshFolders();
  }

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
        <button className="reader-back" onClick={onBack} title={backLabel}>
          {backLabel}
        </button>
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
          {content?.blocks.map((b) => {
            const inFolders = blockFolders.get(b.id);
            return (
              <div key={b.id} className="reader-block">
                <p
                  id={`block-${b.id}`}
                  className={b.id === flashBlockId ? "reader-paragraph flash" : "reader-paragraph"}
                >
                  {b.text}
                </p>
                <button
                  className={inFolders ? "bookmark-toggle bookmarked" : "bookmark-toggle"}
                  aria-label="Bookmark this passage"
                  aria-expanded={popoverBlockId === b.id}
                  onClick={() => setPopoverBlockId((open) => (open === b.id ? null : b.id))}
                >
                  <svg viewBox="0 0 16 20" width="14" height="18" aria-hidden="true">
                    <path d="M2 1h12v18l-6-5-6 5z" />
                  </svg>
                </button>
                {popoverBlockId === b.id && (
                  <BookmarkPopover
                    contentBlockId={b.id}
                    folders={folders}
                    checkedFolderIds={inFolders ?? new Set()}
                    onChanged={bookmarksChanged}
                    onClose={() => setPopoverBlockId(null)}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}

export default ReaderView;
