-- =========================================================================
-- Migration 006 — which books an indexing run finished
-- =========================================================================
-- A row means an indexing run with `model` went through every chapter of
-- the book. Chunk rows alone can't say that: a run cut short leaves some,
-- and a book whose chapters are all front matter never gets any.
--
-- The backfill marks every book that already has chunk rows as finished,
-- for each model they were made with. It can't tell a run that was cut
-- short from one that finished, so those books count as done, as they did
-- before this migration.
-- =========================================================================

CREATE TABLE book_embeddings (
    book_id     INTEGER NOT NULL REFERENCES books(id) ON DELETE CASCADE,
    model       TEXT    NOT NULL,
    indexed_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (book_id, model)
);

INSERT INTO book_embeddings (book_id, model)
SELECT DISTINCT book_id, model FROM chunk_embeddings;
