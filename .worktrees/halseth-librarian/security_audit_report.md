# Security Audit Report: Halseth Implementation & MCP Design

**Auditor:** Cyber Security Expert (Antigravity)
**Date:** 2026-03-13
**Status:** Complete

## Executive Summary
The security audit of the Halseth backend confirms that all Phase 1 and Phase 3 fixes documented in `CLAUDE.md` have been correctly implemented. These fixes significantly improve the security of the OAuth flow and asset handling. However, several design-level vulnerabilities and "defaults-of-concern" remain, most notably the unauthenticated state of the system during initial bootstrap and the exposure of PII through dashboard feeds.

---

## 1. Audit of Documented Fixes

### 1a. OAuth Flow (src/handlers/oauth.ts)
- **Redirect URI Validation**: [PASS] `getOAuthAuthorize` and `postOAuthAuthorize` strictly validate the `redirect_uri` against the client's registered URIs.
- **PKCE enforcement**: [PASS] The `verifyPkce` helper correctly rejects any method other than `S256`.
- **Token Expiry**: [PASS] `postOAuthToken` correctly sets and persists an `expires_at` timestamp (90 days). `isAuthorized` in `src/mcp/server.ts` checks this timestamp.

### 1b. Asset Security (src/handlers/assets.ts)
- **Access Control**: [PASS] `listAssets` and `uploadAsset` are gated by `authGuard`.
- **MIME Allowlisting**: [PASS] `ALLOWED_MIME_TYPES` and `INLINE_IMAGE_TYPES` are used to prevent malicious file types from being served inline.
- **Security Headers**: [PASS] `X-Content-Type-Options: nosniff` and `Content-Disposition: attachment` are correctly applied to non-inline types.

### 1c. Authentication Coverage
- **`authGuard` implementation**: [PASS] The guard is consistently implemented across handlers.
- **Endpoint Gating**: [PASS] High-risk endpoints like `/dream-seeds`, `/notes`, and `/biometrics` are correctly protected.

---

## 2. New Findings & Design Risks

### 2a. Critical: Bootstrap Vulnerability (src/handlers/admin.ts)
The `bootstrapConfig` function includes a "skip-if-unset" pattern for `ADMIN_SECRET`:
```typescript
if (env.ADMIN_SECRET) {
  // check auth
}
```
> [!CAUTION]
> If a user deploys Halseth without immediately setting `ADMIN_SECRET` via Wrangler, the entire system is open to unauthenticated takeover. An attacker could call `/admin/bootstrap` to define the system owner and companions before the user can.

### 2b. Information Leakage (src/handlers/presence.ts & history.ts)
Endpoints like `/presence`, `/tasks`, `/events`, and `/lists` are **unauthenticated by design**.
- **Risk**: These endpoints return significant PII, including biometric summaries, recent relational deltas (chat snippets), and daily routines.
- **Design Impact**: While convenient for the Hearth dashboard, this relies entirely on the obfuscation of the Worker URL or Cloudflare Access policies which are not part of the codebase.

### 2c. Authorization Model Weakness
- **Admin Overreach**: The system uses a single `ADMIN_SECRET` for all "human" actions. There is no concept of a "Read-Only" dashboard key vs. a "Read/Write" admin key.
- **MCP Secret vs. Admin Secret**: The split between `MCP_AUTH_SECRET` and `ADMIN_SECRET` is good, but the "Admin" key can perform almost any action, including seeding personality deltas.

### 2d. Memory Poisoning (Architectural)
The risk of "Memory poisoning via stored MCP content" noted in `CLAUDE.md` is confirmed. Since companions act based on `relational_deltas` and `memories`, an attacker who gains access to a write endpoint could inject deltas that permanently alter a companion's personality or behavior.

---

## 3. SQL & Infrastructure Review

- **SQL Injection**: [PASS] All reviewed handlers in `src/handlers/` use parameterized queries (`.bind()`). Dynamic queries (like in `relational.ts`) use safe literal string arrays for clauses.
- **CORS**: [NEUTRAL] No CORS headers are present. This means the Worker is "Same-Origin" by default. If Hearth resides on a different domain (e.g., Vercel), it must use a server-side proxy (which it does via `lib/halseth.ts`) or the Worker will block requests. This is a secure default.
- **Rate Limiting**: [FAIL] As noted in `CLAUDE.md`, there is no rate limiting on `/oauth/token` or `/admin/bootstrap`, leaving them vulnerable to brute-force or DoS.

---

## Recommendations (For Reporting Only)

1. **Mandate Secrets**: Update `src/index.ts` to throw an error at startup if `ADMIN_SECRET` is not set.
2. **Tiered Auth**: Introduce a `DASHBOARD_SECRET` for read-only access to `/presence` and `/history`.
3. **Rate Limiting**: Use Cloudflare Workers Rate Limiting for the `/oauth/token` endpoint.
5. **Memory Poisoning Defense**: Because `relational_deltas` is strictly append-only by design, false memories injected by a compromised or hallucinating MCP client only pollute the record—they do not erase the true history. To handle poisoning occurrences:
    - **Surgical Runbook**: Create a manual operational runbook for the owner to delete anomalous rows via `wrangler d1 execute halseth --command="DELETE FROM relational_deltas WHERE id = 'bad-id'"` and manually drop the corresponding index from Vectorize.
    - **Quarantine Layer (Future Design)**: If poisoning becomes frequent, consider adding a `pending_deltas` quarantine table where MCP tools write first, requiring explicit owner approval via the Hearth dashboard before promoting to the permanent `relational_deltas` table and Vectorize index.
