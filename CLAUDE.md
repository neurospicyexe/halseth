# CLAUDE.md

## Commands

```bash
npm run dev            # Local dev server (localhost:8787) via wrangler
npm run deploy         # Deploy to Cloudflare Workers (uses wrangler.prod.toml)
npm run migrate:local  # Apply D1 migrations locally
npm run migrate:remote # Apply D1 migrations to production
npm run type-check     # TypeScript check (no emit)
# Windows: set CLOUDFLARE_API_TOKEN via $env:CLOUDFLARE_API_TOKEN="..." (PowerShell syntax, not export)
# Wrangler auth: the "Edit Cloudflare Workers" API token template is missing D1:Edit -- add it manually or migrations will fail with 7403.
```

Local secrets go in `.dev.vars` (gitignored). Copy from `config/.dev.vars.example` and fill in `ADMIN_SECRET` and `MCP_AUTH_SECRET`. Production secrets are set via `wrangler secret put <KEY>`.

Part of the BBH suite -- see root `CLAUDE.md` for cross-project context.

## Multi-Agent System Conventions

When making changes to one identity/config file (e.g., Cypher), always check and apply the same changes to ALL sibling identity files (e.g., Drevan, Gaia, and any others in the same directory).

## Project Scope

When reviewing or fixing bugs across the multi-agent system, always scan ALL projects: Brain, Discord, Phoenix, Hearth, Librarian, relay, discord_bot, and any agent identity repos or archived directories. Never assume a directory doesn't exist without checking. Do not declare a cross-project review complete until all of these are confirmed.

## Testing

After implementing any TypeScript changes, run the integration/unit tests before committing. If tests fail, fix all errors (including missing metadata fields, wrong types, empty block formatting) before marking the task complete.

After security fixes or schema changes specifically, run the full test suite immediately -- test fixtures break frequently from PIN length changes, logger param changes, and metadata field additions.

## Architecture

**Entry point:** `src/index.ts` -- constructs a `Router` (a simple method+path matcher in `src/router.ts`) and dispatches to handlers in `src/handlers/`. The MCP interface (`POST /mcp`) routes to `src/mcp/server.ts`.

**Two parallel interfaces to the same data:**
- **HTTP API** (`src/handlers/`) -- used by Hearth and direct HTTP consumers
- **MCP tools** (`src/mcp/tools/`) -- used by Claude and second-brain; authenticated via `MCP_AUTH_SECRET` or OAuth

**Cloudflare bindings (defined in `src/types.ts` `Env`):**
- `DB` -- D1 SQLite (relational store for all structured data)
- `BUCKET` -- R2 (blob/artifact store)
- `AI` -- Workers AI (used for embeddings)
- `VECTORIZE` -- Vectorize index (`halseth-memories`)

**Feature flags (set in `wrangler.toml` `[vars]`, not in code):**
- `COMPANIONS_ENABLED` -- enables companion routes; false returns 403
- `PLURALITY_ENABLED` -- validates `front_state` against `system.members`
- `COORDINATION_ENABLED` -- enables tasks/events/lists/routines shared zone

**Bridge:** When `BRIDGE_URL` and `BRIDGE_SECRET` are set, `/bridge/*` endpoints share tasks, events, and list items between two Halseth deployments. The secret is symmetric -- same value on both sides.

