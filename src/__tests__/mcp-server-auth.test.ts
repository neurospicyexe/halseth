import { describe, it, expect } from "vitest";
import { isAuthorized } from "../mcp/server.js";

function makeRequest(authHeader?: string): Request {
  const headers = new Headers();
  if (authHeader) headers.set("Authorization", authHeader);
  return new Request("https://test.local/mcp", { method: "POST", headers });
}

describe("mcp/server isAuthorized", () => {
  it("denies when MCP_AUTH_SECRET is unset", async () => {
    const env = { MCP_AUTH_SECRET: undefined } as any;
    expect(await isAuthorized(makeRequest(), env)).toBe(false);
  });

  it("accepts the static MCP_AUTH_SECRET", async () => {
    const env = { MCP_AUTH_SECRET: "mcp-secret" } as any;
    expect(await isAuthorized(makeRequest("Bearer mcp-secret"), env)).toBe(true);
  });

  it("rejects a wrong static secret", async () => {
    // A wrong static secret falls through to the OAuth-token DB lookup, so the
    // mock env needs a DB stub whose lookup finds no matching token.
    const db = {
      prepare: () => ({
        bind: () => ({ first: async () => null }),
      }),
    };
    const env = { MCP_AUTH_SECRET: "mcp-secret", DB: db } as any;
    expect(await isAuthorized(makeRequest("Bearer wrong"), env)).toBe(false);
  });

  it("rejects a missing Authorization header when a secret is configured", async () => {
    const env = { MCP_AUTH_SECRET: "mcp-secret" } as any;
    expect(await isAuthorized(makeRequest(), env)).toBe(false);
  });
});
