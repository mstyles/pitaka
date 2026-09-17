-- =========================================================================
-- Migration 002 — search indexes
-- =========================================================================
-- 1. Rebuild content_fts with `remove_diacritics 2`. The default (1) leaves
--    letters carrying more than one diacritic (e.g. ṝ) unfolded; 2 folds
--    them too, so a plain-ASCII query matches regardless.
-- 2. Add content_fts_exact: same text, no porter stemmer, for "exact words"
--    search ("learning" no longer matches "learn"). Case and diacritics are
--    still folded.
-- Both are external-content tables over content_blocks and are rebuilt from
-- it here, so existing libraries don't need re-importing.
-- =========================================================================

DROP TRIGGER content_blocks_ai;
DROP TRIGGER content_blocks_ad;
DROP TRIGGER content_blocks_au;
DROP TABLE content_fts;

CREATE VIRTUAL TABLE content_fts USING fts5(
    text,
    content='content_blocks',
    content_rowid='id',
    tokenize='porter unicode61 remove_diacritics 2'
);

CREATE VIRTUAL TABLE content_fts_exact USING fts5(
    text,
    content='content_blocks',
    content_rowid='id',
    tokenize='unicode61 remove_diacritics 2'
);

INSERT INTO content_fts(content_fts) VALUES ('rebuild');
INSERT INTO content_fts_exact(content_fts_exact) VALUES ('rebuild');

-- Triggers to keep both FTS indexes in sync with content_blocks.
CREATE TRIGGER content_blocks_ai AFTER INSERT ON content_blocks BEGIN
    INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
    INSERT INTO content_fts_exact(rowid, text) VALUES (new.id, new.text);
END;

CREATE TRIGGER content_blocks_ad AFTER DELETE ON content_blocks BEGIN
    INSERT INTO content_fts(content_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO content_fts_exact(content_fts_exact, rowid, text) VALUES ('delete', old.id, old.text);
END;

CREATE TRIGGER content_blocks_au AFTER UPDATE ON content_blocks BEGIN
    INSERT INTO content_fts(content_fts, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO content_fts_exact(content_fts_exact, rowid, text) VALUES ('delete', old.id, old.text);
    INSERT INTO content_fts(rowid, text) VALUES (new.id, new.text);
    INSERT INTO content_fts_exact(rowid, text) VALUES (new.id, new.text);
END;
