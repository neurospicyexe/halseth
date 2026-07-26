-- 0106: thread spine — durable conversation threads for live surfaces (Discord commons,
-- Raziel dialogue; later Claude.ai/Layer B). A thread = seed + ledger + state + optional
-- shared-object ref (mig 0104 convention). One ACTIVE thread per channel (partial unique
-- index). Ledger appends are idempotent per Discord message (three bot processes witness
-- the same message; INSERT OR IGNORE + unique (thread_id, message_id)).
CREATE TABLE IF NOT EXISTS conversation_threads (
  id              TEXT PRIMARY KEY,
  channel_id      TEXT NOT NULL,
  surface         TEXT NOT NULL DEFAULT 'discord',
  seed_text       TEXT NOT NULL,
  seed_author     TEXT NOT NULL,
  seed_message_id TEXT,
  ref_type        TEXT CHECK (ref_type IN ('question','tension','council')),
  ref_id          TEXT,
  ref_label       TEXT,
  participants    TEXT NOT NULL DEFAULT '[]',
  state           TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open','moving','landed','faded')),
  resolution      TEXT,
  landed_by       TEXT,
  landed_at       TEXT,
  turn_count      INTEGER NOT NULL DEFAULT 0,
  last_turn_at    TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_one_active
  ON conversation_threads(channel_id) WHERE state IN ('open','moving');
CREATE INDEX IF NOT EXISTS idx_conversations_state
  ON conversation_threads(state, last_turn_at DESC);

CREATE TABLE IF NOT EXISTS thread_ledger (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES conversation_threads(id),
  author     TEXT NOT NULL,
  gist       TEXT NOT NULL,
  message_id TEXT,
  said_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_ledger ON thread_ledger(thread_id, said_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_thread_ledger_msg
  ON thread_ledger(thread_id, message_id) WHERE message_id IS NOT NULL;
