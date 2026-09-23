-- =========================================================================
-- Migration 004 — chunk embeddings for semantic chapter search
-- =========================================================================
-- Chapter text is cut into overlapping chunks and each chunk is embedded
-- as one vector. A chapter's score for a query is its best chunk's, and
-- that chunk's offsets say where in the chapter to open the reader.
--
-- The table exists in every build, whether or not the `semantic` feature
-- is compiled in, so a library moves between builds without a schema
-- difference. Nothing is backfilled: books already in the library have no
-- rows until they are indexed.
--
-- book_id is denormalised beside chapter_id so indexed books can be
-- counted without touching `chapters`. `model` is stored per row so a
-- later model change can be detected rather than silently mixing
-- incompatible vectors. `vec` is `dim` little-endian f32s.
-- =========================================================================

CREATE TABLE chunk_embeddings (
    id          INTEGER PRIMARY KEY,
    chapter_id  INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
    book_id     INTEGER NOT NULL REFERENCES books(id)    ON DELETE CASCADE,
    chunk_idx   INTEGER NOT NULL,   -- chunk order within the chapter
    char_start  INTEGER NOT NULL,   -- offset within the chapter's text, its
    char_end    INTEGER NOT NULL,   -- blocks joined with '\n', in chars
    model       TEXT    NOT NULL,   -- e.g. 'BAAI/bge-small-en-v1.5'
    dim         INTEGER NOT NULL,
    vec         BLOB    NOT NULL,
    UNIQUE (chapter_id, chunk_idx)
);

CREATE INDEX idx_chunk_embeddings_book ON chunk_embeddings(book_id);
