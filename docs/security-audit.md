# Halseth Security Audit

OWASP + vibesec audits run 2026-03-09. Phases 1-3 deployed 2026-03-13.
Completed findings are not tracked here -- they're in git history.

## Open Findings

| Severity | Issue |
|----------|-------|
| LOW | No rate limiting on `/oauth/token` and `/admin/bootstrap` |
| LOW | No startup validation that `ADMIN_SECRET` / `MCP_AUTH_SECRET` are set (auth silently skipped if unset) |
| LOW | Memory poisoning via stored MCP content (AI-specific, architectural -- no easy fix) |
