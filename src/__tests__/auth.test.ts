import { describe, it, expect } from "vitest";
import { safeEqual, authGuard } from "../lib/auth.js";

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
  it("returns null (allow) when ADMIN_SECRET is unset", () => {
    const env = { ADMIN_SECRET: undefined } as any;
    expect(authGuard(makeRequest(), env)).toBeNull();
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
});
