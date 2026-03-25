-- relational_deltas was created in 0002 with companion_id TEXT NOT NULL REFERENCES companions(id).
-- MCP rows (halseth_delta_log) use '' as a placeholder per the covenant note in 0004,
-- but D1 now enforces FK constraints, causing FOREIGN KEY constraint failed errors.
-- Fix: same pattern as 0003 did for sessions — recreate without the legacy NOT NULL FK.

CREATE TABLE IF NOT EXISTS relational_deltas_new (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT,           -- nullable, FK removed — legacy column; MCP rows use '' placeholder
  subject_id    TEXT    NOT NULL,
  delta_type    TEXT    NOT NULL,
  payload_json  TEXT    NOT NULL,
  created_at    TEXT    NOT NULL,
  session_id    TEXT,
  agent         TEXT,
  delta_text    TEXT,
  valence       TEXT,
  initiated_by  TEXT,
  vector_id     TEXT
);

INSERT INTO relational_deltas_new
  SELECT id, companion_id, subject_id, delta_type, payload_json, created_at,
         session_id, agent, delta_text, valence, initiated_by, vector_id
  FROM relational_deltas;

DROP TABLE relational_deltas;
ALTER TABLE relational_deltas_new RENAME TO relational_deltas;

CREATE INDEX IF NOT EXISTS idx_reldeltas_companion         ON relational_deltas(companion_id);
CREATE INDEX IF NOT EXISTS idx_reldeltas_companion_subject ON relational_deltas(companion_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_reldeltas_subject_type      ON relational_deltas(subject_id, delta_type);
CREATE INDEX IF NOT EXISTS idx_reldeltas_session           ON relational_deltas(session_id);
CREATE INDEX IF NOT EXISTS idx_reldeltas_agent             ON relational_deltas(agent);
