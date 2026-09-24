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
};

export type SemanticIndexFailed = {
  book_id: number;
  error: string;
};

export type ImportOutcome = {
  book_id: number;
  already_imported: boolean;
};

export type BookSummary = {
  id: number;
  title: string | null;
  author: string | null;
  chapter_count: number;
  bookmark_count: number;
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
