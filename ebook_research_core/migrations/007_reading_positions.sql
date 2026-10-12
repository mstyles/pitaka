-- =========================================================================
-- Migration 007 — where each book was left
-- =========================================================================
-- One row per book that has been opened: the paragraph at the top of the
-- reader when it was last left, so the book reopens there. `finished`
-- says that paragraph was at the end of the book, which takes the book
-- out of Home's Continue reading. Nothing to backfill: no position was
-- recorded before this.
-- =========================================================================

CREATE TABLE reading_positions (
    book_id          INTEGER PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
    content_block_id INTEGER NOT NULL REFERENCES content_blocks(id) ON DELETE CASCADE,
    finished         INTEGER NOT NULL DEFAULT 0,
    read_at          TEXT NOT NULL
);
