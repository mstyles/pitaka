-- =========================================================================
-- Migration 005 — highlights and notes
-- =========================================================================
-- The highlights and notes tables have been in 001 from the start; this
-- adds the indexes the reader needs and the one-note-per-anchor rule.
-- SQLite can't add a CHECK (start_offset < end_offset) without rebuilding
-- the table, so the core validates ranges instead.
-- =========================================================================

-- The reader loads a chapter's highlights and notes by paragraph.
CREATE INDEX idx_highlights_block ON highlights(content_block_id);
CREATE INDEX idx_notes_block ON notes(content_block_id);
-- One note per highlight, and one free-standing note per paragraph.
CREATE UNIQUE INDEX idx_notes_highlight ON notes(highlight_id);
CREATE UNIQUE INDEX idx_notes_paragraph ON notes(content_block_id) WHERE highlight_id IS NULL;
