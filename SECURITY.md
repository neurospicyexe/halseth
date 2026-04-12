# Security — Halseth

## Reporting a Vulnerability

If you find a security vulnerability in this code, please report it privately before public disclosure. Open a GitHub security advisory on this repository or contact the maintainer directly. Do not post exploit details publicly until there has been a chance to patch. See the root [SECURITY.md](../SECURITY.md) for full context on this project's security posture.

---

Halseth is the data backbone. Everything else in the system depends on it. Its security posture matters most.

See root `SECURITY.md` at `C:\dev\Bigger_Better_Halseth\SECURITY.md` for the full architecture overview and 2FA guidance.

---

## What's Protected Here

| Data | Where it lives | Who can access |
|------|---------------|----------------|
| Sessions, state, feelings, tasks | Cloudflare D1 (your account) | Anyone with ADMIN_SECRET |
| Companion continuity (WebMind) | Cloudflare D1 | Anyone with ADMIN_SECRET |
| Vault/RAG data | Second Brain VPS | Anyone with its API key |

---

## Secrets Used by This Service

| Secret | Where | Risk if leaked |
|--------|-------|---------------|
| `ADMIN_SECRET` | `.dev.vars` (local), Wrangler (prod) | Full read/write access to all data |
| `MCP_AUTH_SECRET` | `.dev.vars` (local), Wrangler (prod) | MCP tool access (Claude Code, companions) |
| `DEEPSEEK_API_KEY` | `.dev.vars` (local), Wrangler (prod) | API credit usage |

**None of these should ever appear in code or be committed to git.**

---

## Security Audits

OWASP + vibesec audits completed 2026-03-09. Phases 1-3 deployed 2026-03-13.
Open findings: `docs/security-audit.md`

All SQL uses parameterized queries via D1's `.bind()`. Dynamic `WHERE` clauses use a `conditions: string[]` + `bindings: unknown[]` pattern — no string interpolation.

The `if (!env.ADMIN_SECRET) return null` auth pattern means auth is **skipped if the secret is unset** — acceptable for local dev only. Always ensure both secrets are set in production.

---

## If ADMIN_SECRET Is Compromised

```bash
cd halseth
npx wrangler secret put ADMIN_SECRET
# Enter a new long random value

# Then update everywhere HALSETH_SECRET is used:
# - nullsafe-second-brain/.env on VPS
# - Railway environment variables (Discord bots)
# - Hearth Vercel environment variables
```
