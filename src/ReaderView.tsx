import { type MouseEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { segments, selectionOffsets } from "./annotate";
import BookmarkPopover from "./BookmarkPopover";
import HighlightPopover from "./HighlightPopover";
import NoteCard from "./NoteCard";
import SelectionToolbar from "./SelectionToolbar";
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
} from "./types";

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

function PenIcon() {
  return (
    <svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true">
      <path d="M11.5 1.5l3 3-9 9H2.5v-3z" />
    </svg>
  );
}

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
};

function ReaderView({
  bookId,
  initialChapterId,
  focusBlockId,
  backLabel,
  openNoteId,
  onBack,
}: Props) {
  const [book, setBook] = useState<BookSummary | null>(null);
  const [chapters, setChapters] = useState<ChapterSummary[]>([]);
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
  const contentRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

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
    setOpenNoteIds(new Set());
    setDraftNote(null);
    setActiveChapterId(chapterId);
  }

  // Escape or a click elsewhere puts the selection toolbar away.
  useEffect(() => {
    if (!toolbar) return;
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") setToolbar(null);
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
        <PenIcon />
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

  return (
    <main className="reader">
      <nav className="reader-sidebar" aria-label="Chapters">
        <button className="reader-back" onClick={onBack} title={backLabel}>
          {backLabel}
        </button>
        {book && (
          <div className="reader-book">
            <div className="reader-book-title">{book.title ?? "Untitled"}</div>
            <div className="reader-book-author">{book.author ?? "Unknown author"}</div>
          </div>
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
      <div className="reader-content" ref={contentRef}>
        <div
          className="reader-text"
          ref={textRef}
          onMouseUp={selectionEnded}
          onKeyUp={selectionEnded}
        >
          {error && <p className="reader-error">{error}</p>}
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
                  <PenIcon />
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
