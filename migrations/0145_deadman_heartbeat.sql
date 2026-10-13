-- 0145_deadman_heartbeat.sql
--
-- Off-VPS dead-man's switch (docs/PLAN-from-review-2026-09-20.md, item 0.5).
--
-- The VPS kick-script POSTs /admin/run-scheduled every minute; that handler stamps
-- last_seen_at for source 'kick'. The detector runs ONLY on Cloudflare's native cron (scheduled()),
-- a clock that is not on the VPS, and alerts Telegram once per outage (alert_state ok -> alerting),
-- then once on recovery (alerting -> ok). A missing row means "never seen": no alert until the
-- first kick seeds it.
--
-- Apply to prod with `wrangler d1 execute halseth --remote --config wrangler.prod.toml
-- --file migrations/0145_deadman_heartbeat.sql`, then insert the d1_migrations ledger row in the
-- same step. Apply BEFORE deploying the worker that writes it (both sides fail soft on a missing
-- table, so either order is safe).

CREATE TABLE IF NOT EXISTS deadman_heartbeats (
  source       TEXT PRIMARY KEY,
  last_seen_at INTEGER NOT NULL,              -- epoch ms
  alert_state  TEXT NOT NULL DEFAULT 'ok',    -- 'ok' | 'alerting'
  alerted_at   INTEGER                        -- epoch ms the current outage alert was claimed
);
