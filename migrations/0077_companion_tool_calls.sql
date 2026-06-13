-- 0077_companion_tool_calls.sql
-- Companion tool layer (sanctuary / SuperAGI reference; inspo-takes-2026-06-13 take 14).
-- A companion can, on intent, (a) web-search for current info and (b) generate an image.
-- Exec site is the Librarian fast-path -> a halseth executor (the one companion entry
-- point covenant), so every substrate -- Claude.ai, Discord, Brain swarm -- reaches it
-- through one build. Providers (Tavily web search, Gemini image gen) live behind a
-- mockable interface; keys are deploy-time secrets.
--
-- This table is the deterministic AUDIT LOG: every invocation is logged here with its
-- companion, tool, a short args summary, status, and a result reference. Instrument,
-- not judge -- same spirit as Guardian (0073). It doubles as the source for the Hearth
-- gallery (generate_image rows carry the R2 key in result_ref) and prevents a narrated
-- tool-call from ever faking success (the deterministic-ack covenant): if there is no
-- row, the tool did not run.
--
--   status: success  -- provider returned, result stored/returned
--           error    -- provider or storage failed (result_summary carries the reason)
--           denied   -- tools_enabled gate was off for this companion
--
-- The per-companion gate is a companion_settings row (key='tools_enabled', value='true'),
-- mirroring active_model / autonomous_program -- no new gate table needed. Absence of the
-- row falls back to the COMPANION_TOOLS_DEFAULT env flag (see src/tools/providers.ts).

CREATE TABLE companion_tool_calls (
  id             TEXT PRIMARY KEY,
  companion_id   TEXT NOT NULL,
  tool           TEXT NOT NULL,                 -- web_search | generate_image
  args_summary   TEXT NOT NULL,                 -- short human-facing summary of the input
  status         TEXT NOT NULL,                 -- success | error | denied
  provider       TEXT,                          -- tavily | gemini | mock | null
  result_ref     TEXT,                          -- R2 key (image) or null
  result_summary TEXT,                          -- "5 results" / error reason / null
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Per-companion call history (audit read + Hearth list), newest first.
CREATE INDEX idx_tool_calls_companion ON companion_tool_calls (companion_id, created_at DESC);
-- Gallery query: a companion's generated images, newest first.
CREATE INDEX idx_tool_calls_tool ON companion_tool_calls (companion_id, tool, created_at DESC);
