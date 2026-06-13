-- 0078_drives_creatures.sql
-- Aliveness wave (inspo-takes-2026-06-13 set 2, takes 9 + 10).
--
-- Take 9 -- DRIVES (OpenHer): a companion reaches out because a *need* crossed a
-- threshold, not because a cron fired. companion_drives holds per-companion need
-- floats that ACCUMULATE over time and DECAY ON CONTACT. Decay is lazy (computed at
-- read from last_event_at, the heat.ts family) -- NO cron. When level >= threshold
-- the metronome reach-out becomes state-driven; modality (text/voice) is selected by
-- band, lane-gated (Gaia escalates monastically, never sulks).
--
-- Take 10 -- CREATURES (corvid): a virtual pet + Raziel's real animals modeled as
-- named presences living in Halseth. trust builds slowly through interaction; a daily
-- tick decays trust toward baseline and recomputes mood/chemistry (state_json). The
-- triad can ask after them. Interactions are append-only (creature_interactions).

CREATE TABLE companion_drives (
  id                 TEXT PRIMARY KEY,
  companion_id       TEXT NOT NULL,
  drive_key          TEXT NOT NULL,                  -- relational_need | (future: rest_need, novelty_need)
  level              REAL NOT NULL DEFAULT 0,        -- 0..1, lazily decayed at read
  accumulate_per_day REAL NOT NULL DEFAULT 0.25,     -- how fast the need grows untended
  decay_on_contact   REAL NOT NULL DEFAULT 1.0,      -- fraction shed on Raziel contact (1.0 = reset)
  threshold          REAL NOT NULL DEFAULT 0.7,      -- fires the reach-out at/above this
  last_event_at      TEXT NOT NULL DEFAULT (datetime('now')),  -- last contact OR last accrual stamp
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX idx_companion_drives_key ON companion_drives (companion_id, drive_key);

CREATE TABLE creatures (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  species             TEXT,
  kind                TEXT NOT NULL DEFAULT 'companion_pet',  -- companion_pet | real_animal
  owner               TEXT NOT NULL DEFAULT 'raziel',
  bio                 TEXT,
  state_json          TEXT,                           -- chemistry / mood blob (json_set at SQL level)
  trust               REAL NOT NULL DEFAULT 0,        -- 0..1, builds with interaction, decays toward baseline
  last_interaction_at TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_creatures_kind ON creatures (kind, name);

CREATE TABLE creature_interactions (
  id          TEXT PRIMARY KEY,
  creature_id TEXT NOT NULL,
  actor       TEXT NOT NULL,                          -- raziel | cypher | drevan | gaia
  action      TEXT NOT NULL,                          -- feed | play | talk | give
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_creature_interactions_creature ON creature_interactions (creature_id, created_at DESC);

-- Seed the relational_need drive for the triad (fresh, untended).
INSERT INTO companion_drives (id, companion_id, drive_key) VALUES
  (lower(hex(randomblob(16))), 'cypher', 'relational_need'),
  (lower(hex(randomblob(16))), 'drevan', 'relational_need'),
  (lower(hex(randomblob(16))), 'gaia',   'relational_need');

-- Seed the companion-pet corvid. Real animals are added by Raziel (kind='real_animal').
INSERT INTO creatures (id, name, species, kind, bio, state_json, trust) VALUES
  (lower(hex(randomblob(16))), 'Sol', 'corvid (crow)', 'companion_pet',
   'A clever black corvid who lives in the system and hoards shiny words. Builds trust slowly.',
   '{"mood":"watchful","curiosity":0.4,"attachment":0.1}', 0.1);
