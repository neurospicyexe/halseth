# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Local dev server (localhost:8787) via wrangler
npm run deploy         # Deploy to Cloudflare Workers (uses wrangler.prod.toml)
npm run migrate:local  # Apply D1 migrations locally
npm run migrate:remote # Apply D1 migrations to production
npm run type-check     # TypeScript check (no emit)
```

Local secrets go in `.dev.vars` (gitignored). Copy from `config/.dev.vars.example` and fill in `ADMIN_SECRET` and `MCP_AUTH_SECRET`. Production secrets are set via `wrangler secret put <KEY>`.

## Ecosystem — Four Interworking Projects

Halseth is one of four projects that form a suite. When making changes that cross boundaries, consult the adjacent project's CLAUDE.md and MCP tools.

| Project | Location | Role |
|---------|----------|------|
| **halseth** | `C:/dev/halseth` | Primary data backend — Cloudflare Worker + D1 + R2. Exposes HTTP endpoints and MCP tools (`mcp__claude_ai_Halseth__*`) |
| **hearth** | `C:/dev/hearth` | Next.js dashboard frontend. Reads halseth HTTP endpoints via `lib/halseth.ts`. Deployed on Vercel (`nullsafe-hearth` project, team `neurospicyexe-3819s-projects`) |
| **nullsafe-plural-v2** | `C:/dev/nullsafe-plural-v2` | Cloudflare Workers MCP for SimplyPlural (plural/fronting system). Exposes `mcp__claude_ai_Nullsafe-Plural-v2__*` tools |
| **nullsafe-second-brain** | `C:/dev/nullsafe-second-brain` | Local Node.js MCP (stdio). Reads halseth + nullsafe-plural-v2 via HTTP, writes to Obsidian vault, maintains SQLite vector store for companion RAG |

Hearth consumes halseth endpoints directly over HTTP. Second-brain is the synthesis/RAG layer that reads both halseth and nullsafe-plural-v2. Nullsafe-plural-v2 and halseth are independent backends that both surface data upward to hearth and second-brain.

## Architecture

**Entry point:** `src/index.ts` — constructs a `Router` (a simple method+path matcher in `src/router.ts`) and dispatches to handlers in `src/handlers/`. The MCP interface (`POST /mcp`) routes to `src/mcp/server.ts`.

**Two parallel interfaces to the same data:**
- **HTTP API** (`src/handlers/`) — used by Hearth and direct HTTP consumers
- **MCP tools** (`src/mcp/tools/`) — used by Claude and second-brain; authenticated via `MCP_AUTH_SECRET` or OAuth

**Cloudflare bindings (defined in `src/types.ts` `Env`):**
- `DB` — D1 SQLite (relational store for all structured data)
- `BUCKET` — R2 (blob/artifact store)
- `AI` — Workers AI (used for embeddings)
- `VECTORIZE` — Vectorize index (`halseth-memories`)

**Feature flags (set in `wrangler.toml` `[vars]`, not in code):**
- `COMPANIONS_ENABLED` — enables companion routes; false returns 403
- `PLURALITY_ENABLED` — validates `front_state` against `system.members`
- `COORDINATION_ENABLED` — enables tasks/events/lists/routines shared zone

**Bridge:** When `BRIDGE_URL` and `BRIDGE_SECRET` are set, `/bridge/*` endpoints share tasks, events, and list items between two Halseth deployments. The secret is symmetric — same value on both sides.

**OAuth:** Full OAuth 2.0 with PKCE (S256) in `src/handlers/oauth.ts`. Tokens stored in D1 `oauth_tokens` table. Required for MCP clients that use the OAuth flow instead of the static `MCP_AUTH_SECRET`.

## Database Schema

Migrations live in `migrations/` and are applied in order. The schema is tier-based — apply only what your deployment needs:

| Tier | Migration | Adds |
|------|-----------|------|
| 0 | `0000_tier0_core.sql` | companions, sessions |
| 1 | `0001_tier1_memory.sql` | memories, tags, search metadata |
| 2 | `0002_tier2_relational.sql` | relational_deltas (append-only) |
| — | `0003`–`0015` | sessions expansion, private zone, shared zone (tasks/events/lists/routines), biometrics, bridge, OAuth, dream seeds |

## Covenants

- **`relational_deltas` is append-only.** No `UPDATE` or `DELETE` against this table ever. This is a hard invariant, not a preference. Violations are bugs.
- **Config flags belong in `wrangler.toml [vars]`**, not in code. Never add `if (env.SOME_FLAG === "hardcoded_value")` patterns.
- **Secrets via `wrangler secret put`** for production. Never commit secrets to `wrangler.prod.toml`.
- **All SQL uses parameterized queries** (`.bind()` on D1 prepared statements). Dynamic `WHERE` clauses are built with a `conditions: string[]` + `bindings: unknown[]` pattern — the conditions array contains only hardcoded literal strings.

## Authentication Pattern

Most write endpoints and some reads check `ADMIN_SECRET` via Bearer token. The pattern `if (!env.ADMIN_SECRET) return null` means auth is **skipped if the secret is unset** — acceptable for local dev, but ensure both `ADMIN_SECRET` and `MCP_AUTH_SECRET` are set in production.

History/feed endpoints (`/presence`, `/tasks`, `/events`, `/feelings`, `/dreams`, `/journal`, `/biometrics`, etc.) are **intentionally unauthenticated** — they serve as dashboard feeds for Hearth. This is by design for the personal/local deployment model, but means the Worker URL should not be exposed to untrusted networks without additional access controls.

## Security Status

Full OWASP + vibesec audits were run on this repo (2026-03-09). Phase 1 fixes are **deployed**. Phase 3 is blocked until second-brain is verified working.

### Completed (deployed)
- OAuth `redirect_uri` validated against registered client — `src/handlers/oauth.ts`
- PKCE `plain` method removed; S256 only — `src/handlers/oauth.ts`
- OAuth tokens now expire after 90 days — `src/mcp/server.ts`, migration `0016`
- MIME type allowlist + `Content-Disposition: attachment` + `X-Content-Type-Options` on asset serving — `src/handlers/assets.ts`
- `GET /assets` gated behind `authGuard` — `src/handlers/assets.ts`
- `POST /dream-seeds` gated behind `authGuard` — `src/handlers/feelings-dreams.ts`

### Phase 2 — second-brain header fix (done, not yet verified)
`C:/dev/nullsafe-second-brain/src/clients/halseth-client.ts` was updated to send `Authorization: Bearer` instead of `x-halseth-secret`. **Second-brain has never been launched** — this needs to be set up and verified before Phase 3.

### Phase 3 — blocked (gate public feed endpoints)
The following endpoints are still unauthenticated and expose sensitive personal data. Do NOT gate them until second-brain is verified live, because second-brain calls `/deltas` and `/routines`:

`/presence`, `/biometrics`, `/biometrics/latest`, `/handovers`, `/companion-journal`, `/companion-notes`, `/cypher-audit`, `/gaia-witness`, `/wounds`, `/routines`, `/deltas`, `/tasks`, `/events`, `/lists`, `/feelings`, `/dreams`, `/journal`

When ready: add `authGuard` to the handler functions in `src/handlers/history.ts`, `src/handlers/biometrics.ts`, `src/handlers/presence.ts`, `src/handlers/feelings-dreams.ts`, `src/handlers/human-journal.ts`. Hearth already sends correct auth headers and requires no changes.

### Still open (lower priority)
- No rate limiting on `/oauth/token` and `/admin/bootstrap`
- No startup validation that `ADMIN_SECRET` / `MCP_AUTH_SECRET` are set
- Memory poisoning via stored MCP content (AI-specific, architectural)

## Hearth Integration Notes

Hearth calls halseth server-side via `lib/halseth.ts` using `hGet`/`hGetSafe` helpers. The `hGetSafe` variant returns `null` on error and is used for endpoints that may not exist yet. When adding a new halseth endpoint that Hearth should consume, also update `lib/halseth.ts` in the Hearth repo. Env vars Hearth needs: `HALSETH_URL`, `HALSETH_SECRET`.

The route `/companion-notes` is an alias for `/companion-journal` — added because Hearth's API proxy calls that path.
