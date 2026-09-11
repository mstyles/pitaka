pub mod db;
pub mod epub;

pub use db::{open_db, search, SearchResult};
pub use epub::{parse_epub, ParsedBook};
