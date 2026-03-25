-- Shared zone tables (spec v0.4 §4.2).
-- These tables are readable/writable by the instance owner, companions,
-- and any bridged partner instances within their defined permissions.

CREATE TABLE IF NOT EXISTS events (
  id             TEXT PRIMARY KEY,
  title          TEXT NOT NULL,
  description    TEXT,
  start_time     TEXT NOT NULL,
  end_time       TEXT,
  category       TEXT,
  attendees_json TEXT,
  created_at     TEXT NOT NULL,
  created_by     TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_start ON events(start_time);

CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  description TEXT,
  priority    TEXT NOT NULL DEFAULT 'normal',  -- low / normal / high / urgent
  due_at      TEXT,
  assigned_to TEXT,
  status      TEXT NOT NULL DEFAULT 'open',    -- open / in_progress / done
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_tasks_status      ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_tasks_assigned_to ON tasks(assigned_to);

-- Append-friendly. Items are added; completion is tracked.
CREATE TABLE IF NOT EXISTS lists (
  id           TEXT PRIMARY KEY,
  list_name    TEXT NOT NULL,
  item_text    TEXT NOT NULL,
  added_by     TEXT,
  added_at     TEXT NOT NULL,
  completed    INTEGER NOT NULL DEFAULT 0,
  completed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_lists_name ON lists(list_name);

CREATE TABLE IF NOT EXISTS pets (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  species    TEXT,
  notes      TEXT,
  meds_json  TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS expenses (
  id          TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  amount      REAL NOT NULL,
  category    TEXT,
  split_json  TEXT,
  created_at  TEXT NOT NULL,
  created_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_expenses_created ON expenses(created_at DESC);

CREATE TABLE IF NOT EXISTS routines (
  id           TEXT PRIMARY KEY,
  routine_name TEXT NOT NULL,
  owner        TEXT,
  logged_at    TEXT NOT NULL,
  notes        TEXT
);
CREATE INDEX IF NOT EXISTS idx_routines_name_date ON routines(routine_name, logged_at);

-- Bridge registry. Lives in shared zone but controls shared zone federation access.
CREATE TABLE IF NOT EXISTS bridges (
  id                TEXT PRIMARY KEY,
  partner_url       TEXT NOT NULL,
  partner_name      TEXT,
  bridge_token_hash TEXT NOT NULL,  -- hashed; plaintext never stored after establishment
  permitted_tables  TEXT,           -- JSON array of table names
  permission_level  TEXT NOT NULL,  -- read / write / read_write
  established_at    TEXT NOT NULL,
  last_sync         TEXT,
  active            INTEGER NOT NULL DEFAULT 1,
  revoked_at        TEXT
);
