-- Migration 0057: Add orient debug snapshot column to companion_state.
-- Written by execSessionOrient after assembling the full orient payload.
-- Read by GET /mind/orient-debug/:agent_id → Hearth /orient page.
ALTER TABLE companion_state ADD COLUMN last_orient_debug TEXT;
