export type SearchMode = "stemmed" | "exact";

export type SearchResult = {
  book_id: number;
  book_title: string | null;
  chapter_id: number;
  chapter_idx: number;
  block_idx: number;
  content_block_id: number;
  snippet: string;
  rank: number;
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
