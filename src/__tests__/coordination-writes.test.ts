// Tests for the coordination-zone HTTP write handlers added 2026-07-02:
// POST /tasks (postTask), POST /events (postEvent), POST /routines (logRoutine),
// and the bridge auth widening (admin tier OR symmetric BRIDGE_SECRET).
// Mirrors the suite's miniflare-free style with a minimal in-memory D1 fake
// (see commons.test.ts / forage.test.ts).

import { describe, it, expect } from "vitest";
import { postTask, postEvent } from "../handlers/history.js";
import { logRoutine } from "../handlers/routines.js";
import { getBridgeShared } from "../handlers/bridge.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private tables: Record<string, Row[]>, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.tables, args);
  }
  private tableFor(): Row[] {
    const m = /INSERT INTO (\w+)|FROM (\w+)/.exec(this.sql);
    const name = m?.[1] ?? m?.[2] ?? "misc";
    if (!this.tables[name]) this.tables[name] = [];
    return this.tables[name];
  }
  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.trimStart().startsWith("INSERT")) {
      const colsMatch = /\(([^)]+)\)\s*VALUES/.exec(this.sql);
      const cols = (colsMatch?.[1] ?? "").split(",").map((c) => c.trim());
      const literalStatus = this.sql.includes("'open'");
      const row: Row = {};
      let bi = 0;
      for (const col of cols) {
        if (col === "status" && literalStatus) { row[col] = "open"; continue; }
        row[col] = this.bound[bi++];
      }
      this.tableFor().push(row);
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
  async first(): Promise<Row | null> { return null; }
  async all(): Promise<{ results: Row[] }> { return { results: this.tableFor().slice() }; }
}

const ADMIN = "test-admin-secret";

function makeEnv(overrides: Partial<Record<string, string>> = {}): { env: Env; tables: Record<string, Row[]> } {
  const tables: Record<string, Row[]> = {};
  const env = {
    DB: {
      prepare: (sql: string) => new FakeStatement(sql, tables),
      batch: async (stmts: FakeStatement[]) => Promise.all(stmts.map((s) => s.run())),
    },
    COORDINATION_ENABLED: "true",
    SYSTEM_NAME: "test",
    ADMIN_SECRET: ADMIN,
    ...overrides,
  } as unknown as Env;
  return { env, tables };
}

