import { describe, it, expect } from "vitest";
import { safeEqual, authGuard, identifyCallerCompanion } from "../lib/auth.js";

describe("safeEqual", () => {
  it("returns true for matching strings", () => {
    expect(safeEqual("Bearer abc123", "Bearer abc123")).toBe(true);
  });

  it("returns false for mismatched strings of same length", () => {
    expect(safeEqual("Bearer abc123", "Bearer xyz789")).toBe(false);
  });

  it("returns false for different-length strings", () => {
    expect(safeEqual("short", "a much longer string")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(safeEqual("", "")).toBe(true);
  });
});

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set("Authorization", authHeader);
  return new Request("https://test.local/api", { headers });
}

describe("authGuard", () => {
  it("returns 401 (deny) when ADMIN_SECRET is unset", () => {
    const env = { ADMIN_SECRET: undefined } as any;
    const result = authGuard(makeRequest(), env);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns null on valid ADMIN_SECRET", () => {
    const env = { ADMIN_SECRET: "secret1" } as any;
    expect(authGuard(makeRequest("Bearer secret1"), env)).toBeNull();
  });

  it("returns null on valid MCP_AUTH_SECRET", () => {
    const env = { ADMIN_SECRET: "secret1", MCP_AUTH_SECRET: "secret2" } as any;
    expect(authGuard(makeRequest("Bearer secret2"), env)).toBeNull();
  });

  it("returns 401 on invalid token", () => {
    const env = { ADMIN_SECRET: "secret1" } as any;
    const result = authGuard(makeRequest("Bearer wrong"), env);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("returns 401 on missing Authorization header", () => {
    const env = { ADMIN_SECRET: "secret1" } as any;
    const result = authGuard(makeRequest(), env);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  // C.2a: per-companion tokens.
  it("accepts DREVAN_MCP_SECRET when configured", () => {
    const env = { ADMIN_SECRET: "admin", DREVAN_MCP_SECRET: "drevan-tok" } as any;
    expect(authGuard(makeRequest("Bearer drevan-tok"), env)).toBeNull();
  });

  it("accepts CYPHER_MCP_SECRET when configured", () => {
    const env = { ADMIN_SECRET: "admin", CYPHER_MCP_SECRET: "cypher-tok" } as any;
    expect(authGuard(makeRequest("Bearer cypher-tok"), env)).toBeNull();
  });

  it("accepts GAIA_MCP_SECRET when configured", () => {
    const env = { ADMIN_SECRET: "admin", GAIA_MCP_SECRET: "gaia-tok" } as any;
    expect(authGuard(makeRequest("Bearer gaia-tok"), env)).toBeNull();
  });

  it("rejects an unknown token even when companion secrets are configured", () => {
    const env = {
      ADMIN_SECRET: "admin",
      DREVAN_MCP_SECRET: "drevan-tok",
      CYPHER_MCP_SECRET: "cypher-tok",
    } as any;
    const result = authGuard(makeRequest("Bearer wrong-token"), env);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(401);
  });

  it("ADMIN_SECRET still works when companion secrets are also configured", () => {
    const env = {
      ADMIN_SECRET: "admin",
      DREVAN_MCP_SECRET: "drevan-tok",
    } as any;
    expect(authGuard(makeRequest("Bearer admin"), env)).toBeNull();
  });
});

describe("identifyCallerCompanion (C.2a)", () => {
  it("returns the companion when their token was used", () => {
    const env = {
      DREVAN_MCP_SECRET: "drevan-tok",
      CYPHER_MCP_SECRET: "cypher-tok",
      GAIA_MCP_SECRET: "gaia-tok",
    } as any;
    expect(identifyCallerCompanion(makeRequest("Bearer drevan-tok"), env)).toBe("drevan");
    expect(identifyCallerCompanion(makeRequest("Bearer cypher-tok"), env)).toBe("cypher");
    expect(identifyCallerCompanion(makeRequest("Bearer gaia-tok"), env)).toBe("gaia");
  });

  it("returns null when admin token was used (admin is not a companion)", () => {
    const env = {
      ADMIN_SECRET: "admin",
      DREVAN_MCP_SECRET: "drevan-tok",
    } as any;
    expect(identifyCallerCompanion(makeRequest("Bearer admin"), env)).toBeNull();
  });

  it("returns null when no per-companion secrets are configured", () => {
    const env = { ADMIN_SECRET: "admin" } as any;
    expect(identifyCallerCompanion(makeRequest("Bearer admin"), env)).toBeNull();
  });

  it("returns null when token does not match any configured per-companion secret", () => {
    const env = { DREVAN_MCP_SECRET: "drevan-tok" } as any;
    expect(identifyCallerCompanion(makeRequest("Bearer cypher-tok"), env)).toBeNull();
  });

  it("returns null on missing Authorization header", () => {
    const env = { CYPHER_MCP_SECRET: "cypher-tok" } as any;
    expect(identifyCallerCompanion(makeRequest(), env)).toBeNull();
  });
});
