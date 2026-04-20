-- Migration 0054: Worldview layer -- upgrade companion_conclusions to full belief system
-- Five additive columns (nullable or defaulted). No existing rows break, no existing queries break.

ALTER TABLE companion_conclusions ADD COLUMN confidence REAL NOT NULL DEFAULT 0.7;
ALTER TABLE companion_conclusions ADD COLUMN belief_type TEXT NOT NULL DEFAULT 'self';
ALTER TABLE companion_conclusions ADD COLUMN subject TEXT;
ALTER TABLE companion_conclusions ADD COLUMN provenance TEXT;
ALTER TABLE companion_conclusions ADD COLUMN contradiction_flagged INTEGER NOT NULL DEFAULT 0;

CREATE INDEX idx_companion_conclusions_type
  ON companion_conclusions(companion_id, belief_type, superseded_by);
