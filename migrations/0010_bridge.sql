-- Bridge: shared flag on shareable tables + per-category sharing toggles.
-- bridge_sharing rows are the runtime switches — toggle via halseth_bridge_toggle MCP tool.

ALTER TABLE tasks  ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;
ALTER TABLE lists  ADD COLUMN shared INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS bridge_sharing (
  category   TEXT PRIMARY KEY,   -- 'tasks' | 'events' | 'lists'
  enabled    INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);

INSERT OR IGNORE INTO bridge_sharing (category, enabled, updated_at) VALUES ('tasks',  0, datetime('now'));
INSERT OR IGNORE INTO bridge_sharing (category, enabled, updated_at) VALUES ('events', 0, datetime('now'));
INSERT OR IGNORE INTO bridge_sharing (category, enabled, updated_at) VALUES ('lists',  0, datetime('now'));
