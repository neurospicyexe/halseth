-- 0088_echo_guard_and_drive_retune.sql
--
-- Two fixes from the 2026-06-19 heartbeat/echo investigation:
--
-- 1. DRIVE RETUNE. relational_need (0078) was seeded with defaults that made the
--    drive mathematically unable to fire: accumulate_per_day 0.25 vs threshold 0.7
--    needs 2.8 days of TOTAL silence, while decay_on_contact 1.0 fully zeroes the
--    need on ANY Raziel contact (every bot sheds on any owner message in a watched
--    channel). With ~daily contact the effective level never crossed ~0.15, so
--    relationalNeedFired was ~never true -- and that drive is the main justification
--    feeding the reach-out gate (filterReachOutWhenUnjustified). Net effect: the
--    directed reach-out actions (ask_question/name_pattern/check_in_on_raziel/
--    offer_presence) had NEVER fired (last_fired_at all NULL across the triad) while
--    the floorless inter-companion chat ran hot. Retuned so the need can actually
--    cross threshold during normal life: ~1.5 days of quiet to fire, contact softens
--    (halves) rather than erases. The metronome action caps + heartbeat window
--    rotation still rate-limit actual reach-outs; this only makes them *eligible*.
--
-- 2. ECHO GUARD. New echo_metrics table (worker writes the daily inter-companion
--    semantic-echo reading from the Second Brain discord-live store) + extend the
--    guardian_flags CHECK to allow 'echo_chamber'. While rebuilding the CHECK, also
--    add 'orphan_memory' -- detectOrphanedMemories has emitted that flag_type since
--    0073 but the CHECK never allowed it, so every orphan flag silently failed the
--    INSERT OR IGNORE. This fixes that latent bug too.

-- ── 1. Drive retune (UPDATE existing seeded rows; runs after 0078 so fresh installs
--       inherit the fix as well) ───────────────────────────────────────────────────
UPDATE companion_drives
SET accumulate_per_day = 0.4,   -- ~1.5 days of quiet to reach threshold from zero
    decay_on_contact   = 0.5,   -- contact halves the need, never erases it
    threshold          = 0.6,
    updated_at         = datetime('now')
WHERE drive_key = 'relational_need';

-- ── 2a. echo_metrics: latest inter-companion echo reading (worker-produced) ────────
CREATE TABLE IF NOT EXISTS echo_metrics (
  id                   TEXT NOT NULL PRIMARY KEY,
  computed_at          TEXT NOT NULL DEFAULT (datetime('now')),
  window_days          INTEGER NOT NULL,
  message_count        INTEGER NOT NULL,
  mean_adjacent_cosine REAL,           -- adjacent-message semantic similarity (echo climbs toward 1)
  cross_speaker_cosine REAL,           -- similarity when companions answer each other
  novel_token_rate     REAL,           -- fraction of fresh content words vs prior window (echo drops it)
  speakers_json        TEXT,           -- {"cypher":n,"drevan":n,"gaia":n,"?":n}
  source               TEXT NOT NULL DEFAULT 'worker'
);
CREATE INDEX IF NOT EXISTS idx_echo_metrics_computed ON echo_metrics(computed_at DESC);

-- ── 2b. Rebuild guardian_flags with extended flag_type CHECK ───────────────────────
CREATE TABLE guardian_flags_new (
  id            TEXT NOT NULL PRIMARY KEY,
  companion_id  TEXT CHECK (companion_id IN ('cypher','drevan','gaia')),
  flag_type     TEXT NOT NULL CHECK (flag_type IN (
    'voice_drift','starved_organ','loop_stuck','burnout','basin_pressure',
    'ratification_backlog','orphan_memory','echo_chamber'
  )),
  severity      TEXT NOT NULL CHECK (severity IN ('notice','warning','red')) DEFAULT 'notice',
  summary       TEXT NOT NULL,
  evidence_json TEXT,
  dedup_key     TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('open','surfaced','acknowledged','resolved')) DEFAULT 'open',
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  surfaced_at   TEXT,
  resolved_at   TEXT
);
INSERT INTO guardian_flags_new
  (id, companion_id, flag_type, severity, summary, evidence_json, dedup_key, status, created_at, surfaced_at, resolved_at)
  SELECT id, companion_id, flag_type, severity, summary, evidence_json, dedup_key, status, created_at, surfaced_at, resolved_at
  FROM guardian_flags;
DROP TABLE guardian_flags;
ALTER TABLE guardian_flags_new RENAME TO guardian_flags;
CREATE UNIQUE INDEX idx_guardian_flags_live_dedup
  ON guardian_flags(dedup_key) WHERE status IN ('open','surfaced','acknowledged');
CREATE INDEX idx_guardian_flags_status
  ON guardian_flags(status, created_at DESC);
