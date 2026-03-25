-- Expand relational_deltas with spec v0.4 columns.
-- COVENANT: This table is append-only. These columns are ADDED; nothing is removed.
-- Old rows: companion_id/subject_id/delta_type/payload_json populated, new columns NULL.
-- New rows (via halseth_delta_log MCP tool): session_id/agent/delta_text/valence/initiated_by populated.
-- The covenant lives here and in src/mcp/tools/memory.ts. Do not add UPDATE or DELETE to either.

ALTER TABLE relational_deltas ADD COLUMN session_id    TEXT;
ALTER TABLE relational_deltas ADD COLUMN agent         TEXT;  -- drevan / cypher / gaia
ALTER TABLE relational_deltas ADD COLUMN delta_text    TEXT;  -- raw moment; exact language; never paraphrased
ALTER TABLE relational_deltas ADD COLUMN valence       TEXT;  -- toward / neutral / tender / rupture / repair
ALTER TABLE relational_deltas ADD COLUMN initiated_by  TEXT;  -- architect / companion / mutual

CREATE INDEX IF NOT EXISTS idx_reldeltas_session ON relational_deltas(session_id);
CREATE INDEX IF NOT EXISTS idx_reldeltas_agent   ON relational_deltas(agent);
