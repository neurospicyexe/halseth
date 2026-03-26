# Stack Code Review — 2026-03-25

Scope: Halseth (Worker), nullsafe-discord (Railway bots), Hearth (Next.js), cross-project integration surfaces.

---

## Critical Issues 🔴

None. No injection vectors, no exposed secrets in committed code.

---

## High Priority 🟠

### 1. `MCP_AUTH_SECRET` / `ADMIN_SECRET` skip-if-unset (Halseth)

**Problem:** `if (!env.MCP_AUTH_SECRET) return true` — endpoint is fully open if secret isn't set.
**Location:** `src/mcp/server.ts` (isAuthorized), same pattern in admin bootstrap handler.
**Impact:** Accidental deploy without secret = unauthenticated write access to all MCP tools.
**Fix:** Add startup validation in `src/index.ts` that warns loudly (but doesn't crash) if either secret is missing in non-local environments. Or enforce required secrets via a startup check that logs a `console.error` and returns 500 on sensitive routes when the secret is absent, rather than silently opening.
**Note:** This is documented as a known LOW in `docs/security-audit.md`. Keeping it LOW is acceptable for single-owner lean phase. Worth re-evaluating before Phoenix/multi-user.

---

### 2. `BRIDGE_SECRET` committed as plain var in `wrangler.toml`

**Problem:** `BRIDGE_SECRET = ""` is in `[vars]` in wrangler.toml, not a wrangler secret.
**Location:** `wrangler.toml` line ~28.
**Impact:** When filled, this symmetric secret would be committed to source control if someone adds it to the wrong config block.
**Fix:** Move `BRIDGE_SECRET` to a comment noting it must be set via `wrangler secret put BRIDGE_SECRET`. Remove the empty `= ""` var entry so contributors don't accidentally fill it there.

---

### 3. `SYSTEM_OWNER = "REPLACE_WITH_OWNER"` unfilled placeholder in committed config

**Problem:** Placeholder value committed in `wrangler.toml`.
**Location:** `wrangler.toml` [vars] block.
**Impact:** Any code path that reads `env.SYSTEM_OWNER` returns a nonsense string in production if `wrangler.prod.toml` also has this unfilled.
**Fix:** Verify `wrangler.prod.toml` has the real value. Add a note in CLAUDE.md to fill this at deploy time.

---

### 4. Synthesis cron `*/1 * * * *` (every minute) — no empty-queue short-circuit guarantee

**Problem:** Cron fires every minute regardless of queue depth.
**Location:** `wrangler.toml` triggers, `src/synthesis/index.ts`.
**Impact:** On Cloudflare free tier (100k requests/day), 1440 cron invocations/day = ~1.4% of daily budget consumed on cron alone, even when queue is empty.
**Fix:** Confirm `src/synthesis/index.ts` exits immediately on empty queue (no D1 writes). If not, add early-exit: `if (queueDepth === 0) return`. Consider relaxing to `*/5 * * * *` given synthesis is best-effort.

---

## Medium Priority 🟡

### 5. `dist/` committed alongside `src/` in Discord monorepo

**Problem:** `packages/shared/dist/` is in the repo alongside `src/`.
**Impact:** Stale compiled output ships if someone edits `src/` without rebuilding. Tests run against dist (`.d.ts` files visible in dist/__tests__/).
**Fix:** Add `packages/shared/dist/` to `.gitignore`. CI should run `npm run build` before tests. Railway deploy should build from source, not from committed dist.

### 6. No timeout on DeepSeek/Groq/Ollama calls in Discord inference

**Problem:** `InferenceAdapter.generate()` makes HTTP calls with no explicit `AbortSignal` or timeout.
**Location:** `packages/shared/src/inference.ts`.
**Impact:** Hung inference call can block a Discord message handler indefinitely.
**Fix:** Add `AbortController` with 30s timeout to all inference fetch calls. Pattern:
```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 30_000);
const res = await fetch(url, { ..., signal: controller.signal });
clearTimeout(timer);
```

### 7. Dead cron stub fires daily (day context synthesis)

**Problem:** `0 11 * * *` cron fires at 11 UTC daily but the Phase 2 handler is a stub.
**Location:** `wrangler.toml`, `src/synthesis/index.ts`.
**Impact:** Wasted invocation, potential confusion in logs.
**Fix:** Either implement the handler, or comment out the cron until Phase 2 is ready.

### 8. `npm run dev` uses `wrangler.prod.toml`, not a local config

**Problem:** `"dev": "wrangler dev --config wrangler.prod.toml"` — local dev runs against production config (bindings point to production D1 database ID).
**Location:** `package.json`.
**Impact:** Local dev mutations go to production D1. This is intentional for lean-phase workflows, but is a footgun for new contributors or during Phoenix onboarding.
**Fix:** Consider adding a `wrangler.dev.toml` with local D1 preview IDs. Or add a comment in CLAUDE.md: "intentional — local dev hits production database."
**Note:** Possibly already intentional. Flagging for conscious acknowledgment.

---

## Low Priority 🟢

### 9. 27 migrations with no squash plan

**Problem:** Sequential migration history (0000–0026) with no consolidation.
**Location:** `migrations/`.
**Impact:** Fresh deploys apply all 27 migrations sequentially. Schema intent is distributed across files.
**Note:** Acceptable for lean phase. When Phoenix absorbs Halseth, a schema snapshot migration (0027_squash_base.sql) covering all prior state would simplify Phoenix onboarding.

### 10. `PLURALITY_ENABLED = "false"` silently disables front_state validation

**Problem:** Front-state validation is off by default.
**Location:** `wrangler.toml`.
**Impact:** For the shareable/deploy-your-own use case, a new user who sets up Plural integration won't get validation unless they know to flip this flag.
**Fix:** Document in README/onboarding that plural systems should set `PLURALITY_ENABLED = "true"` and connect the Plural service binding.

### 11. Librarian patterns: natural language → action extraction is brittle at edges

**Problem:** Fast-path patterns use regex/substring matching on companion-supplied natural language.
**Location:** `src/librarian/patterns.ts`, `src/librarian/extract.ts`.
**Impact:** Ambiguous queries may hit wrong fast path or fall through to DeepSeek classifier unnecessarily.
**Note:** Architectural. DeepSeek fallback is the safety valve. Acceptable for now.

---

## Cross-Project Integration Summary

| Integration | Pattern | Auth | Status |
|------------|---------|------|--------|
| Discord → Halseth | HTTP Bearer | `HALSETH_SECRET` env var | Correct; env sanitized (commit 9597699) |
| Hearth → Halseth | HTTP via `hGet`/`hGetSafe` | `HALSETH_SECRET` env var | Correct; `hGetSafe` returns null on error |
| Halseth Librarian → Plural | Cloudflare Service Binding | None needed (internal) | Best pattern — no network hop |
| Halseth Librarian → Second Brain | HTTPS MCP | `SECOND_BRAIN_TOKEN` | Acceptable; VPS-dependent |
| Halseth Synthesis → DeepSeek | HTTP | `DEEPSEEK_API_KEY` | Correct; guarded on missing key |
| Bridge (peer Halseth) | HTTP | `BRIDGE_SECRET` (symmetric) | Correct design; see issue #2 above |

---

## What's Working Well

- D1 parameterized queries (`.bind()` pattern) used consistently — no SQL injection surface.
- `relational_deltas` append-only covenant is documented and enforced architecturally.
- Librarian's single-entry-point pattern correctly limits companion blast radius.
- Atomic SOMA write at session_close prevents partial state reads.
- Dream seed claim-on-read atomicity recently fixed — correct.
- Discord bot inference fallback chain (DeepSeek → Groq → Ollama) is resilient.
- Identity cache fallback when Halseth is unavailable prevents silent companion death.
- `hGetSafe` in Hearth properly absorbs Halseth errors without crashing the dashboard.
- OAuth PKCE (S256) is correct pattern for MCP client auth.
- Zod dependency in Halseth — good signal that input validation is present.

---

## Recommended Actions (Priority Order)

1. Resolve BRIDGE_SECRET var placement (#2) — 5 min fix, prevents future secret leak
2. Add inference timeout in Discord bots (#6) — 15 min, prevents hung message handlers
3. Disable or guard day-context stub cron (#7) — 5 min
4. Add npm run dev warning / CLAUDE.md note about prod DB (#8) — 5 min
5. Plan migration squash for Phoenix absorption (#9) — defer to Phoenix Heart Phase
