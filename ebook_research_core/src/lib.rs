pub mod db;
pub mod epub;
pub mod index_queue;
pub mod pdf;
pub mod semantic;

pub use db::{
    add_bookmark, add_highlight, add_highlight_note, add_paragraph_note, books_to_index,
    create_bookmark_folder, delete_book, delete_bookmark_folder, delete_highlight, delete_note,
    find_books, get_book_chapters, get_chapter_annotations, get_chapter_bookmarks,
    get_chapter_content, import_book, list_annotated_books, list_book_annotations,
    list_bookmark_folders, list_books, list_folder_bookmarks, open_db, remove_bookmark,
    rename_bookmark_folder, search, search_with_variants, semantic_status, set_highlight_color,
    update_note, AnnotatedBook, BlockBookmark, BookAnnotation, BookScan, BookSummary,
    BookmarkFolder, ChapterAnnotations, ChapterContent, ChapterMatch, ChapterSummary,
    ContentBlockRow, FolderBookmark, Highlight, ImportOutcome, IndexReport, IndexState, Note,
    SearchMode, SearchResult, SemanticStatus, VariantIndex, HIGHLIGHT_COLORS, LENGTH_PENALTY,
    MIN_SCORE,
};
#[cfg(feature = "semantic")]
pub use db::{index_book, search_chapters};
pub use epub::{parse_epub, ParsedBook};
pub use index_queue::IndexQueue;
pub use pdf::parse_pdf;
