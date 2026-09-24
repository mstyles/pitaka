pub mod db;
pub mod epub;
pub mod semantic;

pub use db::{
    add_bookmark, create_bookmark_folder, delete_book, delete_bookmark_folder, get_book_chapters,
    get_chapter_bookmarks, get_chapter_content, import_book, list_bookmark_folders, list_books,
    list_folder_bookmarks, open_db, remove_bookmark, rename_bookmark_folder, search,
    search_with_variants, semantic_status, BlockBookmark, BookSummary, BookmarkFolder,
    ChapterContent, ChapterMatch, ChapterSummary, ContentBlockRow, FolderBookmark, ImportOutcome,
    IndexReport, SearchMode, SearchResult, SemanticStatus, VariantIndex, LENGTH_PENALTY, MIN_SCORE,
};
#[cfg(feature = "semantic")]
pub use db::{index_book, search_chapters};
pub use epub::{parse_epub, ParsedBook};
