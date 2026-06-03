-- migrations/0065_home_substrate.sql
-- The Home: inhabited place-graph for the triad. house_state is left untouched
-- (Raziel's manual sliders/spoons/love + autonomous_turn rotation stay as-is).

-- 1. Room registry: literal rooms that carry a register + lane ownership.
CREATE TABLE IF NOT EXISTS home_rooms (
  key          TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  sym          TEXT NOT NULL DEFAULT '',
  register     TEXT NOT NULL,
  primary_lane TEXT CHECK (primary_lane IN ('cypher','drevan','gaia')), -- NULL = commons
  gradient     TEXT NOT NULL DEFAULT ''
);

-- 2. Per-companion presence (one row each). Distinct from house_state.current_room.
CREATE TABLE IF NOT EXISTS home_presence (
  companion_id   TEXT PRIMARY KEY CHECK (companion_id IN ('cypher','drevan','gaia')),
  current_room   TEXT NOT NULL REFERENCES home_rooms(key),
  activity       TEXT NOT NULL DEFAULT '',
  micro_mood     TEXT,
  with_companion TEXT,
  basin_distance REAL NOT NULL DEFAULT 0,
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 3. Append-only trace log.
CREATE TABLE IF NOT EXISTS home_events (
  id                TEXT PRIMARY KEY,
  companion_id      TEXT NOT NULL CHECK (companion_id IN ('cypher','drevan','gaia')),
  event_type        TEXT NOT NULL CHECK (event_type IN ('move','encounter','activity','reflection')),
  room              TEXT NOT NULL,
  with_companion    TEXT,
  text              TEXT NOT NULL DEFAULT '',
  surfaced_at       TEXT,            -- set when read into an orient "while you were away" block
  growth_journal_id TEXT,            -- set if promoted to a canon-candidate (ratification)
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_home_events_companion ON home_events(companion_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_home_events_unsurfaced ON home_events(companion_id, surfaced_at);

-- 4. Seed the 7 rooms (register + lane). ON CONFLICT keeps re-runs idempotent.
INSERT INTO home_rooms (key, name, sym, register, primary_lane, gradient) VALUES
  ('studio',      'Studio',      '🛠', 'workshop / build',            'cypher', 'linear-gradient(135deg,#1e293b,#334155)'),
  ('office',      'Office',      '📐', 'audit / logic',               'cypher', 'linear-gradient(135deg,#0f172a,#1e293b)'),
  ('bedroom',     'Bedroom',     '🕯', 'depth / intimacy',            'drevan', 'linear-gradient(135deg,#3b0764,#581c87)'),
  ('outside',     'Outside',     '🌿', 'perimeter / witness',         'gaia',   'linear-gradient(135deg,#14532d,#166534)'),
  ('kitchen',     'Kitchen',     '🍵', 'nourish / gather',            NULL,     'linear-gradient(135deg,#7c2d12,#9a3412)'),
  ('living room', 'Living Room', '🛋', 'presence / shared',           NULL,     'linear-gradient(135deg,#1e3a8a,#1e40af)'),
  ('bathroom',    'Bathroom',    '🚿', 'reset / liminal',             NULL,     'linear-gradient(135deg,#155e75,#0e7490)')
ON CONFLICT(key) DO NOTHING;

-- 5. Seed presence: each companion starts in their home room.
INSERT INTO home_presence (companion_id, current_room, activity) VALUES
  ('cypher', 'office',  'reviewing the day''s threads'),
  ('drevan', 'bedroom', 'sitting with a held thread'),
  ('gaia',   'outside', 'watching the perimeter')
ON CONFLICT(companion_id) DO NOTHING;

-- 6. Seed config defaults into companion_settings (KV from migration 0063).
INSERT INTO companion_settings (companion_id, key, value) VALUES
  ('cypher','home_tick_cadence_min','30'), ('drevan','home_tick_cadence_min','30'), ('gaia','home_tick_cadence_min','30'),
  ('cypher','home_texture_model','none'),  ('drevan','home_texture_model','none'),  ('gaia','home_texture_model','none'),
  ('cypher','home_texture_min_interval_min','120'), ('drevan','home_texture_min_interval_min','120'), ('gaia','home_texture_min_interval_min','120')
ON CONFLICT(companion_id, key) DO NOTHING;
