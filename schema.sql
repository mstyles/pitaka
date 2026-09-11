-- =========================================================================
-- E-book research app — core schema
-- =========================================================================
-- Design principle: every piece of text in the library is addressable by a
-- stable (book_id, chapter_index, char_offset) location. Bookmarks,
-- highlights, notes, and search results all point back to this same
-- location model, so nothing needs to know about pixel coordinates or
-- rendered layout — that makes reflow (font size, window resize) a
-- non-issue for annotations.
-- =========================================================================

PRAGMA foreign_keys = ON;

-- ---------------------------------------------------------------------
-- One row per imported book.
-- ---------------------------------------------------------------------
CREATE TABLE books (
    id              INTEGER PRIMARY KEY,
    file_path       TEXT NOT NULL UNIQUE,   -- absolute path on disk
    file_hash       TEXT NOT NULL,          -- content hash, detects edits/moves
    title           TEXT,
    author          TEXT,
    format          TEXT NOT NULL,          -- 'epub' | 'pdf' | 'mobi'
    added_at        TEXT NOT NULL DEFAULT (datetime('now')),
    last_indexed_at TEXT,
    last_opened_at  TEXT
);

-- ---------------------------------------------------------------------
-- One row per chapter/section within a book (EPUB spine item, or a
-- logical PDF section if you build that out later).
-- ---------------------------------------------------------------------
CREATE TABLE chapters (
    id          INTEGER PRIMARY KEY,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    idx         INTEGER NOT NULL,   -- order within the book, 0-based
    title       TEXT,
    UNIQUE (book_id, idx)
);

-- ---------------------------------------------------------------------
-- Paragraph-level chunks of plain text. This is the atomic unit that
-- search matches against and that locations are expressed relative to.
-- char_start/char_end are offsets into the chapter's full plain-text
-- string (useful for reconstructing context and for highlight anchoring
-- that spans paragraph boundaries).
-- ---------------------------------------------------------------------
CREATE TABLE content_blocks (
    id          INTEGER PRIMARY KEY,
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    block_idx   INTEGER NOT NULL,   -- paragraph order within the chapter
    char_start  INTEGER NOT NULL,   -- offset within chapter plain text
    char_end    INTEGER NOT NULL,
    text        TEXT NOT NULL
);

CREATE INDEX idx_content_blocks_chapter ON content_blocks(chapter_id, block_idx);

-- ---------------------------------------------------------------------
-- Full-text search index (SQLite FTS5). Kept as an external-content
-- table so the indexed text isn't duplicated on disk — it's pulled live
-- from content_blocks. content_rowid must match content_blocks.id.
-- ---------------------------------------------------------------------
CREATE VIRTUAL TABLE content_fts USING fts5(
    text,
    content='content_blocks',
    content_rowid='id',
    tokenize='porter unicode61'
);

-- Triggers to keep the FTS index in sync with content_blocks.
CREATE TRIGGER content_blocks_ai AFTER INSERT ON content_blocks BEGIN
    INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER content_blocks_ad AFTER DELETE ON content_blocks BEGIN
    INSERT INTO content_fts(content_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER content_blocks_au AFTER UPDATE ON content_blocks BEGIN
    INSERT INTO content_fts(content_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
END;

-- ---------------------------------------------------------------------
-- Annotations. Each anchors to a content_block plus an offset range
-- within that block's text, so it survives re-flow and re-rendering.
-- ---------------------------------------------------------------------
CREATE TABLE bookmarks (
    id              INTEGER PRIMARY KEY,
    book_id         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
    label           TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE highlights (
    id              INTEGER PRIMARY KEY,
    book_id         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
    start_offset    INTEGER NOT NULL,  -- offset within the block's text
    end_offset      INTEGER NOT NULL,
    color           TEXT DEFAULT 'yellow',
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE notes (
    id              INTEGER PRIMARY KEY,
    book_id         INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
    highlight_id    INTEGER REFERENCES highlights(id) ON DELETE SET NULL, -- optional: note attached to a highlight
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ---------------------------------------------------------------------
-- Example queries
-- ---------------------------------------------------------------------

-- Full-text search across the whole library, with ranked snippets and
-- enough joined metadata to jump straight to the result:
--
-- SELECT
--     b.title, b.author, ch.title AS chapter_title,
--     cb.id AS content_block_id, cb.block_idx,
--     snippet(content_fts, 0, '[', ']', '...', 12) AS snippet,
--     bm25(content_fts) AS rank
-- FROM content_fts
-- JOIN content_blocks cb ON cb.id = content_fts.rowid
-- JOIN chapters ch       ON ch.id = cb.chapter_id
-- JOIN books b           ON b.id = cb.book_id
-- WHERE content_fts MATCH ?
-- ORDER BY rank
-- LIMIT 50;
