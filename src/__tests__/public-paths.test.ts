// P2-4 (BUGS.md 2026-10-08): the auth exemption set in src/lib/public-paths.ts had no test. A path
// added to PUBLIC_PATHS by mistake skips authGuard for every caller, so the set is locked here.
import { describe, it, expect } from "vitest";
import { PUBLIC_PATHS, isPublicPath } from "../lib/public-paths.js";

describe("isPublicPath", () => {
  it("treats the self-gated MCP endpoints as public", () => {
    expect(isPublicPath("/mcp")).toBe(true);
    expect(isPublicPath("/librarian/mcp")).toBe(true);
    expect(PUBLIC_PATHS.has("/mcp")).toBe(true);
    expect(PUBLIC_PATHS.has("/librarian/mcp")).toBe(true);
  });

  it("treats the OAuth flow and the presence feed as public", () => {
    for (const p of [
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-authorization-server",
      "/oauth/register", "/oauth/authorize", "/oauth/token", "/presence",
    ]) expect(isPublicPath(p), p).toBe(true);
  });

  it("keeps mind and admin routes behind authGuard", () => {
    expect(isPublicPath("/mind/state")).toBe(false);
    expect(isPublicPath("/admin/run-scheduled")).toBe(false);
    expect(isPublicPath("/mind/limbic/current")).toBe(false);
    expect(isPublicPath("/librarian")).toBe(false);
    expect(isPublicPath("/")).toBe(false);
  });

  it("prefix exemptions are exact: the GET-by-id streams are public, the minting/generating routes are not", () => {
    expect(isPublicPath("/assets/abc123")).toBe(true);
    expect(isPublicPath("/mind/tools/image/abc123")).toBe(true);
    expect(isPublicPath("/mind/tools/image")).toBe(false);
    expect(isPublicPath("/mind/books/upload")).toBe(true);
    expect(isPublicPath("/mind/books/upload-ticket")).toBe(false);
  });

  it("does not match on prefix for exact-only entries", () => {
    expect(isPublicPath("/mcp/anything")).toBe(false);
    expect(isPublicPath("/presence/admin")).toBe(false);
    expect(isPublicPath("/oauth/token/x")).toBe(false);
  });
});