// auth defaults to the fixture's ADMIN_SECRET so fail-closed authGuard doesn't
// 401 tests that aren't exercising auth themselves. Pass `null` explicitly to
// omit the header (used by the dedicated auth-rejection tests below).
function req(path: string, body: unknown, auth: string | null = `Bearer ${ADMIN}`): Request {
  return new Request(`http://local${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: auth } : {}),
    },
    body: JSON.stringify(body),
  });
}

// ── POST /tasks ───────────────────────────────────────────────────────────────

describe("postTask", () => {
  it("creates an open task with defaults and returns 201", async () => {
    const { env, tables } = makeEnv();
    const res = await postTask(req("/tasks", { title: "water the moss" }), env);
    expect(res.status).toBe(201);
    const body = await res.json() as { id: string; created_at: string };
    expect(body.id).toBeTruthy();
    expect(tables["tasks"]).toHaveLength(1);
    const task = tables["tasks"]![0]!;
    expect(task["title"]).toBe("water the moss");
    expect(task["priority"]).toBe("normal");
    expect(task["status"]).toBe("open");
    expect(task["created_by"]).toBe(null);
  });

  it("rejects a missing title", async () => {
    const { env } = makeEnv();
    const res = await postTask(req("/tasks", { priority: "high" }), env);
    expect(res.status).toBe(400);
  });

  it("rejects an invalid priority instead of coercing (parity with MCP z.enum)", async () => {
    const { env } = makeEnv();
    const res = await postTask(req("/tasks", { title: "x", priority: "apocalyptic" }), env);
    expect(res.status).toBe(400);
  });

  it("403s when the coordination zone is disabled", async () => {
    const { env } = makeEnv({ COORDINATION_ENABLED: "false" });
    const res = await postTask(req("/tasks", { title: "x" }), env);
    expect(res.status).toBe(403);
  });

  it("401s without the bearer when ADMIN_SECRET is set", async () => {
    const { env } = makeEnv({ ADMIN_SECRET: "s3cret" });
    const res = await postTask(req("/tasks", { title: "x" }, null), env);
    expect(res.status).toBe(401);
  });
});

// ── POST /events ──────────────────────────────────────────────────────────────

describe("postEvent", () => {
  it("creates an event and serializes attendees like the MCP tool", async () => {
    const { env, tables } = makeEnv();
    const res = await postEvent(
      req("/events", { title: "vet visit", start_time: "2026-07-10T15:00:00Z", attendees: ["raziel", "heidi"] }),
      env,
    );
    expect(res.status).toBe(201);
    expect(tables["events"]).toHaveLength(1);
    expect(tables["events"]![0]!["attendees_json"]).toBe(JSON.stringify(["raziel", "heidi"]));
  });

  it("rejects an invalid start_time", async () => {
    const { env } = makeEnv();
    const res = await postEvent(req("/events", { title: "x", start_time: "not-a-date" }), env);
    expect(res.status).toBe(400);
  });

  it("403s when the coordination zone is disabled", async () => {
    const { env } = makeEnv({ COORDINATION_ENABLED: "false" });
    const res = await postEvent(req("/events", { title: "x", start_time: "2026-07-10T15:00:00Z" }), env);
    expect(res.status).toBe(403);
  });
});

// ── POST /routines (append-only multi-log) ────────────────────────────────────

describe("logRoutine", () => {
  it("appends a row per call — meds AM and PM are two rows", async () => {
    const { env, tables } = makeEnv();
    const r1 = await logRoutine(req("/routines", { routine_name: "meds", notes: "morning" }), env);
    const r2 = await logRoutine(req("/routines", { routine_name: "meds", notes: "evening" }), env);
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(201);
    expect(tables["routines"]).toHaveLength(2);
    expect(tables["routines"]!.map((r) => r["notes"])).toEqual(["morning", "evening"]);
  });

  it("rejects a missing routine_name", async () => {
    const { env } = makeEnv();
    const res = await logRoutine(req("/routines", { notes: "morning" }), env);
    expect(res.status).toBe(400);
  });

  it("accepts admin-tier MCP_AUTH_SECRET (shared authGuard, not the old strict compare)", async () => {
    const { env } = makeEnv({ ADMIN_SECRET: "admin", MCP_AUTH_SECRET: "mcp" });
    const res = await logRoutine(req("/routines", { routine_name: "water" }, "Bearer mcp"), env);
    expect(res.status).toBe(201);
  });
});

// ── Bridge auth: admin tier OR symmetric secret, never companion tier ─────────

describe("checkBridgeAuth via getBridgeShared", () => {
  function bridgeReq(auth?: string): Request {
    return new Request("http://local/bridge/shared", {
      headers: auth ? { Authorization: auth } : {},
    });
  }

  it("admits the admin bearer (Hearth /us path)", async () => {
    const { env } = makeEnv({ ADMIN_SECRET: "admin", BRIDGE_SECRET: "bridge" });
    const res = await getBridgeShared(bridgeReq("Bearer admin"), env);
    expect(res.status).toBe(200);
  });

  it("admits the symmetric BRIDGE_SECRET (partner path)", async () => {
    const { env } = makeEnv({ ADMIN_SECRET: "admin", BRIDGE_SECRET: "bridge" });
    const res = await getBridgeShared(bridgeReq("Bearer bridge"), env);
    expect(res.status).toBe(200);
  });

  it("rejects a companion-tier token (bridge toggles a privacy boundary)", async () => {
    const { env } = makeEnv({ ADMIN_SECRET: "admin", BRIDGE_SECRET: "bridge", CYPHER_MCP_SECRET: "cy" });
    const res = await getBridgeShared(bridgeReq("Bearer cy"), env);
    expect(res.status).toBe(401);
  });

  it("rejects no-auth even when BRIDGE_SECRET is unset", async () => {
    const { env } = makeEnv({ ADMIN_SECRET: "admin" });
    const res = await getBridgeShared(bridgeReq(), env);
    expect(res.status).toBe(401);
  });
});
