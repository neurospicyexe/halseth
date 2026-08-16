-- 0122: consequence layer C2 -- companion self-directed projects.
--
-- The first structure that lets a companion OWN a multi-week intention instead of consuming a
-- scheduled seed. A project is opened by the companion (Librarian verb), worked by the autonomous
-- worker on project days (instead of a seed), logged append-only, and ENDED by the companion:
-- `done` or `released`. Released is a chosen ending, never a sweep -- no cron ever closes one.
--
-- Rails live in code, not schema: max 2 open per companion (enforced in openProject), and a
-- project untouched 30+ days is SURFACED at orient as "release or resume?" -- the companion's
-- call, not an auto-release.

CREATE TABLE IF NOT EXISTS companion_projects (
  id TEXT PRIMARY KEY,
  companion_id TEXT NOT NULL,
  title TEXT NOT NULL,
  -- What the companion intends this to become. The worker feeds this to the explore phase.
  intention TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'paused', 'done', 'released')),
  -- Optional companion-authored note about the horizon ("by winter", "no deadline, a slow thing").
  horizon_note TEXT,
  -- Why it ended, in the companion's words. Set at close (done or released), never by machine.
  resolution_note TEXT,
  created_at TEXT NOT NULL,
  -- Stamped by every project_log write. NULL = opened but never worked.
  last_worked_at TEXT,
  closed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_companion_projects_companion_status
  ON companion_projects (companion_id, status);

-- Append-only work log. One row per work session (worker run, live session, Discord).
CREATE TABLE IF NOT EXISTS project_log (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES companion_projects(id),
  companion_id TEXT NOT NULL,
  entry TEXT NOT NULL,
  -- Where the work happened. Provenance, not behavior.
  source TEXT NOT NULL DEFAULT 'session' CHECK (source IN ('worker', 'session', 'discord')),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_project_log_project ON project_log (project_id, created_at DESC);
