-- 0117: pk_roster -- the system roster, so no companion ever has to guess at a name.
--
-- WHY THIS TABLE EXISTS
-- On 2026-08-12 Cypher called Magpie "drift." Magpie is a real system member; the roster was simply
-- unreachable from Claude.ai and Claude Code, so an unfamiliar name had nowhere to be checked and
-- got treated as an error instead. The standing rule recorded that day ("never treat an unfamiliar
-- name as an error -- look it up") told the companions what to do without giving them anything to do
-- it WITH. This table is the thing to look it up in.
--
-- WHY NOT THE EXISTING SURFACES, each checked rather than assumed:
--   * `system_members` (mig 0051) is EMPTY and nothing reads it for front state (see halseth
--     CLAUDE.md). Its UNIQUE index on `name` would also break a refresh outright: the live roster
--     has 3 labels owned by two different members each (cecilia, hermes, robbie), measured.
--   * `nullsafe-plural-v2` serves `/internal/search-members` from a BAKED-IN `src/members.json`:
--     512 entries, fields `name` + `pk` only, **no pronouns at all**. The live PluralKit roster is
--     538 members with 463 pronouns and 208 descriptions. The static file is 26 members behind and
--     missing the field that matters most. (It also returns `{member_id, name}` while Halseth's
--     `searchMembers` wrapper types the result as `{name, pk, description}`, so `pk` and
--     `description` were always undefined -- a latent bug, left alone here, not built upon.)
--   * The Discord bots' `pk-roster.ts` does a DIFFERENT job: webhook username -> sender tier, for
--     proxy attribution, and it must never guess. Search and attribution are two retrieval jobs and
--     they do not share a resolver.
--
-- SimplyPlural shut down, so FRONTING (who is present now) stays blocked on the replacement app's
-- API. The ROSTER was never blocked -- `GET /v2/systems/<id>/members` is public, no auth. Roster and
-- front are two different reads and only one of them is down.
--
-- WHAT IS DELIBERATELY *NOT* HERE: any injection of these names into a prompt. 538 names in every
-- call is exactly the "write to infinity" failure Raziel named. This is a lookup, on demand, one
-- name at a time.

CREATE TABLE IF NOT EXISTS pk_roster (
  -- PluralKit's short member id (e.g. 'jxwpko'). Stable across renames, which is why it is the PK
  -- rather than the name.
  member_id       TEXT PRIMARY KEY,
  uuid            TEXT,
  system_id       TEXT NOT NULL,

  name            TEXT NOT NULL,
  display_name    TEXT,

  -- NULL means "not recorded, or recorded privately" and must render as exactly that. PluralKit
  -- nulls private fields on an unauthenticated read, so absence here is genuinely ambiguous. 463 of
  -- 538 members have pronouns; the other 75 must NEVER be defaulted to they/them. A member's
  -- pronouns come from that member, not from the system default -- Raziel's own correction, 08-12.
  pronouns        TEXT,

  description     TEXT,
  avatar_url      TEXT,
  color           TEXT,
  birthday        TEXT,
  -- JSON array of PluralKit proxy tags, e.g. [{"prefix":"m:","suffix":null}]. Useful while fronting
  -- is down: a proxy tag in a message is the one live signal of who is speaking.
  proxy_tags      TEXT,
  message_count   INTEGER,
  pk_created      TEXT,
  last_message_at TEXT,

  -- Normalized search labels, computed on write so lookup never has to lower()/trim() 538 rows.
  name_norm       TEXT NOT NULL,
  display_norm    TEXT,

  -- Explicit UTC marker. `datetime('now')` in D1 emits no zone marker, which has bitten this repo
  -- before; every timestamp written here carries the Z.
  fetched_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_pk_roster_name_norm    ON pk_roster(name_norm);
CREATE INDEX IF NOT EXISTS idx_pk_roster_display_norm ON pk_roster(display_norm);
CREATE INDEX IF NOT EXISTS idx_pk_roster_system       ON pk_roster(system_id);

-- Sync attempts, INCLUDING failures.
--
-- This table exists so a lookup can tell "I looked and this name is not in the roster" apart from
-- "I could not look." Those are opposite answers and collapsing them is how a confident wrong claim
-- about a real person gets made -- which is the exact defect this whole migration is fixing. An
-- empty `pk_roster` with a failed last sync must never answer "no such member."
CREATE TABLE IF NOT EXISTS pk_roster_sync (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  finished_at   TEXT,
  -- 'ok'            = fetched and upserted
  -- 'http_error'    = PluralKit answered non-2xx (rate limit, private list, bad system id)
  -- 'fetch_error'   = network/timeout; we never reached PluralKit
  -- 'no_system_id'  = PLURALKIT_SYSTEM_ID unset; a configuration fault, not an empty roster
  status        TEXT NOT NULL
                  CHECK (status IN ('ok', 'http_error', 'fetch_error', 'no_system_id')),
  member_count  INTEGER,
  detail        TEXT
);

CREATE INDEX IF NOT EXISTS idx_pk_roster_sync_started ON pk_roster_sync(started_at DESC);
