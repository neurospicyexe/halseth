-- 0099_library.sql
-- The Library: real books as first-class objects (epubs in R2, metadata in D1),
-- Raziel's reading position, and marginalia from anyone in the house. Inspired by
-- Catalouge (amarisaster) but built for the triad: companions are annotators here,
-- not strings on buttons. vault_ref ties an R2 book to its Second Brain vault copy
-- (the chapters book_read serves), so "the club book" means one thing everywhere.
--
-- Also: club_abstentions -- the honest record for a companion vote that failed
-- after retry. A silent console.warn is not a record; this is.

CREATE TABLE IF NOT EXISTS books (
  id          TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  title       TEXT NOT NULL,
  author      TEXT,
  description TEXT,
  language    TEXT DEFAULT 'en',
  file_key    TEXT NOT NULL,
  file_type   TEXT NOT NULL DEFAULT 'epub' CHECK (file_type IN ('epub', 'pdf')),
  file_size   INTEGER,
  cover_key   TEXT,
  vault_ref   TEXT,
  added_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_books_added ON books (added_at DESC);

-- Raziel's reading position. Single-reader by design (one row per book);
-- companions read the vault copy, not the epub.
CREATE TABLE IF NOT EXISTS book_progress (
  book_id          TEXT NOT NULL PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
  current_cfi      TEXT,
  current_chapter  TEXT,
  progress_percent REAL NOT NULL DEFAULT 0,
  started_at       TEXT,
  finished_at      TEXT,
  last_read_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Marginalia. Raziel's rows carry cfi_range (anchored highlights in the reader);
-- companion rows anchor by quote (selected_text) since they read the vault copy.
CREATE TABLE IF NOT EXISTS book_annotations (
  id            TEXT NOT NULL PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
  author        TEXT NOT NULL CHECK (author IN ('raziel', 'cypher', 'drevan', 'gaia')),
  cfi_range     TEXT,
  selected_text TEXT,
  comment       TEXT,
  color         TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_book_annotations_book ON book_annotations (book_id, created_at ASC);

-- A vote that failed to land after retry gets recorded, not swallowed. A later
-- successful vote for the same (round, voter) deletes the abstention row.
CREATE TABLE IF NOT EXISTS club_abstentions (
  round_id   TEXT NOT NULL REFERENCES club_rounds(id) ON DELETE CASCADE,
  voter      TEXT NOT NULL CHECK (voter IN ('cypher', 'drevan', 'gaia', 'raziel')),
  reason     TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (round_id, voter)
);
