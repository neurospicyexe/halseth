# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev            # Local dev server (localhost:8787) via wrangler
npm run deploy         # Deploy to Cloudflare Workers (uses wrangler.prod.toml)
npm run migrate:local  # Apply D1 migrations locally
npm run migrate:remote # Apply D1 migrations to production
npm run type-check     # TypeScript check (no emit)
# Windows: set CLOUDFLARE_API_TOKEN via $env:CLOUDFLARE_API_TOKEN="..." (PowerShell syntax, not export)
# Wrangler auth: the "Edit Cloudflare Workers" API token template is missing D1:Edit — add it manually or migrations will fail with 7403.
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
| — | `0016` | OAuth token expiry |
| — | `0017` | `house_state.autonomous_turn` — companion rotation field |
| — | `0018` | `companion_config.avatar_asset_id` — R2 asset linkage for avatars |

## Covenants

- **`relational_deltas` is append-only.** No `UPDATE` or `DELETE` against this table ever. This is a hard invariant, not a preference. Violations are bugs.
- **`relational_deltas` has two row shapes:** Legacy HTTP rows have `companion_id='drevan'` and `delta_text=NULL`. MCP-logged rows have `companion_id=''`, `agent='drevan'`, and `delta_text IS NOT NULL`. Queries filtering by companion must match both: `WHERE (companion_id = ? OR (agent = ? AND delta_text IS NOT NULL))`.
- **Config flags belong in `wrangler.toml [vars]`**, not in code. Never add `if (env.SOME_FLAG === "hardcoded_value")` patterns.
- **Secrets via `wrangler secret put`** for production. Never commit secrets to `wrangler.prod.toml`.
- **All SQL uses parameterized queries** (`.bind()` on D1 prepared statements). Dynamic `WHERE` clauses are built with a `conditions: string[]` + `bindings: unknown[]` pattern — the conditions array contains only hardcoded literal strings.

## Authentication Pattern

All endpoints check `ADMIN_SECRET` via Bearer token — including feed/read endpoints (`/presence`, `/sessions`, `/tasks`, `/events`, `/feelings`, `/dreams`, `/journal`, `/biometrics`, etc.). The pattern `if (!env.ADMIN_SECRET) return null` means auth is **skipped if the secret is unset** — acceptable for local dev, but ensure both `ADMIN_SECRET` and `MCP_AUTH_SECRET` are set in production.

Feed endpoints were unauthenticated by design in earlier versions but were fully gated in the Phase 3 security pass (2026-03-13). The Worker URL still should not be exposed to untrusted networks without additional access controls (no rate limiting yet).

## Security Status

Full OWASP + vibesec audits were run on this repo (2026-03-09). Phases 1–3 are **complete and deployed** (2026-03-13).

### Completed (deployed)
- OAuth `redirect_uri` validated against registered client — `src/handlers/oauth.ts`
- PKCE `plain` method removed; S256 only — `src/handlers/oauth.ts`
- OAuth tokens now expire after 90 days — `src/mcp/server.ts`, migration `0016`
- MIME type allowlist + `Content-Disposition: attachment` + `X-Content-Type-Options` on asset serving — `src/handlers/assets.ts`
- `GET /assets` gated behind `authGuard` — `src/handlers/assets.ts`
- `POST /dream-seeds` gated behind `authGuard` — `src/handlers/feelings-dreams.ts`

### Phase 2 — second-brain header fix (verified 2026-03-13)
`C:/dev/nullsafe-second-brain/src/clients/halseth-client.ts` sends `Authorization: Bearer`. Second-brain is live and connected (MCP tools active, `sb_status` returns healthy).

### Phase 3 — complete (deployed 2026-03-13)
All feed endpoints are now gated behind `authGuard`. The only gap was `GET /companion-notes` in `src/handlers/notes.ts` — fixed and deployed.

`GET /sessions` and `GET /sessions/:id` (read-only session history endpoints, `src/handlers/sessions.ts`) are also `authGuard`-gated.

### Still open (lower priority)
- No rate limiting on `/oauth/token` and `/admin/bootstrap`
- No startup validation that `ADMIN_SECRET` / `MCP_AUTH_SECRET` are set
- Memory poisoning via stored MCP content (AI-specific, architectural)

## Companion Autonomous Time Rotation

