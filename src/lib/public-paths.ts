// src/lib/public-paths.ts
//
// Routes that do NOT require the global authGuard. Extracted from src/index.ts (2026-10-08, P2-4)
// so the set is unit-testable without importing the whole Worker module graph.

/** Exact-match paths that skip the global auth guard (OAuth flow + read-only dashboard feed + self-gated routes). */
export const PUBLIC_PATHS: ReadonlySet<string> = new Set([
  "/.well-known/oauth-protected-resource",
  "/.well-known/oauth-authorization-server",
  "/oauth/register",
  "/oauth/authorize",
  "/oauth/token",
  "/presence",
  "/librarian/mcp",  // has its own auth gate that accepts OAuth tokens
  "/mcp",            // has its own auth gate that accepts OAuth tokens
  // Bridge does its own auth (checkBridgeAuth: admin tier OR symmetric
  // BRIDGE_SECRET). Without this exemption the global authGuard 401s a partner
  // deployment that only holds BRIDGE_SECRET before the handler ever runs.
  "/bridge/shared",
  "/bridge/act",
  "/bridge/toggle",
  // Library browser upload: authenticated by a short-lived HMAC upload ticket
  // (src/lib/upload-ticket.ts), fail-closed without UPLOAD_TICKET_SECRET. Exact path only,
  // so POST /mind/books/upload-ticket (the minting route) stays behind authGuard.
  "/mind/books/upload",
]);

export function isPublicPath(pathname: string): boolean {
  // The trailing slash on /mind/tools/image/ exempts ONLY the GET-by-id stream
  // (public read: unguessable random id, DB-validated; mirrors /assets/). The POST
  // generator at /mind/tools/image (no trailing slash) stays gated + audited.
  return PUBLIC_PATHS.has(pathname)
    || pathname.startsWith("/assets/")
    || pathname.startsWith("/mind/tools/image/");
}
