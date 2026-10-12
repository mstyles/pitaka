import {
  type MouseEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { segments, selectionOffsets } from "./annotate";
import BookmarkPopover from "./BookmarkPopover";
import HighlightPopover from "./HighlightPopover";
import { BookmarkIcon, PenIcon, SearchIcon } from "./icons";
import NoteCard from "./NoteCard";
import { atEnd, percentRead, SAVE_DELAY_MS, topVisibleBlockId } from "./readingPosition";
import SelectionToolbar from "./SelectionToolbar";
import { isEditable } from "./shortcuts";
import StatusLine, { failed } from "./StatusLine";
import type {
  BlockBookmark,
  BookmarkFolder,
  BookSummary,
  ChapterAnnotations,
  ChapterContent,
  ChapterSummary,
  ContentBlockRow,
  Highlight,
  HighlightColor,
  Note,
  ReadingPosition,
} from "./types";
import { useDelayed } from "./useDelayed";

/** The selection toolbar's state: what's selected, and where to draw it. */
type Toolbar = {
  /** Null when the selection crosses paragraphs. */
  target: { contentBlockId: number; start: number; end: number } | null;
  top: number;
  left: number;
  error: string;
};

/** A note card for a note that doesn't exist yet. */
type DraftNote = { contentBlockId: number; highlightId: number | null };

const NO_ANNOTATIONS: ChapterAnnotations = { highlights: [], notes: [] };

/** How long closing the window waits for a pending save. */
const CLOSE_SAVE_TIMEOUT_MS = 500;

/** The element a node is, or is in. */
function elementOf(node: Node | null) {
  return node instanceof Element ? node : (node?.parentElement ?? null);
}

type Props = {
  bookId: number;
  initialChapterId?: number;
  focusBlockId?: number;
  /** e.g. "← Search results": where the book was opened from. */
  backLabel: string;
  /** A note whose card starts open, when arriving from the note itself. */
  openNoteId?: number;
  onBack: () => void;
  /** Opens the Search screen limited to this book. */
  onSearchBook: (bookId: number) => void;
};

function ReaderView({
  bookId,
  initialChapterId,
  focusBlockId,
  backLabel,
  openNoteId,
  onBack,
  onSearchBook,
}: Props) {
  const [book, setBook] = useState<BookSummary | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
  /** Tells a book whose chapters are loading apart from one with none. */
  const [chaptersLoaded, setChaptersLoaded] = useState(false);
  const [activeChapterId, setActiveChapterId] = useState<number | null>(initialChapterId ?? null);
  const [content, setContent] = useState<ChapterContent | null>(null);
  const [flashBlockId, setFlashBlockId] = useState<number | null>(focusBlockId ?? null);
  const [error, setError] = useState("");
  const [folders, setFolders] = useState<BookmarkFolder[]>([]);
  // Which folders each paragraph of the open chapter is bookmarked in.
  const [blockFolders, setBlockFolders] = useState<Map<number, Set<number>>>(new Map());
  const [popoverBlockId, setPopoverBlockId] = useState<number | null>(null);
  const [annotations, setAnnotations] = useState<ChapterAnnotations>(NO_ANNOTATIONS);
  const [openNoteIds, setOpenNoteIds] = useState<Set<number>>(
    () => new Set(openNoteId != null ? [openNoteId] : []),
  );
  const [draftNote, setDraftNote] = useState<DraftNote | null>(null);
  const [toolbar, setToolbar] = useState<Toolbar | null>(null);
  const [highlightPopover, setHighlightPopover] = useState<{
    highlightId: number;
    top: number;
    left: number;
  } | null>(null);
  /** The saved paragraph to scroll to once its chapter loads. */
  const [resumeBlockId, setResumeBlockId] = useState<number | null>(null);
  /** The paragraph at the top of the screen, for the progress bar. */
  const [topBlockId, setTopBlockId] = useState<number | null>(null);
  /** Whether the end of the book is on screen. */
  const [endShowing, setEndShowing] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);
  // Saving the position. Only reading counts: nothing is saved until the
  // reader scrolls by hand or changes chapter in this visit, since the
  // reader's own scrollIntoView fires scroll events too.
  const readingRef = useRef(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savePendingRef = useRef(false);
  const lastSavedRef = useRef<{ blockId: number; finished: boolean } | null>(null);
  const frameRef = useRef<number | null>(null);
  const loadingContent = content == null && !error;
  const showTextSkeleton = useDelayed(loadingContent);
  const showChapterSkeleton = useDelayed(!chaptersLoaded && !error);

  useEffect(() => {
    let cancelled = false;
    // Opened at a hit, bookmark or note, that wins; otherwise the book
    // reopens where it was left. A failed lookup just starts at the top.
    const position =
      initialChapterId == null
        ? invoke<ReadingPosition | null>("get_reading_position", { bookId }).catch(() => null)
        : Promise.resolve(null);
    Promise.all([invoke<ChapterSummary[]>("get_book_chapters", { bookId }), position])
      .then(([chs, saved]) => {
        if (cancelled) return;
        setChapters(chs);
        setChaptersLoaded(true);
        if (saved && chs.some((c) => c.id === saved.chapter_id)) {
          lastSavedRef.current = { blockId: saved.content_block_id, finished: saved.finished };
          setResumeBlockId(saved.content_block_id);
          setActiveChapterId((prev) => prev ?? saved.chapter_id);
        } else {
          setActiveChapterId((prev) => prev ?? chs[0]?.id ?? null);
        }
      })
      .catch((err) => setError(`Loading chapters failed: ${err}`));
    return () => {
      cancelled = true;
    };
  }, [bookId]);

  // Search results and bookmarks don't carry the author, so look the book up.
  // A failure just leaves the header out; the chapter error covers a broken backend.
  useEffect(() => {
    let cancelled = false;
    invoke<BookSummary[]>("list_books")
      .then((books) => {
        if (!cancelled) setBook(books.find((b) => b.id === bookId) ?? null);
      })
      .catch(() => {});
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
    setHighlightPopover(null);
    setToolbar(null);
    setAnnotations(NO_ANNOTATIONS);
    invoke<ChapterContent>("get_chapter_content", { chapterId: activeChapterId })
      .then((c) => {
        if (!cancelled) setContent(c);
      })
      .catch((err) => setError(`Loading chapter failed: ${err}`));
    refreshBlockFolders(activeChapterId, () => cancelled);
    refreshAnnotations(activeChapterId, () => cancelled);
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

  async function refreshAnnotations(chapterId: number, cancelled = () => false) {
    try {
      const a = await invoke<ChapterAnnotations>("get_chapter_annotations", { chapterId });
      if (!cancelled()) setAnnotations(a);
    } catch (err) {
      setError(`Loading highlights and notes failed: ${err}`);
    }
  }

  function annotationsChanged() {
    if (activeChapterId != null) refreshAnnotations(activeChapterId);
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
    const resume = resumeBlockId != null ? document.getElementById(`block-${resumeBlockId}`) : null;
    let scrolledTo: number | null = null;
    if (target) {
      target.scrollIntoView({ block: "center" });
      scrolledTo = flashBlockId;
    } else if (resume) {
      resume.scrollIntoView({ block: "start" });
      scrolledTo = resumeBlockId;
      setResumeBlockId(null);
    } else if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
    // Before layout (and in jsdom) nothing can be measured, so the
    // paragraph scrolled to, or the chapter's first, stands in.
    const el = contentRef.current;
    setTopBlockId((el && topVisibleBlockId(el)) ?? scrolledTo ?? content.blocks[0]?.id ?? null);
    setEndShowing(el != null && isEnd(el));
    // A chapter the reader changed to is saved like a scroll.
    if (readingRef.current) scheduleSave();
  }, [content]);

  /** The last chapter with any text: reaching its end finishes the book. */
  const withText = chapters.filter((c) => c.char_count > 0);
  const lastChapterId = withText[withText.length - 1]?.id ?? null;

  function isEnd(el: HTMLElement) {
    return content != null && content.chapter_id === lastChapterId && atEnd(el);
  }

  /**
   * Saves the paragraph at the top of the screen if it, or whether the end
   * is showing, changed since the last save. A failed save is dropped
   * without a message, and the next one tries again.
   */
  function save(): Promise<void> {
    savePendingRef.current = false;
    const el = contentRef.current;
    const blockId = el ? topVisibleBlockId(el) : null;
    if (el == null || blockId == null) return Promise.resolve();
    const finished = isEnd(el);
    const last = lastSavedRef.current;
    if (last?.blockId === blockId && last.finished === finished) return Promise.resolve();
    const saved = { blockId, finished };
    lastSavedRef.current = saved;
    return invoke<void>("set_reading_position", { contentBlockId: blockId, finished }).catch(() => {
      if (lastSavedRef.current === saved) lastSavedRef.current = last;
    });
  }
  // The timer, leaving and closing the window call the latest render's.
  const saveRef = useRef(save);
  saveRef.current = save;

  function scheduleSave() {
    if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
    savePendingRef.current = true;
    saveTimerRef.current = setTimeout(() => {
      saveTimerRef.current = null;
      saveRef.current();
    }, SAVE_DELAY_MS);
  }

  function startedReading() {
    readingRef.current = true;
  }

  /** Restarts the save timer, and updates the progress once a frame. */
  function onScroll() {
    if (readingRef.current) scheduleSave();
    if (frameRef.current != null) return;
    frameRef.current = requestAnimationFrame(() => {
      frameRef.current = null;
      const el = contentRef.current;
      if (!el) return;
      const id = topVisibleBlockId(el);
      if (id != null) setTopBlockId(id);
      setEndShowing(isEnd(el));
    });
  }

  // Leaving the reader (which is how back works) saves a pending position
  // at once. A layout effect, so its cleanup runs while the text is still
  // laid out and can be measured.
  useLayoutEffect(
    () => () => {
      if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
      if (frameRef.current != null) cancelAnimationFrame(frameRef.current);
      if (savePendingRef.current) saveRef.current();
    },
    [],
  );

  // Closing the window waits for a pending save, but never for long: a
  // stuck database mustn't keep the window open.
  useEffect(() => {
    if (!isTauri()) return;
    let unlisten: (() => void) | null = null;
    let unmounted = false;
    getCurrentWindow()
      .onCloseRequested(async () => {
        if (!savePendingRef.current) return;
        if (saveTimerRef.current != null) clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
        await Promise.race([
          saveRef.current(),
          new Promise((resolve) => setTimeout(resolve, CLOSE_SAVE_TIMEOUT_MS)),
        ]);
      })
      .then((fn) => {
        if (unmounted) fn();
        else unlisten = fn;
      })
      .catch(() => {});
    return () => {
      unmounted = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (flashBlockId == null) return;
    const t = setTimeout(() => setFlashBlockId(null), 2000);
    return () => clearTimeout(t);
  }, [flashBlockId]);

  function selectChapter(chapterId: number) {
    startedReading();
    setFlashBlockId(null);
    setOpenNoteIds(new Set());
    setDraftNote(null);
    setActiveChapterId(chapterId);
  }

  // Escape or a click elsewhere puts the selection toolbar away.
  useEffect(() => {
    if (!toolbar) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setToolbar(null);
      }
    }
    function onMouseDown(e: globalThis.MouseEvent) {
      if (!(e.target as Element).closest?.(".selection-toolbar")) setToolbar(null);
    }
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("mousedown", onMouseDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("mousedown", onMouseDown);
    };
  }, [toolbar != null]);

  // Escape leaves the book, and ← / → change chapter. The popovers, the
  // selection toolbar and a note card handle Escape first (on `document`
  // or in React, both before `window`) and mark it handled, so Escape
  // closes the innermost thing first. Nothing happens while a note is
  // being written, so a stray key can't discard it.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.defaultPrevented || e.repeat || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) {
        return;
      }
      if (isEditable(e.target) || textRef.current?.querySelector(".note-card textarea")) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onBack();
      } else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
        const i = chapters.findIndex((c) => c.id === activeChapterId);
        const next = i < 0 ? undefined : chapters[e.key === "ArrowLeft" ? i - 1 : i + 1];
        if (next) {
          e.preventDefault();
          selectChapter(next.id);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [chapters, activeChapterId, onBack]);

  /** After a mouse or keyboard selection, offers to highlight what's selected. */
  function selectionEnded(e: { target: EventTarget }) {
    const target = e.target as Element;
    if (target.closest?.(".selection-toolbar, .note-card, .highlight-popover, .bookmark-popover")) {
      return;
    }
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !sel.toString().trim()) {
      setToolbar(null);
      return;
    }
    const paragraphOf = (node: Node | null) =>
      elementOf(node)?.closest<HTMLElement>(".reader-paragraph") ?? null;
    const anchor = paragraphOf(sel.anchorNode);
    const focus = paragraphOf(sel.focusNode);
    if (!anchor && !focus) {
      setToolbar(null);
      return;
    }
    const range = sel.getRangeAt(0);
    // jsdom has no layout, and no Range.getBoundingClientRect.
    let top = 0;
    let left = 0;
    if (typeof range.getBoundingClientRect === "function" && textRef.current) {
      const r = range.getBoundingClientRect();
      const base = textRef.current.getBoundingClientRect();
      top = r.top - base.top;
      left = r.left + r.width / 2 - base.left;
    }
    let toolbarTarget: Toolbar["target"] = null;
    if (anchor && anchor === focus) {
      const { start, end } = selectionOffsets(anchor, range);
      if (start >= end) {
        setToolbar(null);
        return;
      }
      toolbarTarget = { contentBlockId: Number(anchor.dataset.blockId), start, end };
    }
    setPopoverBlockId(null);
    setHighlightPopover(null);
    setToolbar({ target: toolbarTarget, top, left, error: "" });
  }

  async function highlightSelection(color: HighlightColor) {
    if (!toolbar?.target) return null;
    try {
      const h = await invoke<Highlight>("add_highlight", { ...toolbar.target, color });
      window.getSelection()?.removeAllRanges();
      setToolbar(null);
      annotationsChanged();
      return h;
    } catch (err) {
      setToolbar({ ...toolbar, error: String(err) });
      return null;
    }
  }

  async function noteSelection() {
    const h = await highlightSelection("yellow");
    if (h) setDraftNote({ contentBlockId: h.content_block_id, highlightId: h.id });
  }

  function toggleNote(noteId: number) {
    setOpenNoteIds((open) => {
      const next = new Set(open);
      if (!next.delete(noteId)) next.add(noteId);
      return next;
    });
  }

  function closeNote(noteId: number) {
    setOpenNoteIds((open) => {
      const next = new Set(open);
      next.delete(noteId);
      return next;
    });
  }

  function openHighlight(e: MouseEvent<HTMLElement>, highlightId: number) {
    // The end of a drag that began on the highlight is a selection, not a click.
    if (!window.getSelection()?.isCollapsed) return;
    const block = e.currentTarget.closest(".reader-block")!;
    const m = e.currentTarget.getBoundingClientRect();
    const b = block.getBoundingClientRect();
    setToolbar(null);
    setPopoverBlockId(null);
    setHighlightPopover((open) =>
      open?.highlightId === highlightId
        ? null
        : { highlightId, top: m.bottom - b.top + 4, left: m.left - b.left },
    );
  }

  function noteHint(note: Note) {
    const open = openNoteIds.has(note.id);
    return (
      <button
        className="note-hint"
        aria-label={open ? "Hide note" : "Show note"}
        aria-expanded={open}
        onClick={() => toggleNote(note.id)}
      >
        <PenIcon size={11} />
      </button>
    );
  }

  /** A paragraph's text with its highlights, each followed by its note marker. */
  function paragraphText(b: ContentBlockRow, highlights: Highlight[], notes: Note[]) {
    const parts: ReactNode[] = segments(b.text, highlights).map((seg, i) => {
      const h = seg.highlight;
      if (!h) return seg.text;
      const note = notes.find((n) => n.highlight_id === h.id);
      return (
        <span key={i}>
          <mark
            className={`hl hl-${h.color}`}
            data-highlight-id={h.id}
            onClick={(e) => openHighlight(e, h.id)}
          >
            {seg.text}
          </mark>
          {note && noteHint(note)}
        </span>
      );
    });
    const own = notes.find((n) => n.highlight_id == null);
    if (own) parts.push(<span key="own">{noteHint(own)}</span>);
    return parts;
  }

  /** The open note cards for a paragraph, in the order of their markers. */
  function noteCards(b: ContentBlockRow, highlights: Highlight[], notes: Note[]) {
    const startOf = (highlightId: number | null) =>
      highlightId == null
        ? Infinity
        : (highlights.find((h) => h.id === highlightId)?.start_offset ?? Infinity);
    const colorOf = (highlightId: number | null) =>
      highlights.find((h) => h.id === highlightId)?.color ?? null;
    const cards = notes
      .filter((n) => openNoteIds.has(n.id))
      .map((n) => ({ key: `note-${n.id}`, note: n as Note | null, highlightId: n.highlight_id }));
    if (draftNote?.contentBlockId === b.id) {
      cards.push({ key: "draft", note: null, highlightId: draftNote.highlightId });
    }
    cards.sort((x, y) => startOf(x.highlightId) - startOf(y.highlightId));
    return cards.map((c) => (
      <NoteCard
        key={c.key}
        note={c.note}
        contentBlockId={b.id}
        highlightId={c.highlightId}
        color={colorOf(c.highlightId)}
        onChanged={annotationsChanged}
        onCreated={(note) => {
          setDraftNote(null);
          setOpenNoteIds((open) => new Set(open).add(note.id));
        }}
        onClose={() => (c.note ? closeNote(c.note.id) : setDraftNote(null))}
      />
    ));
  }

  function toggleParagraphNote(b: ContentBlockRow, own: Note | undefined) {
    if (own) {
      toggleNote(own.id);
    } else {
      setDraftNote((d) =>
        d?.contentBlockId === b.id && d.highlightId == null
          ? null
          : { contentBlockId: b.id, highlightId: null },
      );
    }
  }

  // How far through the book the top of the screen is.
  const chapterPlace = content ? chapters.findIndex((c) => c.id === content.chapter_id) : -1;
  const progress =
    content && chapterPlace >= 0
      ? {
          chapter: chapterPlace + 1,
          finished: endShowing,
          percent: endShowing
            ? 100
            : percentRead(
                chapters,
                content.chapter_id,
                content.blocks,
                topBlockId ?? content.blocks[0]?.id ?? -1,
              ),
        }
      : null;

  return (
    <main className="reader">
      <nav className="reader-sidebar" aria-label="Chapters">
        <button className="reader-back button-quiet" onClick={onBack} title={backLabel}>
          {backLabel}
        </button>
        {book && (
          <div className="reader-book">
            <div className="reader-book-title">{book.title ?? "Untitled"}</div>
            <div className="reader-book-author">{book.author ?? "Unknown author"}</div>
            {progress && (
              <div className="reader-progress-label">
                Chapter {progress.chapter} of {chapters.length} ·{" "}
                {progress.finished ? "Finished" : `${progress.percent}%`}
              </div>
            )}
            <button
              className="reader-search-book button-sm button-icon"
              onClick={() => onSearchBook(bookId)}
            >
              <SearchIcon size={16} />
              Search this book
            </button>
          </div>
        )}
        {showChapterSkeleton && (
          <ul className="reader-chapter-list" aria-busy="true" aria-label="Loading chapters">
            {Array.from({ length: 6 }, (_, i) => (
              <li key={i} className="skeleton-chapter">
                <span className="skeleton skeleton-title" />
              </li>
            ))}
          </ul>
        )}
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
      <div
        className="reader-content"
        ref={contentRef}
        onScroll={onScroll}
        onWheel={startedReading}
        onTouchMove={startedReading}
        onPointerDown={startedReading}
        onKeyDown={startedReading}
      >
        {progress && (
          <div
            className="reader-progress"
            role="progressbar"
            aria-label="Reading progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
          >
            <div className="reader-progress-fill" style={{ width: `${progress.percent}%` }} />
          </div>
        )}
        <div
          className="reader-text"
          ref={textRef}
          aria-busy={showTextSkeleton || undefined}
          onMouseUp={selectionEnded}
          onKeyUp={selectionEnded}
        >
          {error && <StatusLine status={failed(error)} className="reader-error" />}
          {showTextSkeleton &&
            Array.from({ length: 4 }, (_, i) => (
              <p key={i} className="skeleton-paragraph">
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line" />
                <span className="skeleton skeleton-line" />
              </p>
            ))}
          {toolbar && (
            <SelectionToolbar
              top={toolbar.top}
              left={toolbar.left}
              valid={toolbar.target != null}
              error={toolbar.error}
              onHighlight={highlightSelection}
              onAddNote={noteSelection}
            />
          )}
          {content?.blocks.map((b) => {
            const inFolders = blockFolders.get(b.id);
            const highlights = annotations.highlights.filter((h) => h.content_block_id === b.id);
            const notes = annotations.notes.filter((n) => n.content_block_id === b.id);
            const own = notes.find((n) => n.highlight_id == null);
            const popoverHighlight = highlights.find((h) => h.id === highlightPopover?.highlightId);
            const ownOpen =
              own != null
                ? openNoteIds.has(own.id)
                : draftNote?.contentBlockId === b.id && draftNote.highlightId == null;
            return (
              <div key={b.id} className="reader-block">
                <p
                  id={`block-${b.id}`}
                  data-block-id={b.id}
                  className={b.id === flashBlockId ? "reader-paragraph flash" : "reader-paragraph"}
                >
                  {paragraphText(b, highlights, notes)}
                </p>
                <div className="note-margin">{noteCards(b, highlights, notes)}</div>
                <button
                  className={own ? "note-toggle noted" : "note-toggle"}
                  aria-label="Note on this passage"
                  aria-expanded={ownOpen}
                  onClick={() => toggleParagraphNote(b, own)}
                >
                  <PenIcon size={13} />
                </button>
                {popoverHighlight && highlightPopover && (
                  <HighlightPopover
                    highlight={popoverHighlight}
                    hasNote={notes.some((n) => n.highlight_id === popoverHighlight.id)}
                    top={highlightPopover.top}
                    left={highlightPopover.left}
                    onAddNote={() => {
                      setDraftNote({ contentBlockId: b.id, highlightId: popoverHighlight.id });
                      setHighlightPopover(null);
                    }}
                    onChanged={annotationsChanged}
                    onRemoved={() =>
                      setDraftNote((d) => (d?.highlightId === popoverHighlight.id ? null : d))
                    }
                    onClose={() => setHighlightPopover(null)}
                  />
                )}
                <button
                  className={inFolders ? "bookmark-toggle bookmarked" : "bookmark-toggle"}
                  aria-label="Bookmark this passage"
                  aria-expanded={popoverBlockId === b.id}
                  onClick={() => {
                    setToolbar(null);
                    setHighlightPopover(null);
                    setPopoverBlockId((open) => (open === b.id ? null : b.id));
                  }}
                >
                  <BookmarkIcon />
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