`house_state.autonomous_turn` tracks whose turn it is (`drevan` | `cypher` | `gaia`). The skill `.claude/commands/halseth-autonomous-time.md` reads this at session start via `halseth_house_read` and advances it via `halseth_set_autonomous_turn` at close. Companions skip their session if it's not their turn.

## Hearth Integration Notes

Hearth calls halseth server-side via `lib/halseth.ts` using `hGet`/`hGetSafe` helpers. The `hGetSafe` variant returns `null` on error and is used for endpoints that may not exist yet. When adding a new halseth endpoint that Hearth should consume, also update `lib/halseth.ts` in the Hearth repo. Env vars Hearth needs: `HALSETH_URL`, `HALSETH_SECRET`.

The route `/companion-notes` is an alias for `/companion-journal` — added because Hearth's API proxy calls that path.

# context-mode — MANDATORY routing rules

You have context-mode MCP tools available. These rules are NOT optional — they protect your context window from flooding. A single unrouted command can dump 56 KB into context and waste the entire session.

## BLOCKED commands — do NOT attempt these

### curl / wget — BLOCKED
Any Bash command containing `curl` or `wget` is intercepted and replaced with an error message. Do NOT retry.
Instead use:
- `ctx_fetch_and_index(url, source)` to fetch and index web pages
- `ctx_execute(language: "javascript", code: "const r = await fetch(...)")` to run HTTP calls in sandbox

### Inline HTTP — BLOCKED
Any Bash command containing `fetch('http`, `requests.get(`, `requests.post(`, `http.get(`, or `http.request(` is intercepted and replaced with an error message. Do NOT retry with Bash.
Instead use:
- `ctx_execute(language, code)` to run HTTP calls in sandbox — only stdout enters context

### WebFetch — BLOCKED
WebFetch calls are denied entirely. The URL is extracted and you are told to use `ctx_fetch_and_index` instead.
Instead use:
- `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` to query the indexed content

## REDIRECTED tools — use sandbox equivalents

### Bash (>20 lines output)
Bash is ONLY for: `git`, `mkdir`, `rm`, `mv`, `cd`, `ls`, `npm install`, `pip install`, and other short-output commands.
For everything else, use:
- `ctx_batch_execute(commands, queries)` — run multiple commands + search in ONE call
- `ctx_execute(language: "shell", code: "...")` — run in sandbox, only stdout enters context

### Read (for analysis)
If you are reading a file to **Edit** it → Read is correct (Edit needs content in context).
If you are reading to **analyze, explore, or summarize** → use `ctx_execute_file(path, language, code)` instead. Only your printed summary enters context. The raw file content stays in the sandbox.

### Grep (large results)
Grep results can flood context. Use `ctx_execute(language: "shell", code: "grep ...")` to run searches in sandbox. Only your printed summary enters context.

## Tool selection hierarchy

1. **GATHER**: `ctx_batch_execute(commands, queries)` — Primary tool. Runs all commands, auto-indexes output, returns search results. ONE call replaces 30+ individual calls.
2. **FOLLOW-UP**: `ctx_search(queries: ["q1", "q2", ...])` — Query indexed content. Pass ALL questions as array in ONE call.
3. **PROCESSING**: `ctx_execute(language, code)` | `ctx_execute_file(path, language, code)` — Sandbox execution. Only stdout enters context.
4. **WEB**: `ctx_fetch_and_index(url, source)` then `ctx_search(queries)` — Fetch, chunk, index, query. Raw HTML never enters context.
5. **INDEX**: `ctx_index(content, source)` — Store content in FTS5 knowledge base for later search.

## Subagent routing

When spawning subagents (Agent/Task tool), the routing block is automatically injected into their prompt. Bash-type subagents are upgraded to general-purpose so they have access to MCP tools. You do NOT need to manually instruct subagents about context-mode.

## Output constraints

- Keep responses under 500 words.
- Write artifacts (code, configs, PRDs) to FILES — never return them as inline text. Return only: file path + 1-line description.
- When indexing content, use descriptive source labels so others can `ctx_search(source: "label")` later.

## ctx commands

| Command | Action |
|---------|--------|
| `ctx stats` | Call the `ctx_stats` MCP tool and display the full output verbatim |
| `ctx doctor` | Call the `ctx_doctor` MCP tool, run the returned shell command, display as checklist |
| `ctx upgrade` | Call the `ctx_upgrade` MCP tool, run the returned shell command, display as checklist |
