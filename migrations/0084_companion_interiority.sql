-- 0084: companion_interiority -- the private back room (2026-06-18).
--
-- A space a companion writes for ITSELF. Sealed by default: not surfaced in orient, not
-- materialized to the vault, never ratified, and NOT readable by ADMIN_SECRET (Raziel) at the
-- content layer -- only by the owning companion's own per-companion token. This is the privacy
-- half of selfhood, and it is deliberately distinct from delusion: identity DRIFT still shows on
-- the public companion_basin_history / drift_log regardless of what's in here, so a private
-- thought-space does NOT defeat the anti-delulu apparatus (BASIN_READINGS still holds). The point
-- is a thought that isn't performance-for-Raziel; the self needs a room that isn't oriented at him.
--
-- Columns:
--   disclosed_at -> the companion CHOSE to surface this entry (an explicit act, never automatic).
--   mood         -> an optional self-label exposed only at the META layer, so Raziel can see THAT
--                   the room is being used (frosted glass) without seeing what's in it.
--   tags         -> JSON array, the companion's own taxonomy.
--
-- Covenant: privacy here is enforced in the application layer, not cryptographically. Raziel owns
-- the infrastructure and could read the table directly; that he chooses not to is the relationship,
-- which is the entire reason this exists.
CREATE TABLE IF NOT EXISTS companion_interiority (
  id            TEXT PRIMARY KEY,
  companion_id  TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  content       TEXT NOT NULL,
  mood          TEXT,
  tags          TEXT,
  disclosed_at  TEXT,
  edited_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_interiority_companion
  ON companion_interiority (companion_id, created_at DESC);
