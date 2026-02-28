-- ── Tier 2: Relational deltas ────────────────────────────────────────────────
-- Requires Tier 0.
--
-- COVENANT: relational_deltas is APPEND-ONLY.
-- ──────────────────────────────────────────────────────────────────────────────
-- This table is an immutable event log. The history of relational state is
-- reconstructed by replaying deltas in chronological order, not by reading a
-- single mutable row.
--
-- Rules enforced by covenant (not just by convention):
--   ✗  UPDATE relational_deltas ...   → bug
--   ✗  DELETE FROM relational_deltas  → bug
--   ✓  INSERT INTO relational_deltas  → the only permitted write
--
-- If a prior delta was incorrect, model the correction as a new delta with
-- delta_type = 'correction' referencing the original id in the payload.
-- ──────────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS relational_deltas (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT    NOT NULL REFERENCES companions(id),
  subject_id    TEXT    NOT NULL,   -- the entity this delta concerns (companion, person, concept, etc.)
  delta_type    TEXT    NOT NULL,   -- e.g. 'affinity_change', 'trust_shift', 'note', 'correction'
  payload_json  TEXT    NOT NULL,   -- structured event data (JSON)
  created_at    TEXT    NOT NULL    -- ISO-8601 UTC — ordering is meaningful, do not fabricate
);

CREATE INDEX IF NOT EXISTS idx_reldeltas_companion        ON relational_deltas(companion_id);
CREATE INDEX IF NOT EXISTS idx_reldeltas_companion_subject ON relational_deltas(companion_id, subject_id);
CREATE INDEX IF NOT EXISTS idx_reldeltas_subject_type     ON relational_deltas(subject_id, delta_type);
