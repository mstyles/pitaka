-- =========================================================================
-- Migration 003 — bookmark folders
-- =========================================================================
-- Bookmarks are whole paragraphs grouped into named folders that span the
-- library. A paragraph can be in any number of folders, at most once per
-- folder, and every bookmark is in a folder. SQLite can only add a nullable
-- column, so `bookmarks` is rebuilt to get `folder_id NOT NULL` and the
-- UNIQUE constraint. No other table references it.
-- =========================================================================

CREATE TABLE bookmark_folders (
    id         INTEGER PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Any bookmarks written before folders existed go into one "Bookmarks" folder.
INSERT INTO bookmark_folders (name)
    SELECT 'Bookmarks' WHERE EXISTS (SELECT 1 FROM bookmarks);

CREATE TABLE bookmarks_new (
    id               INTEGER PRIMARY KEY,
    folder_id        INTEGER NOT NULL REFERENCES bookmark_folders(id) ON DELETE CASCADE,
    book_id          INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
    label            TEXT,             -- unused for now
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (folder_id, content_block_id)
);
INSERT OR IGNORE INTO bookmarks_new (id, folder_id, book_id, content_block_id, label, created_at)
    SELECT b.id, (SELECT id FROM bookmark_folders), b.book_id, b.content_block_id, b.label, b.created_at
    FROM bookmarks b;
DROP TABLE bookmarks;
ALTER TABLE bookmarks_new RENAME TO bookmarks;

-- The reader looks bookmarks up by paragraph; deleting a book cascades through it too.
CREATE INDEX idx_bookmarks_block ON bookmarks(content_block_id);
