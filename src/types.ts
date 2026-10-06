export type SearchMode = "stemmed" | "exact";

export type SearchResult = {
  book_id: number;
  book_title: string | null;
  chapter_id: number;
  chapter_idx: number;
  chapter_title: string | null;
  block_idx: number;
  content_block_id: number;
  snippet: string;
  rank: number;
};

export type ChapterMatch = {
  book_id: number;
  book_title: string | null;
  chapter_id: number;
  chapter_idx: number;
  chapter_title: string | null;
  content_block_id: number;
  score: number;
  preview: string;
};

export type SemanticStatus = {
  available: boolean;
  indexed_books: number;
  total_books: number;
};

export type SemanticIndexProgress = {
  book_id: number;
  done: number;
  total: number;
  /** Books queued behind this one. */
  queued: number;
};

/** A run ended partway by Stop indexing; the next run carries on from `done`. */
export type SemanticIndexStopped = {
  book_id: number;
  done: number;
  total: number;
};

/** How far a book is indexed for chapter search. */
export type IndexState = "none" | "partial" | "indexed";

export type SemanticIndexFailed = {
  book_id: number;
  error: string;
};

export type ImportOutcome = {
  book_id: number;
  already_imported: boolean;
};

/** What `find_books` found under a picked folder, in import order. */
export type BookScan = {
  paths: string[];
  /** Entries that couldn't be read, such as a folder without permission. */
  unreadable: string[];
};

export type BookSummary = {
  id: number;
  title: string | null;
  author: string | null;
  chapter_count: number;
  bookmark_count: number;
  highlight_count: number;
  note_count: number;
  index_state: IndexState;
};

export type ChapterSummary = {
  id: number;
  idx: number;
  title: string | null;
};

export type ContentBlockRow = {
  id: number;
  block_idx: number;
  text: string;
};

export type ChapterContent = {
  chapter_id: number;
  chapter_idx: number;
  chapter_title: string | null;
  book_id: number;
  blocks: ContentBlockRow[];
};

export type BookmarkFolder = {
  id: number;
  name: string;
  created_at: string;
  bookmark_count: number;
};

export type FolderBookmark = {
  id: number;
  folder_id: number;
  content_block_id: number;
  book_id: number;
  book_title: string | null;
  chapter_id: number;
  chapter_idx: number;
  chapter_title: string | null;
  text: string;
};

export type BlockBookmark = {
  content_block_id: number;
  folder_id: number;
};

export type HighlightColor = "yellow" | "green" | "blue" | "pink";

/** Offsets count code points (Unicode scalar values), not UTF-16 units. */
export type Highlight = {
  id: number;
  content_block_id: number;
  start_offset: number;
  end_offset: number;
  color: HighlightColor;
  created_at: string;
};

/** A note on a highlight, or on its whole paragraph when `highlight_id` is null. */
export type Note = {
  id: number;
  content_block_id: number;
  highlight_id: number | null;
  body: string;
  created_at: string;
  updated_at: string;
};

export type ChapterAnnotations = {
  highlights: Highlight[];
  notes: Note[];
};

export type AnnotatedBook = {
  book_id: number;
  title: string | null;
  author: string | null;
  highlight_count: number;
  note_count: number;
};

/** A highlight (with its note, if any) or a paragraph note. */
export type BookAnnotation = {
  content_block_id: number;
  chapter_id: number;
  chapter_idx: number;
  chapter_title: string | null;
  highlight_id: number | null;
  color: HighlightColor | null;
  /** The highlighted words, or the whole paragraph for a paragraph note. */
  text: string;
  note_id: number | null;
  note_body: string | null;
};
