// Fix 3 (2026-07-21): halseth_task_list (raw MCP tool, src/mcp/tools/coordination.ts) had
// no default status filter -- omitting `status` returned every task including done ones,
// unlike every other read surface (getTasks in handlers/history.ts, librarian's taskList
// backend), which both default to `status != 'done'`. Locks in that the raw MCP tool now
// matches: default excludes done, explicit status:'done' still works, other filters
// combine correctly.

import { describe, it, expect } from "vitest";
import { registerCoordinationTools } from "../mcp/tools/coordination.js";
import type { Env } from "../types.js";

interface CapturedTool {
  handler: (input: Record<string, unknown>) => Promise<{ content: { type: string; text: string }[] }>;
}

class FakeMcpServer {
  tools: Record<string, CapturedTool> = {};
  tool(name: string, _description: string, _schema: unknown, handler: CapturedTool["handler"]): void {
    this.tools[name] = { handler };
  }
}

function makeEnv(): { env: Env; preparedSql: string[]; boundArgs: unknown[][] } {
  const preparedSql: string[] = [];
  const boundArgs: unknown[][] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return {
          bind: (...args: unknown[]) => {
            boundArgs.push(args);
            return { all: async () => ({ results: [] }) };
          },
        };
      },
    },
  };
  return { env: env as unknown as Env, preparedSql, boundArgs };
}

describe("halseth_task_list -- default status filter (fix 3)", () => {
  it("defaults to status != 'done' when status is omitted", async () => {
    const { env, preparedSql } = makeEnv();
    const server = new FakeMcpServer();
    registerCoordinationTools(server as never, env);

    await server.tools["halseth_task_list"]!.handler({ limit: 50 });

    const sql = preparedSql.find((s) => s.includes("FROM tasks"));
    expect(sql).toContain("status != 'done'");
  });

  it("still returns done tasks when status: 'done' is explicit", async () => {
    const { env, preparedSql, boundArgs } = makeEnv();
    const server = new FakeMcpServer();
    registerCoordinationTools(server as never, env);

    await server.tools["halseth_task_list"]!.handler({ status: "done", limit: 50 });

    const sql = preparedSql.find((s) => s.includes("FROM tasks"));
    expect(sql).toContain("status = ?");
    expect(sql).not.toContain("status != 'done'");
    expect(boundArgs[0]).toContain("done");
  });

  it("still filters by open/in_progress explicitly (parity, not just the default)", async () => {
    const { env, preparedSql } = makeEnv();
    const server = new FakeMcpServer();
    registerCoordinationTools(server as never, env);

    await server.tools["halseth_task_list"]!.handler({ status: "open", limit: 50 });

    const sql = preparedSql.find((s) => s.includes("FROM tasks"));
    expect(sql).toContain("status = ?");
    expect(sql).not.toContain("status != 'done'");
  });

  it("combines the default done-exclusion with an assigned_to filter (AND, not override)", async () => {
    const { env, preparedSql, boundArgs } = makeEnv();
    const server = new FakeMcpServer();
    registerCoordinationTools(server as never, env);

    await server.tools["halseth_task_list"]!.handler({ assigned_to: "raziel", limit: 50 });

    const sql = preparedSql.find((s) => s.includes("FROM tasks"));
    expect(sql).toContain("WHERE status != 'done' AND assigned_to = ?");
    expect(boundArgs[0]).toContain("raziel");
  });
});
