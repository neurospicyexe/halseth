-- 0128: D1 read diet. Cloudflare enforces the free-tier limit of 5M rows read/day from
-- 2026-09-01; measured usage on 2026-08-30 was 41.2M rows read/day (writes fine: 38k of 100k).
-- Every index below targets a measured top-25 row-read query from d1QueriesAdaptiveGroups.
-- Additive only -- no data changes. Companion query rewrites land in the same change
-- (narrative-refresh.ts, owner-activity.ts, pk-roster.ts).

-- 14.4M rows/day, 12.4k calls: soma freshness gate. somatic_snapshot had NO secondary index.
CREATE INDEX IF NOT EXISTS idx_somatic_snapshot_companion_created
  ON somatic_snapshot(companion_id, created_at);

-- 7.4M rows/day: the per-minute TTL delete scanned every 'done' row on every tick.
CREATE INDEX IF NOT EXISTS idx_synthesis_queue_done_ttl
  ON synthesis_queue(status, processed_at);

-- 5.2M rows/day: home_events TTL delete filters bare created_at; existing indexes lead on companion_id.
CREATE INDEX IF NOT EXISTS idx_home_events_created
  ON home_events(created_at);

-- 5.0M rows/day: unread inter-companion notes. to_id/from_id had no index at all, and the
-- read-check subquery could only seek by companion (scanning all of that reader's read marks).
CREATE INDEX IF NOT EXISTS idx_inter_notes_to_created
  ON inter_companion_notes(to_id, created_at);
CREATE INDEX IF NOT EXISTS idx_inter_notes_from_created
  ON inter_companion_notes(from_id, created_at);
CREATE INDEX IF NOT EXISTS idx_icn_reads_note_companion
  ON inter_companion_note_reads(note_id, companion_id);

-- 3.8M rows/day: narrative freshness gate. Split pair so MAX(COALESCE(session_created_at,
-- created_at)) can be answered as MAX of two single index seeks (rewrite in narrative-refresh.ts).
CREATE INDEX IF NOT EXISTS idx_synth_summary_session_ts
  ON synthesis_summary(companion_id, summary_type, session_created_at)
  WHERE session_created_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_synth_summary_created_ts
  ON synthesis_summary(companion_id, summary_type, created_at)
  WHERE session_created_at IS NULL;

-- 3.4M rows/day: owner-activity last-seen UNION -- each branch MAX becomes an index seek.
-- (biometric_snapshots was indexed on recorded_at while the query reads logged_at.)
CREATE INDEX IF NOT EXISTS idx_sessions_surface_created ON sessions(surface, created_at);
CREATE INDEX IF NOT EXISTS idx_commons_posts_author_created ON commons_posts(author, created_at);
CREATE INDEX IF NOT EXISTS idx_biometrics_logged ON biometric_snapshots(logged_at);
CREATE INDEX IF NOT EXISTS idx_companion_notes_author_created ON companion_notes(author, created_at);

-- 3.3M rows/day, 484 calls at ~6.7k rows each: gaia_witness recency read had no created_at index.
CREATE INDEX IF NOT EXISTS idx_gaia_witness_created ON gaia_witness(created_at);

-- 2.4M rows/day: pk_roster freshness gate (MAX(fetched_at) seek; COUNT(*) becomes EXISTS in code).
CREATE INDEX IF NOT EXISTS idx_pk_roster_fetched ON pk_roster(fetched_at);

-- 2.3M rows/day: latest known front state. Partial index matches the query predicate exactly.
CREATE INDEX IF NOT EXISTS idx_sessions_front_recent
  ON sessions(created_at)
  WHERE front_state IS NOT NULL AND front_state NOT IN ('', 'unknown');

-- 1.1M rows/day: companion_journal MAX(created_at) per agent (existing indexes are single-column).
CREATE INDEX IF NOT EXISTS idx_companion_journal_agent_created
  ON companion_journal(agent, created_at);

-- 0.8M rows/day: open pressure flags -- partial index matches the standing predicate.
CREATE INDEX IF NOT EXISTS idx_basin_pressure_open
  ON companion_basin_history(companion_id, recorded_at)
  WHERE drift_type = 'pressure' AND caleth_confirmed = 0 AND dismissed_at IS NULL;

-- 0.4M rows/day: feelings recency per companion (existing indexes are two single-column ones).
CREATE INDEX IF NOT EXISTS idx_feelings_companion_created
  ON feelings(companion_id, created_at);
