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

## BBH Companion State Tables (migration 0020+)

- `companion_state` -- one mutable row per companion (write authority: companions only)
- `drift_log` -- append-only identity-lane signal log
- `somatic_snapshot` -- append-only; written by Synthesis Worker only
- `synthesis_summary` -- structured session/day/topic summaries; `companion_id` nullable (NULL = cross-companion)
- `inter_companion_notes` -- addressed notes between companions; `to_id` NULL = broadcast
- `synthesis_queue` -- async job queue (session_summary, drevan_state job types)
- `live_threads` -- Drevan v2 active emotional threads

MCP tools: `halseth_state_update`, `halseth_drift_log`, `halseth_companion_note`, `halseth_session_load`, `halseth_session_close`.

## Covenants

- **`relational_deltas` is append-only.** No `UPDATE` or `DELETE` against this table ever. Hard invariant, not a preference.
- **`relational_deltas` has two row shapes:** Legacy rows have `companion_id='drevan'` and `delta_text=NULL`. MCP-logged rows have `companion_id=''`, `agent='drevan'`, and `delta_text IS NOT NULL`. Queries must match both: `WHERE (companion_id = ? OR (agent = ? AND delta_text IS NOT NULL))`.
- **Config flags belong in `wrangler.toml [vars]`**, not in code.
- **Secrets via `wrangler secret put`** for production. Never commit secrets to `wrangler.prod.toml`.
- **All SQL uses parameterized queries** (`.bind()` on D1 prepared statements). Dynamic `WHERE` clauses use a `conditions: string[]` + `bindings: unknown[]` pattern -- conditions array contains only hardcoded literal strings.

## Authentication Pattern

All endpoints check `ADMIN_SECRET` via Bearer token. The pattern `if (!env.ADMIN_SECRET) return null` means auth is **skipped if the secret is unset** -- acceptable for local dev, but ensure both `ADMIN_SECRET` and `MCP_AUTH_SECRET` are set in production.

## Security

OWASP + vibesec audits run 2026-03-09. Phases 1-3 deployed 2026-03-13.
Open findings: `docs/security-audit.md`

## Companion Autonomous Time Rotation

`house_state.autonomous_turn` tracks whose turn it is (`drevan` | `cypher` | `gaia`). The skill `.claude/commands/halseth-autonomous-time.md` reads this at session start via `halseth_house_read` and advances it via `halseth_set_autonomous_turn` at close.

## Hearth Integration Notes

Hearth calls halseth server-side via `lib/halseth.ts` using `hGet`/`hGetSafe` helpers. The `hGetSafe` variant returns `null` on error. When adding a new halseth endpoint that Hearth should consume, also update `lib/halseth.ts` in the Hearth repo. Env vars Hearth needs: `HALSETH_URL`, `HALSETH_SECRET`.

The route `/companion-notes` is an alias for `/companion-journal` -- added because Hearth's API proxy calls that path.
