-- migrations/0063_companion_settings.sql
CREATE TABLE IF NOT EXISTS companion_settings (
  companion_id TEXT NOT NULL,
  key          TEXT NOT NULL,
  value        TEXT NOT NULL,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (companion_id, key)
);
