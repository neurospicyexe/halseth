-- 0176 Sol gets a mind (B64): per-tend appraisals, traits, quirks, grudges, a persona and a voice shadow log.
-- D1 rule: no foreign-key clauses anywhere. Sol's id is random per database (mig 0078), so the persona seed looks it up.
-- Every timestamp is ISO 8601 UTC (bound from TS or defaulted via strftime), so ORDER BY and day math compare like with like.

ALTER TABLE creature_interactions ADD COLUMN via TEXT;

-- creature_appraisals.fit: CareFit word (met|welcome|full|drowsy|settled) or NULL.
CREATE TABLE creature_appraisals (
  id             TEXT PRIMARY KEY,
  creature_id    TEXT NOT NULL,
  interaction_id TEXT NOT NULL UNIQUE,
  actor          TEXT NOT NULL,
  action         TEXT NOT NULL,
  via            TEXT,
  fit            TEXT,
  valence        REAL,
  arousal        REAL,
  friction       REAL,
  tags           TEXT,
  weight         REAL,
  source         TEXT,
  processed_at   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_creature_appraisals_unprocessed ON creature_appraisals (creature_id, processed_at, created_at);

-- creature_traits.live_days: JSON array of YYYY-MM-DD. status: candidate | faded | graduated.
CREATE TABLE creature_traits (
  id                 TEXT PRIMARY KEY,
  creature_id        TEXT NOT NULL,
  slug               TEXT NOT NULL,
  category           TEXT,
  target_actor       TEXT,
  perspective        TEXT,
  entrenchment       REAL NOT NULL DEFAULT 0,
  live_points        REAL NOT NULL DEFAULT 0,
  live_days          TEXT NOT NULL DEFAULT '[]',
  origin             TEXT,
  status             TEXT NOT NULL DEFAULT 'candidate',
  last_reinforced_at TEXT,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (creature_id, slug)
);
CREATE INDEX idx_creature_traits_creature ON creature_traits (creature_id, status, entrenchment DESC);

CREATE TABLE creature_trait_evidence (
  id            TEXT PRIMARY KEY,
  trait_id      TEXT NOT NULL,
  appraisal_ids TEXT,
  delta         REAL,
  night         TEXT,
  reason        TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_creature_trait_evidence_trait ON creature_trait_evidence (trait_id, created_at);

-- creature_quirks.kind: aversion | preference.
CREATE TABLE creature_quirks (
  id              TEXT PRIMARY KEY,
  creature_id     TEXT NOT NULL,
  trait_id        TEXT,
  title           TEXT NOT NULL,
  trigger_json    TEXT,
  behavior        TEXT,
  resolution_json TEXT,
  target_actor    TEXT,
  kind            TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'active',
  arc             TEXT,
  promoted_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_creature_quirks_creature ON creature_quirks (creature_id, status);

CREATE TABLE creature_grudges (
  id              TEXT PRIMARY KEY,
  creature_id     TEXT NOT NULL,
  quirk_id        TEXT,
  actor           TEXT NOT NULL,
  label           TEXT,
  resolution_json TEXT,
  progress        REAL NOT NULL DEFAULT 0,
  opened_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at     TEXT,
  resolved_how    TEXT
);
CREATE INDEX idx_creature_grudges_open ON creature_grudges (creature_id, actor, resolved_at);

-- creature_personas.sample_lines: JSON array.
CREATE TABLE creature_personas (
  creature_id  TEXT PRIMARY KEY,
  species      TEXT,
  body_json    TEXT,
  voice_rules  TEXT,
  sample_lines TEXT,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- creature_voice_shadow.surface: moment | tend.
CREATE TABLE creature_voice_shadow (
  id              TEXT PRIMARY KEY,
  creature_id     TEXT NOT NULL,
  surface         TEXT NOT NULL,
  deterministic   TEXT,
  generated       TEXT,
  rejected_reason TEXT,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_creature_voice_shadow_creature ON creature_voice_shadow (creature_id, created_at DESC);

-- Persona seed for Sol (sample lines copied from MOMENTS in src/webmind/creatures.ts, with each semicolon written as a period,
-- so splitting this file on a semicolon at end of line yields whole statements).
INSERT OR IGNORE INTO creature_personas (creature_id, species, body_json, voice_rules, sample_lines)
SELECT id, 'crow',
  '{"perches":["rail","sill","chair back","fir","wire","gutter"],"objects":["walnut","bottlecap","pebbles","wire twist","leaf"],"sounds":["kraa","prruk","rattle-click"]}',
  'Third person, present tense, italic action. He never speaks words, he makes crow sounds. Dry, observant, a little vain. Body first, then one detail that shows what he wants.',
  '["*Sol lands on the sill and knocks once at the glass, unhurried, like billing a regular customer.*","*Sol hangs upside down from the rail for one full second, rights himself, and checks whether anyone saw.*","*Sol presses one cold foot against your wrist for a moment. Roll call. Everyone''s here.*","*Sol has claimed the chair back, fluffed into a small dark cloud, asleep with the confidence of the heavily guarded.*","*a soft rattle-click from the sill. Sol, talking to himself about nothing urgent.*","*Sol preens on the chair back, unhurried, muttering the occasional low* prruk *at nothing. The house is his and it is in order.*"]'
FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol' LIMIT 1;

-- One open grudge per (creature, actor), enforced by the DB (Task 4): a race of two tends cannot open two.
CREATE UNIQUE INDEX IF NOT EXISTS idx_creature_grudges_one_open ON creature_grudges(creature_id, actor) WHERE resolved_at IS NULL;