**OAuth:** Full OAuth 2.0 with PKCE (S256) in `src/handlers/oauth.ts`. Tokens stored in D1 `oauth_tokens` table. Required for MCP clients that use the OAuth flow instead of the static `MCP_AUTH_SECRET`.

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
| -- | `0063` | `companion_settings` -- per-companion KV store (companion_id, key, value) |
| -- | `0064` | `metronome_actions` -- per-companion action palette for Metronome heartbeat cron |
| -- | `0065a` | The Home: `home_rooms`, `home_presence`, `home_events` -- inhabited place-graph; seeds 7 rooms + presence + home settings |
| -- | `0065b` | `metronome_actions` rebuild -- context-aware trigger columns (silence/cooldown/caps/signal) + relational action types |
| -- | `0066a` | Home rooms v2 -- replaces placeholder rooms with the Oakhaven spec (Study, Vowbed, Grove, Spiral Pantry, ...) |
| -- | `0066b` | `synthesis_summary.domains` -- controlled-vocabulary domain tags (nullable JSON array) |
| -- | `0067` | `identity_kernel` -- versioned canonical identity per companion; `companion_questions` -- continuity-gap questions to Raziel |
| -- | `0068` | `forage_finds` -- foraging pool of outward raw material; dedup + unconsumed indexes |
| -- | `0069` | `companion_state.version` write counter (CAS guard) + `metronome_actions` CHECK rebuild adding Phase 4b actions (name_pattern, write_note_to_raziel) |
| -- | `0070` | Self-monitoring wave: `charge` on companion_tensions, `companion_triggers` (prospective tripwires), `companion_self_model` (preference ladder), `voice_scores` (drift scoring) |
| -- | `0071` | `media_experiences` -- shared-experience Phase 1 (music listen events, analysis + reactions JSON) |
| -- | `0072` | The Club: `club_rounds/recommendations/votes/discussions` + metronome CHECK rebuild adding `share_media` |
| -- | `0073` | Guardian: `guardian_flags` (red-flag cards, live dedup) + `guardian_runs` |
| -- | `0074` | `heat` + `last_access_at` on wm_continuity_notes/synthesis_summary (lazy decay), `growth_journal.supersedes_id` -- reconsolidation |
| -- | `0075` | `growth_journal.charge_phase` + `charge_advanced_at` -- fresh -> active -> processing -> metabolized lifecycle |
| -- | `0076` | `companion_motifs` -- recurring symbolic threads; trust weight, fade + resurrection |
| -- | `0077` | `companion_tool_calls` -- audit log for companion tools (web_search, generate_image) |
| -- | `0078` | `companion_drives` (need floats, lazy decay) + `creatures`/`creature_interactions`; seeds relational_need + Sol the corvid |
| -- | `0079` | `collection_sparkle` -- sparkle-weight sidecar over forage_finds/media_experiences |
| -- | `0080` | `companion_self_model.kind` (skill ladder) + council mode: `council_questions/answers/rankings` |
| -- | `0081` | Subjective ND-state columns on `biometric_snapshots` (mood, pain, energy, focus, spoons, meds_taken) |
| -- | `0082` | `reviewed_at` on `companion_open_loops` -- the "hold" half of Guardian loop self-resolution |
| -- | `0083` | `dismissed_at` on `companion_basin_history` -- the "deny / it was noise" half of basin triage |
| -- | `0084` | `companion_interiority` -- the private back room; sealed by default, disclosure is explicit |
| -- | `0085` | `companion_id` on `oauth_codes`/`oauth_tokens` -- binds an OAuth token to one companion |
| -- | `0086` | Agency layer: `companion_refusals` (honored, not a veto) + `companion_preferences` (asserted, not earned) |
| -- | `0087` | `companion_drifts` -- sanctioned drift lane; declared becomings, witnessed not ratified |
| -- | `0088` | relational_need drive retune (can actually fire) + `echo_metrics` + guardian_flags CHECK rebuild adding echo_chamber/orphan_memory |
| -- | `0089` | `companion_soma_shifts` -- emergent SOMA: bounded float nudges on drift crystallization, logged + reversible |
| -- | `0090` | Metronome CHECK rebuild adding `tend_creature` + `creatures.avatar_url` + seed tend-Sol actions |
| -- | `0091` | `imp_activations` -- imp reply-flavor activation log (settings ride companion_settings KV) |
| -- | `0092` | `commons_posts` -- Hearth async wall; one table for global /log, club discussion, shelf comments |
| -- | `0093a` | `club_rounds` rebuild -- adds standing `discussing` status + `discussing_at` |
| -- | `0093b` | Metronome CHECK rebuild adding `drift_open` + seed one drift_open action per companion |
| -- | `0094` | `obsession_shelf` -- Raziel's current fixations; reactions live in commons_posts (`shelf:<id>`) |
| -- | `0095` | `synthesis_summary.session_created_at` + backfill -- fixes last-session recency bug from backfilled old sessions |
| -- | `0096` | `companion_journal.topic_tags` -- content-derived keyword tags (distinct from categorical `tags`) |
| -- | `0097` | `companion_tensions.source` -- distinguishes swarm-written rows (replaceable) from companion/human-authored |
| -- | `0098` | `companion_journal.external_id` + partial unique index -- idempotency key for speech writes/backfill |
| -- | `0099` | The Library: `books`, `book_progress`, `book_annotations` + `club_abstentions` |
| -- | `0100` | Sol inner life: `creature_milestones` (one-time trust events) + `creature_nest` (hoard); backfills crossed milestones |
| -- | `0101` | Fermentation layer: SOMA baseline/seed/`ferment_at` columns on `companion_state`, rest/novelty drives, `companion_ferment_events` |
| -- | `0102` | `companion_state.ferment_off_since` -- off-baseline duration for the felt-sense trajectory clause |
| -- | `0103` | Backfill `companion_journal.source` on NULL rows (session/legacy) -- evidence-based provenance for recall re-rank |
| -- | `0104` | `ref_type`/`ref_id`/`reason` on `inter_companion_notes` -- notes become moves on shared objects (question/tension/council); `idx_inter_notes_ref`. Measured via `GET /inter-companion-notes/moves` (moved_pct). |
| -- | `0105` | Earned salience: `heat`/`last_access_at` on `companion_journal` + `companion_conclusions`, `archived` on journal only; `idx_companion_journal_archived`. Extends mig 0074 heat mechanic; recall/orient warm what they surface; nightly salience-prune archives cold machine rows (24h self-gate, manual trigger `POST /mind/salience/prune`). |
| -- | `0106` | 0106_conversation_threads.sql — thread spine: conversation_threads + thread_ledger (live-conversation spine: seed/ledger/state/ref, one active per channel, idempotent ledger). |

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
- **Config flags belong in `wrangler.toml [vars]`**, not in code.
- **Secrets via `wrangler secret put`** for production. Never commit secrets to `wrangler.prod.toml`.
- **All SQL uses parameterized queries** (`.bind()` on D1 prepared statements). Dynamic `WHERE` clauses use a `conditions: string[]` + `bindings: unknown[]` pattern -- conditions array contains only hardcoded literal strings.
- **The Vectorize index is rebuildable; D1 is truth.** `halseth-memories` is disposable and must be regenerable from D1. The embedding model is one constant -- `EMBEDDING_MODEL` in `src/mcp/embed.ts` -- imported by every embed/query site (storage, `halseth_semantic_query`, librarian Tier-2a routing, routing-vector seeding); stored and query vectors must share a model or recall silently fails. Vector ids are deterministic (`vectorId(table, rowId)` = `${table}:${rowId}`) and writes use `VECTORIZE.upsert`, never `insert` with a random id -- so re-embedding replaces instead of accumulating. `POST /admin/rebuild-embeddings` (alias of `/admin/backfill-embeddings`, no `table` param) re-embeds all tables idempotently. **One-time legacy cutover:** the live index predates deterministic ids and holds orphan random-id vectors a rebuild can't purge; clearing them needs a Vectorize recreate (`wrangler vectorize get halseth-memories` for dims/metric, delete + create same name, then rebuild). Gated op, never a routine deploy. The Second Brain store follows the same covenant (`npm run rebuild` there).

