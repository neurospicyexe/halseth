-- migrations/0049_plural_store.sql
-- Halseth as primary plural store: system members, alter notes, fronting log.
-- Replaces SimplyPlural as source of truth (SP shutting down ~June 2026).

CREATE TABLE IF NOT EXISTS system_members (
  id               TEXT PRIMARY KEY,
  name             TEXT NOT NULL,
  pronouns         TEXT,
  role             TEXT,
  age_presentation TEXT,
  description      TEXT,
  affinity         TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_system_members_name ON system_members(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS system_member_notes (
  id         TEXT PRIMARY KEY,
  member_id  TEXT NOT NULL REFERENCES system_members(id),
  note       TEXT NOT NULL,
  source     TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_member_notes_member ON system_member_notes(member_id, created_at DESC);

CREATE TABLE IF NOT EXISTS front_events (
  id            TEXT PRIMARY KEY,
  member_id     TEXT NOT NULL REFERENCES system_members(id),
  status        TEXT NOT NULL CHECK(status IN ('fronting','co-con','unknown')),
  custom_status TEXT,
  session_id    TEXT REFERENCES sessions(id),
  started_at    TEXT NOT NULL DEFAULT (datetime('now')),
  ended_at      TEXT
);

CREATE INDEX IF NOT EXISTS idx_front_events_member ON front_events(member_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_front_events_recent ON front_events(started_at DESC);
