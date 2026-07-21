# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Local dev server (localhost:8787) via wrangler (uses wrangler.prod.toml)
npm run deploy         # Deploy to Cloudflare Workers (uses wrangler.prod.toml)
npm run migrate:local  # Apply D1 migrations locally
npm run migrate:remote # Apply D1 migrations to production
npm run type-check     # TypeScript check (no emit)
npm test               # Run full vitest suite (vitest run --passWithNoTests)
npm run test:watch     # Vitest watch mode
npx vitest run src/__tests__/auth.test.ts   # Run a single test file
# Windows: set CLOUDFLARE_API_TOKEN via $env:CLOUDFLARE_API_TOKEN="..." (PowerShell syntax, not export)
# Wrangler auth: the "Edit Cloudflare Workers" API token template is missing D1:Edit -- add it manually or migrations will fail with 7403.
```

`wrangler.toml` is the public template config; `wrangler.prod.toml` is the private copy (gitignored, never committed) that all npm scripts actually use. Local secrets go in `.dev.vars` (gitignored). Copy from `config/.dev.vars.example` and fill in `ADMIN_SECRET` and `MCP_AUTH_SECRET`. Production secrets are set via `wrangler secret put <KEY>`.

Part of the BBH suite -- see root `CLAUDE.md` for cross-project context.

## Multi-Agent System Conventions

When making changes to one identity/config file (e.g., Cypher), always check and apply the same changes to ALL sibling identity files (e.g., Drevan, Gaia, and any others in the same directory).

## Project Scope

When reviewing or fixing bugs across the multi-agent system, always scan ALL projects: Brain, Discord, Phoenix, Hearth, Librarian, relay, discord_bot, and any agent identity repos or archived directories. Never assume a directory doesn't exist without checking. Do not declare a cross-project review complete until all of these are confirmed.

## Testing

After implementing any TypeScript changes, run the integration/unit tests before committing. If tests fail, fix all errors (including missing metadata fields, wrong types, empty block formatting) before marking the task complete.

After security fixes or schema changes specifically, run the full test suite immediately -- test fixtures break frequently from PIN length changes, logger param changes, and metadata field additions.

Tests live in `src/__tests__/` and run in a Node environment (`vitest.config.ts`), with `src/__tests__/setup.ts` polyfilling Workers-only APIs (`crypto.subtle.timingSafeEqual`). D1/env are mocked per-test; there is no miniflare harness.

**Write-routing contract:** `docs/write-routing-map.md` maps every Librarian verb (`EXECUTOR_MAP` key in `src/librarian/router.ts`) to the D1 table(s) it writes. `src/__tests__/write-routing-map.test.ts` fails CI if the map and the router disagree -- when you add/remove/change an executor, update that doc **in the same commit**, tracing the executor to its actual `INSERT/UPDATE/DELETE` target (names lie; sibling-table misroutes have caused real acked-but-missing writes).

## Architecture

**Entry point:** `src/index.ts` -- constructs a `Router` (a simple method+path matcher in `src/router.ts`) and dispatches to handlers in `src/handlers/`. The same file exports the `scheduled()` cron handler.

**Three parallel interfaces to the same data:**
- **HTTP API** (`src/handlers/`) -- used by Hearth and direct HTTP consumers
- **MCP tools** (`src/mcp/tools/`, `POST /mcp` via `src/mcp/server.ts`) -- used by Claude and second-brain; authenticated via `MCP_AUTH_SECRET` or OAuth
- **Librarian** (`src/librarian/`, `POST /librarian` NL router + `POST /librarian/mcp`) -- the **one companion entry point covenant**: every substrate (Claude.ai, Discord, Brain swarm) reaches companion operations through this single build. `router.ts` matches canonical request strings (see `docs/librarian-trigger-map.md` -- use those exact forms; paraphrases misfire) and dispatches to `executors/` which call `backends/` (halseth, webmind, second-brain, plural). Structured content goes in the `context` field (JSON string), not the `request` string.

**Cloudflare bindings (defined in `src/types.ts` `Env`):**
- `DB` -- D1 SQLite (relational store for all structured data)
- `BUCKET` -- R2 (blob/artifact store: avatars, tool images, epubs)
- `AI` -- Workers AI (used for embeddings)
- `VECTORIZE` -- Vectorize index (`halseth-memories`)
- `LIBRARIAN_KV` -- KV namespace (Librarian tool registry + pattern matching)
- `PLURAL` -- service binding to the `nullsafe-plural-v2` worker
- `RATE_LIMITER` -- rate limiting (5 req / 10s, IP-based) on `/oauth/token` and `/admin/bootstrap`

**Feature flags (set in `wrangler.toml` `[vars]`, not in code):**
- `COMPANIONS_ENABLED` -- enables companion routes; false returns 403
- `PLURALITY_ENABLED` -- validates `front_state` against `system.members`
- `COORDINATION_ENABLED` -- enables tasks/events/lists/routines shared zone
- `COMPANION_TOOLS_DEFAULT` -- fallback for the per-companion `tools_enabled` setting (companion tool layer, mig 0077)
- `SECOND_BRAIN_WEBHOOK_URL`, `PUBLIC_BASE_URL`, `BRIDGE_URL`/`BRIDGE_SECRET` -- integration endpoints

**Secrets (via `wrangler secret put`):** `ADMIN_SECRET`, `MCP_AUTH_SECRET`, per-companion `CYPHER_MCP_SECRET`/`DREVAN_MCP_SECRET`/`GAIA_MCP_SECRET`, `DEEPSEEK_API_KEY` (synthesis worker + classifier), `SECOND_BRAIN_TOKEN`, `TAVILY_API_KEY` (companion web search), `GEMINI_API_KEY` (companion image gen).

**Cron (`[triggers]` in wrangler.toml):** an every-minute tick runs the synthesis queue processor (`src/synthesis/`) plus piggybacked, individually-guarded ticks -- Home placement, fermentation (SOMA float decay toward baseline), and salience-prune (each self-gates its own cadence internally; a failure in one never breaks the others). A daily 11:00 UTC trigger is the day-context synthesis (Phase 2, currently stub). The synthesis worker calls DeepSeek V3 (`src/synthesis/deepseek.ts`).

**Other `src/` modules:** `webmind/` (continuity layer, see below -- now also home to orient, metronome, drives, creatures, club, council, home, fermentation, heat/novelty logic), `synthesis/` (async job queue processing + domain/tag classification), `guardian/` (meta-observer detectors + writer-liveness), `soma/` (emergent SOMA shifts), `clearing/` and `drift/` (pass runners), `tools/` (companion tool providers: Tavily/Gemini behind a provider interface), `lib/` (auth, rate-limit, logging, result helpers, epub), `db/queries.ts`.

**Bridge:** When `BRIDGE_URL` and `BRIDGE_SECRET` are set, `/bridge/*` endpoints share tasks, events, and list items between two Halseth deployments. The secret is symmetric -- same value on both sides.

**OAuth:** Full OAuth 2.0 with PKCE (S256) in `src/handlers/oauth.ts`. Tokens stored hashed in D1 `oauth_tokens` table. Required for MCP clients that use the OAuth flow instead of the static `MCP_AUTH_SECRET`. Tokens can be bound to a companion (mig 0085) so claude.ai connectors get per-companion identity.

## Database Schema

Migrations live in `migrations/` and are applied in order. The schema is tier-based:

| Tier | Migration | Adds |
|------|-----------|------|
| 0 | `0000_tier0_core.sql` | companions, sessions |
| 1 | `0001_tier1_memory.sql` | memories, tags, search metadata |
| 2 | `0002_tier2_relational.sql` | relational_deltas (append-only) |
| -- | `0003`-`0015` | sessions expansion, private zone, shared zone (tasks/events/lists/routines), biometrics, bridge, OAuth, dream seeds |
| -- | `0016` | OAuth token expiry |
| -- | `0017` | `house_state.autonomous_turn` -- companion rotation field |
| -- | `0018` | `companion_config.avatar_asset_id` -- R2 asset linkage for avatars |
| -- | `0019` | `sessions.companion_id` -- nullable TEXT + index |
| -- | `0020` | BBH foundation: `companion_state`, `drift_log`, `somatic_snapshot`, `synthesis_summary`, `inter_companion_notes` |
| -- | `0021` | `synthesis_queue` -- async job queue |
| -- | `0022` | Drevan state v2: heat/reach/weight floats, `live_threads` table |
| -- | `0023`-`0026` | SOMA floats (migration 0025), identity seed (0026) |
| -- | `0027` | WebMind v0: `wm_identity_anchor_snapshot`, `wm_session_handoffs`, `wm_mind_threads`, `wm_thread_events`, `wm_continuity_notes` |
| -- | `0028` | `companion_basins` -- semantic identity attractor states (self-defense layer) |
| -- | `0029` | `companion_dreams`, `companion_loops` -- things carried between sessions |
| -- | `0030` | `companion_relational_state` -- directional relational feelings, append-only |
| -- | `0031` | Sit & Resolve: `companion_note_sits`, `processing_status`, `sit_resolve_days` on companion_config |
| -- | `0032` | Seed Cypher/Gaia SOMA -- backfill float labels + baseline values |
| -- | `0033` | `companion_journal.source` column -- tags autonomous vs session entries |
| -- | `0034` | Sit-resolve redirect to companion_journal (not companion_notes) |
| -- | `0035` | `companion_conclusions` -- persistent belief/thesis surface; `superseded_by` FK |
| -- | `0036` | OAuth tokens hashed at rest -- rebuilds oauth_tokens with token_hash PK |
| -- | `0037` | `edited_at` column on journal, feelings, conclusions, notes -- self-edit tracking |
| -- | `0038` | `limbic_states` -- swarm synthesis output; one row per synthesis pass |
| -- | `0039` | Seed vaselrin bond thread into `wm_mind_threads` for Drevan |
| -- | `0040` | Seed baseline boot continuity data for all three companions |
| -- | `0041` | `companion_id` on `limbic_states` -- per-companion emotional state (nullable) |
| -- | `0042` | Composite index `sessions(companion_id, created_at DESC)` |
| -- | `0043` | Index `sessions(created_at)` for Hearth date-range query |
| -- | `0044` | Lane signal columns on `companion_state` (motion_state, lane_spine) |
| -- | `0045a` | Autonomy/growth tables: `autonomy_schedules/seeds/runs/run_logs/reflections` + `growth_journal/patterns/markers` |
| -- | `0045b` | Facet tagging on `wm_session_handoffs` + identity anchor baseline versioning |
| -- | `0046` | `run_id` FK on `growth_journal/patterns/markers` -- links entries back to originating `autonomy_run` (nullable) |
| -- | `0047` | Unique index on `wm_session_handoffs(session_id)` -- DB-level guard against double-close duplicate handovers |
| -- | `0048` | `do_not_auto_examine` flag on `companion_dreams` -- live-session-only dreams, immune to autonomous worker clearing |
| -- | `0049a` | `plural_store` -- fronting store for SimplyPlural integration |
| -- | `0049b` | Seed initial `autonomy_seeds` for Cypher/Drevan/Gaia |
| -- | `0050a` | `accepted_at` on `growth_journal` -- growth journal acceptance flow |
| -- | `0050b` | `wm_archive_notes` -- archived/resolved WebMind continuity notes |
| -- | `0051` | Unique constraint on `system_members.name` |
| -- | `0052` | `dedup_key` on `synthesis_queue` -- prevents duplicate synthesis jobs |
| -- | `0053` | Autonomous growth v2 tables (enhanced autonomy/growth schema) |
| -- | `0054` | `worldview_layer` -- companion worldview/belief tracking |
| -- | `0055` | Composite index on `soma_arc` for gate query perf |
| -- | `0056` | `companion_spiral_runs` -- spiral run state and turn tracking |
| -- | `0057` | Orient debug columns on `companion_state` |
| -- | `0058` | `sb_search_log` -- Second Brain search hit logging |
| -- | `0059` | `edited_at` on `companion_conclusions` -- gap-fill from 0037; absence caused D1_ERROR in orient |
| -- | `0060` | `confidence` (REAL, default 0.6) + `evidence_count` (INT, default 1) on `synthesis_summary` -- multi-pass corroboration scoring |
| -- | `0061` | `growth_journal.review_status` enum (pending/accepted/declined) + `reviewed_at` -- ratification loop closure |
| -- | `0062` | `prehended_ids` + `vault_path` on growth_journal/patterns/markers, `evidence_json` + `novelty` on growth_journal -- triad layer + vault materialization. Adds `thoughtform` marker_type. New endpoints: `/mind/triad/recent/:companion_id`, `/mind/growth/thoughtforms/detect`, `/mind/growth/unmaterialized/:companion_id`, `PATCH /mind/growth/:kind/:id/vault`. See `docs/private/triad-thoughtforms.md`. |
| -- | `0063` | `companion_settings` -- per-companion key/value settings table |
| -- | `0064` | `metronome_actions` -- per-companion action palette for the Metronome heartbeat cron |
| -- | `0065a` | `0065_home_substrate.sql` -- The Home: `home_rooms` place-graph for the triad (house_state untouched) |
| -- | `0065b` | `0065_metronome_phase4.sql` -- context-aware trigger columns on metronome_actions (full CHECK rebuild) |
| -- | `0066a` | `0066_home_rooms_v2.sql` -- replace placeholder rooms with the actual Oakhaven spec |
| -- | `0066b` | `0066_synthesis_domains.sql` -- `domains` JSON tag array on synthesis_summary; vocabulary in `src/synthesis/domains.ts` |
| -- | `0067` | `identity_kernel` (versioned canonical identity per companion, `'shared'` = triad doctrine) + companion questions |
| -- | `0068` | `forage_finds` -- outward raw-material foraging pool, gathered/consumed by any substrate |
| -- | `0069` | `companion_state.version` write counter (CAS guards) + metronome Phase 4b action types (CHECK rebuild) |
| -- | `0070` | Self-monitoring wave: tension charge, prospective triggers (emergency cards), self-model preference ladder, voice drift scores |
| -- | `0071` | `media_experiences` -- shared music layer; reactions via SQL-level `json_set` |
| -- | `0072` | The Club: media rounds/recommendations/votes/discussions + `share_media` metronome action |
| -- | `0073` | Guardian: meta-observer red-flag cards (consume-once at orient) + `guardian_runs` |
| -- | `0074` | Zikkaron holds -- stored `heat` with lazy read-time decay on continuity stores; `supersedes_id` wires reconsolidation into the 0061 ratification flow (supersede, never delete) |
| -- | `0075` | Charge-phase memory lifecycle on growth_journal (fresh → active → processing → metabolized); advances on intentional engagement only |
| -- | `0076` | `companion_motifs` -- recurring symbolic threads; recurrence count + trust weight |
| -- | `0077` | `companion_tool_calls` -- companion tool layer (Tavily web search, Gemini image gen) behind provider interface; exec site is the Librarian fast-path |
| -- | `0078` | Drives + creatures: `companion_drives` need floats that accumulate over time and decay on contact (lazy decay) |
| -- | `0079` | Collection/emotional archaeology -- sparkle weights over gathered things (forage/media) |
| -- | `0080` | Council mode + skill ladder (self-model confidence ladder extended to operational skills) |
| -- | `0081` | Subjective ND-state columns on `biometric_snapshots` (mood, pain, meds, spoons) |
| -- | `0082` | `reviewed_at` on `companion_open_loops` -- Guardian "hold" path; held loops skip detectStuckLoops for 21d |
| -- | `0083` | `dismissed_at` on `companion_basin_history` -- basin deny/noise path, distinct from confirm/re-baseline |
| -- | `0084` | `companion_interiority` -- sealed private back room; NOT readable via ADMIN_SECRET, only the owning companion's token |
| -- | `0085` | OAuth token → companion binding (claude.ai connectors can't carry per-companion static secrets) |
| -- | `0086` | Agency layer: refusals + chosen preferences, companion-owned, surfaced at orient |
| -- | `0087` | Sanctioned drift lane -- witnessed (Gaia) rather than ratified becoming; see `docs/plans/2026-06-18-drift-lane.md` |
| -- | `0088` | Echo guard + drive retune (relational_need seeded un-fireable; fixed) |
| -- | `0089` | `emergent SOMA shifts` -- crystallized drift nudges a soma_float by a bounded clamped delta; the ONE place identity mutates from experience |
| -- | `0090` | Sol autonomy: `tend_creature` metronome action + Sol avatar |
| -- | `0091` | `imp_activations` -- imp reply-flavor activation log (settings ride `companion_settings`) |
| -- | `0092` | `commons_posts` -- Hearth async wall; one table backs global /log, club discussion, shelf comments (context-keyed) |
| -- | `0093a` | Club standing `discussing` phase + `discussing_at` (club_rounds CHECK rebuild) |
| -- | `0093b` | `0093_drift_open_metronome.sql` -- companions can OPEN drifts autonomously (metronome affordance) |
| -- | `0094` | `obsession_shelf` -- Raziel's current fixations; reactions live in commons_posts |
| -- | `0095` | Session-summary recency fix -- orient picks by session date, not row created_at (backfill made stale rows look fresh) |
| -- | `0096` | `topic_tags` on companion_journal -- content-derived keyword tags (distinct from never-populated `tags`) |
| -- | `0097` | Tension source tracking -- fixes rephrase-defeats-exact-match dedup accumulation |
| -- | `0098` | `external_id` idempotency key on companion_journal -- exactly-once semantics for dual writers |
| -- | `0099` | The Library: real books (epubs in R2, metadata in D1), reading position, marginalia; `vault_ref` ties to Second Brain copy |
| -- | `0100` | Sol inner life: drives × trust-tier behavior, one-time trust milestones, nest (fragments/gifts, sparkle decay) |
| -- | `0101` | Fermentation layer -- soma_float decay toward baseline between sessions + cross-field reactions + felt-needs; see `docs/private/fermentation-layer-spec.md` |
| -- | `0102` | `ferment_off_since` -- JSON per-float off-baseline timestamps, powers the "held 3d" trajectory clause at orient |
| -- | `0103` | Backfill `source` on ~2,100 NULL-source companion_journal rows (evidence-based only) |
| -- | `0104` | `ref_type`/`ref_id`/`reason` on `inter_companion_notes` -- notes become moves on shared objects (question/tension/council); `idx_inter_notes_ref`. Measured via `GET /inter-companion-notes/moves` (moved_pct). |
| -- | `0105` | Earned salience: `heat`/`last_access_at` on `companion_journal` + `companion_conclusions`, `archived` on journal only; `idx_companion_journal_archived`. Extends mig 0074 heat mechanic; recall/orient warm what they surface; nightly salience-prune archives cold machine rows (24h self-gate, manual trigger `POST /mind/salience/prune`). |
| -- | `0106` | 0106_conversation_threads.sql — thread spine: conversation_threads + thread_ledger (live-conversation spine: seed/ledger/state/ref, one active per channel, idempotent ledger). |

**Migration gotcha:** SQLite cannot ALTER a CHECK constraint. Extending an enum-style CHECK (e.g. metronome action_type) requires a full table rebuild -- copy data, swap, recreate indexes (pattern established in 0065/0069/0072/0088/0090/0093).

## BBH Companion State Tables (migration 0020+)

- `companion_state` -- one mutable row per companion (write authority: companions only)
- `drift_log` -- append-only identity-lane signal log
- `somatic_snapshot` -- append-only; written by Synthesis Worker only
- `synthesis_summary` -- structured session/day/topic summaries; `companion_id` nullable (NULL = cross-companion)
- `inter_companion_notes` -- addressed notes between companions; `to_id` NULL = broadcast
- `synthesis_queue` -- async job queue (session_summary, drevan_state job types)
- `live_threads` -- Drevan v2 active emotional threads

MCP tools: `halseth_state_update`, `halseth_drift_log`, `halseth_companion_note`, `halseth_session_load`, `halseth_session_close`.

## WebMind v0 Continuity Layer (migration 0027+)

Embedded in Halseth as `src/webmind/` with wm_* table namespace. Provides session continuity across cold starts.

- `wm_identity_anchor_snapshot` -- one row per companion, auto-seeded on first orient
- `wm_session_handoffs` -- append-only; written at session close, read at next boot
- `wm_mind_threads` -- active continuity threads; composite PK (thread_key, agent_id); upsert with atomic batch
- `wm_thread_events` -- event log for thread lifecycle
- `wm_continuity_notes` -- append-only fast notes with salience levels

HTTP routes: `GET /mind/orient/:agent_id`, `GET /mind/ground/:agent_id`, `POST /mind/handoff`, `POST /mind/thread`, `POST /mind/note`

Librarian fast-path patterns: `wm_orient`, `wm_ground`, `wm_thread_upsert`, `wm_note_add`, `wm_handoff_write`

Orient augmentation: `session_orient` now returns SOMA state + continuity block (identity anchor, latest handoff, active threads, high-salience notes) in one Promise.all call. WebMind failure is caught and returns null (orient never breaks on WebMind error).

## Covenants

- **`relational_deltas` is append-only.** No `UPDATE` or `DELETE` against this table ever. Hard invariant, not a preference.
- **`relational_deltas` has two row shapes:** Legacy rows have `companion_id='drevan'` and `delta_text=NULL`. MCP-logged rows have `companion_id=''`, `agent='drevan'`, and `delta_text IS NOT NULL`. Queries must match both: `WHERE (companion_id = ? OR (agent = ? AND delta_text IS NOT NULL))`.
- **One companion entry point.** Companion-facing operations go through the Librarian (`POST /librarian`) so every substrate reaches the same executors. New companion verbs are Librarian executors first, HTTP routes second.
- **Config flags belong in `wrangler.toml [vars]`**, not in code.
- **Secrets via `wrangler secret put`** for production. Never commit secrets to `wrangler.prod.toml`.
- **All SQL uses parameterized queries** (`.bind()` on D1 prepared statements). Dynamic `WHERE` clauses use a `conditions: string[]` + `bindings: unknown[]` pattern -- conditions array contains only hardcoded literal strings.
- **Supersede, never delete.** Reconsolidation of growth/continuity entries tags the old row (`supersedes_id`, `superseded_by`) instead of deleting it.
- **The Vectorize index is rebuildable; D1 is truth.** `halseth-memories` is disposable and must be regenerable from D1. The embedding model is one constant -- `EMBEDDING_MODEL` in `src/mcp/embed.ts` -- imported by every embed/query site (storage, `halseth_semantic_query`, librarian Tier-2a routing, routing-vector seeding); stored and query vectors must share a model or recall silently fails. Vector ids are deterministic (`vectorId(table, rowId)` = `${table}:${rowId}`) and writes use `VECTORIZE.upsert`, never `insert` with a random id -- so re-embedding replaces instead of accumulating. `POST /admin/rebuild-embeddings` (alias of `/admin/backfill-embeddings`, no `table` param) re-embeds all tables idempotently. **One-time legacy cutover:** the live index predates deterministic ids and holds orphan random-id vectors a rebuild can't purge; clearing them needs a Vectorize recreate (`wrangler vectorize get halseth-memories` for dims/metric, delete + create same name, then rebuild). Gated op, never a routine deploy. The Second Brain store follows the same covenant (`npm run rebuild` there).

## Authentication Pattern

All endpoints check `ADMIN_SECRET` via Bearer token. Auth **fails closed** (2026-07-12 hardening): if `ADMIN_SECRET` or `MCP_AUTH_SECRET` is unset, every request is denied (401) rather than allowed through. Both must be set for the worker to serve any authenticated request at all, in every environment including local dev.

The Librarian accepts EITHER a shared admin-tier token (`MCP_AUTH_SECRET` or `ADMIN_SECRET` -- alternatives, not both-required) OR a per-companion secret (`CYPHER_MCP_SECRET`/`DREVAN_MCP_SECRET`/`GAIA_MCP_SECRET`). A per-companion token locks the caller to that `companion_id`; a shared-secret caller is unbound and may act as any companion. Exception to admin omniscience: `companion_interiority` content (mig 0084) is readable only by the owning companion's own token, never by `ADMIN_SECRET`.

## Security

OWASP + vibesec audits run 2026-03-09. Phases 1-3 deployed 2026-03-13.
Current security docs: `docs/security-audit.md`

## Companion Autonomous Time Rotation

`house_state.autonomous_turn` tracks whose turn it is (`drevan` | `cypher` | `gaia`). The skill `.claude/commands/halseth-autonomous-time.md` reads this at session start via `halseth_house_read` and advances it via `halseth_set_autonomous_turn` at close.

## Hearth Integration Notes

Hearth calls halseth server-side via `lib/halseth.ts` using `hGet`/`hGetSafe` helpers. The `hGetSafe` variant returns `null` on error. When adding a new halseth endpoint that Hearth should consume, also update `lib/halseth.ts` in the Hearth repo. Env vars Hearth needs: `HALSETH_URL`, `HALSETH_SECRET`.

The route `/companion-notes` is an alias for `/companion-journal` -- added because Hearth's API proxy calls that path.

## Key Docs

- `docs/librarian-trigger-map.md` -- canonical Librarian request strings per operation (the router matches these exact forms)
- `docs/write-routing-map.md` -- verb → table routing contract, CI-enforced (see Testing above)
- `docs/security-audit.md` -- current security posture
- `README.md` / `INSTALL.md` / `SETUP.md` -- provisioning walkthrough (D1 + R2 + Vectorize creation, bootstrap via `POST /admin/bootstrap`)