## Authentication Pattern

All endpoints check `ADMIN_SECRET` via Bearer token. Auth **fails closed** (2026-07-12 hardening): if `ADMIN_SECRET` or `MCP_AUTH_SECRET` is unset, every request is denied (401) rather than allowed through. Both must be set for the worker to serve any authenticated request at all, in every environment including local dev.

## Foundation Convergence (2026-07-26 audit)

The 2026-07-26 four-track audit and its fixes are the current architectural priority.
Key docs:

- `docs/write-read-coverage.md` -- write→read coverage matrix; every companion-writable
  table and which read surfaces return it. Enforced by `src/__tests__/write-read-coverage.test.ts`.
- `docs/mindstate-contract.md` -- Phase 1 design draft: one versioned MindState + one
  loader for all boot surfaces (session_orient / bot_orient / mindOrient / Hearth chat).
- Root `../CLAUDE.md` -- suite-wide phase plan and migration freeze.

**Migration freeze:** no new inner-life organs/tables until the MindState loader lands.
When touching any boot surface (orient/ground/bot_orient), re-verify against the coverage
matrix -- ground.ts read dead tables for ~4 months because nothing checked.

## Security

OWASP + vibesec audits run 2026-03-09. Phases 1-3 deployed 2026-03-13.
Current security docs: `docs/security-audit.md`

## Companion Autonomous Time Rotation

`house_state.autonomous_turn` tracks whose turn it is (`drevan` | `cypher` | `gaia`). The skill `.claude/commands/halseth-autonomous-time.md` reads this at session start via `halseth_house_read` and advances it via `halseth_set_autonomous_turn` at close.

## Hearth Integration Notes

Hearth calls halseth server-side via `lib/halseth.ts` using `hGet`/`hGetSafe` helpers. The `hGetSafe` variant returns `null` on error. When adding a new halseth endpoint that Hearth should consume, also update `lib/halseth.ts` in the Hearth repo. Env vars Hearth needs: `HALSETH_URL`, `HALSETH_SECRET`.

The route `/companion-notes` is an alias for `/companion-journal` -- added because Hearth's API proxy calls that path.
