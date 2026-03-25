-- 0027_webmind_v0.sql
-- WebMind v0 continuity layer schema.
-- Five tables: identity snapshot, session handoffs, active threads, thread events, recovery notes.
-- All use wm_ prefix. Append-only design for durability and audit trail.

-- wm_identity_anchor_snapshot: latest identity + constraints for each agent
CREATE TABLE IF NOT EXISTS wm_identity_anchor_snapshot (
  agent_id                TEXT PRIMARY KEY,
  identity_version_hash   TEXT NOT NULL,
  anchor_summary          TEXT NOT NULL,
  constraints_summary     TEXT,
  updated_at              TEXT NOT NULL,
  source                  TEXT NOT NULL DEFAULT 'system'
);

-- wm_session_handoffs: append-only continuity checkpoints
CREATE TABLE IF NOT EXISTS wm_session_handoffs (
  handoff_id      TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  thread_id       TEXT,
  title           TEXT NOT NULL,
  summary         TEXT NOT NULL,
  next_steps      TEXT,
  open_loops      TEXT,
  state_hint      TEXT,
  actor           TEXT NOT NULL DEFAULT 'agent',
  source          TEXT NOT NULL DEFAULT 'system',
  correlation_id  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_handoffs_agent ON wm_session_handoffs(agent_id, created_at DESC);

-- wm_mind_threads: active continuity threads
CREATE TABLE IF NOT EXISTS wm_mind_threads (
  thread_key          TEXT NOT NULL,
  agent_id            TEXT NOT NULL,
  title               TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open',
  priority            INTEGER NOT NULL DEFAULT 0,
  lane                TEXT,
  context             TEXT,
  do_not_archive      INTEGER NOT NULL DEFAULT 0,
  do_not_resolve      INTEGER NOT NULL DEFAULT 0,
  actor               TEXT NOT NULL DEFAULT 'agent',
  source              TEXT NOT NULL DEFAULT 'system',
  correlation_id      TEXT,
  last_touched_at     TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  status_changed      TEXT,
  created_at          TEXT NOT NULL,
  PRIMARY KEY (thread_key, agent_id)
);

CREATE INDEX IF NOT EXISTS idx_wm_threads_agent_status ON wm_mind_threads(agent_id, status, priority DESC, last_touched_at DESC);

-- wm_thread_events: event log for mind threads
CREATE TABLE IF NOT EXISTS wm_thread_events (
  event_id        TEXT PRIMARY KEY,
  thread_key      TEXT NOT NULL,
  agent_id        TEXT NOT NULL,
  event_type      TEXT NOT NULL,
  content         TEXT,
  actor           TEXT NOT NULL DEFAULT 'agent',
  source          TEXT NOT NULL DEFAULT 'system',
  correlation_id  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_thread_events_thread ON wm_thread_events(thread_key, agent_id, created_at DESC);

-- wm_continuity_notes: fast append-only recovery notes
CREATE TABLE IF NOT EXISTS wm_continuity_notes (
  note_id         TEXT PRIMARY KEY,
  agent_id        TEXT NOT NULL,
  thread_key      TEXT,
  note_type       TEXT NOT NULL DEFAULT 'continuity',
  content         TEXT NOT NULL,
  salience        TEXT NOT NULL DEFAULT 'normal',
  actor           TEXT NOT NULL DEFAULT 'agent',
  source          TEXT NOT NULL DEFAULT 'system',
  correlation_id  TEXT,
  created_at      TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_wm_notes_agent ON wm_continuity_notes(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_wm_notes_salience ON wm_continuity_notes(agent_id, salience, created_at DESC);
