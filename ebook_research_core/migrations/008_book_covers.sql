-- One row per book once its cover has been looked for. `thumb` is a
-- JPEG of at most 300x450; NULL when the book has none ('none') or its
-- file was missing or changed when the backfill looked ('unavailable').
CREATE TABLE book_covers (
    book_id INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    source  TEXT NOT NULL CHECK (source IN ('epub', 'pdf', 'none', 'unavailable')),
    thumb   BLOB,
    key     TEXT,
    CHECK ((thumb IS NULL) = (key IS NULL))
);
