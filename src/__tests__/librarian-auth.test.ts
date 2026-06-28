import { describe, it, expect } from "vitest";
import { handleLibrarian } from "../librarian/index";

// Regression for the 2026-06-27 "/librarian 401" bug: the autonomous bridge/NL pollers
// in the Discord bots carry the admin token as HALSETH_SECRET (value == ADMIN_SECRET).
// /librarian/mcp and authGuard both accept ADMIN_SECRET; plain POST /librarian did not,
// so every bridge/NL poll silently 401'd in prod while main replies (a different path)
// stayed healthy. The gate now accepts ADMIN_SECRET for parity.
//
// We assert auth OUTCOME only: with a valid token the handler falls through to a 400
// (missing companion_id) -- a 400 proves auth passed; a 401 proves it was rejected.

function req(bearer?: string) {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (bearer !== undefined) headers["Authorization"] = `Bearer ${bearer}`;
  return new Request("https://h.example/librarian", {
    method: "POST",
    headers,
    body: JSON.stringify({}), // intentionally missing companion_id -> 400 once authorized
  });
}

const MCP = "mcp-auth-token";
const ADMIN = "admin-tier-token-64ch";

describe("POST /librarian auth gate", () => {
  it("accepts ADMIN_SECRET (the bots' HALSETH_SECRET) -- the 06-27 regression", async () => {
    const env = { MCP_AUTH_SECRET: MCP, ADMIN_SECRET: ADMIN } as any;
    const res = await handleLibrarian(req(ADMIN), env);
    expect(res.status).toBe(400); // authorized -> reached body validation
  });

  it("accepts MCP_AUTH_SECRET", async () => {
    const env = { MCP_AUTH_SECRET: MCP, ADMIN_SECRET: ADMIN } as any;
    const res = await handleLibrarian(req(MCP), env);
    expect(res.status).toBe(400);
  });

  it("rejects an unknown bearer with 401", async () => {
    const env = { MCP_AUTH_SECRET: MCP, ADMIN_SECRET: ADMIN } as any;
    const res = await handleLibrarian(req("not-the-secret"), env);
    expect(res.status).toBe(401);
  });

  it("rejects a missing Authorization header with 401 when a secret is configured", async () => {
    const env = { ADMIN_SECRET: ADMIN } as any;
    const res = await handleLibrarian(req(undefined), env);
    expect(res.status).toBe(401);
  });

  it("is open when neither shared admin nor per-companion secret is configured", async () => {
    const env = {} as any;
    const res = await handleLibrarian(req("anything"), env);
    expect(res.status).toBe(400); // open -> reached body validation
  });

  it("still accepts ADMIN_SECRET even if MCP_AUTH_SECRET is unset", async () => {
    const env = { ADMIN_SECRET: ADMIN } as any;
    const res = await handleLibrarian(req(ADMIN), env);
    expect(res.status).toBe(400);
  });
});
