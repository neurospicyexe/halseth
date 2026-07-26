// Task 20 (thinking-quality fix, mig 0105): the halseth_companion_notes_read MCP
// tool (src/mcp/tools/companion.ts) is one of the two remaining companion_journal
// read paths flagged by the Task 19 reviewer as still missing the archived=0
// filter (recall/orient were fixed in task 19; this + motifs.ts were left for
// task 20, in-scope-by-consequence -- archiving only matters once rows can be
// archived). This locks in that the fix landed and the filter combines
// correctly with the tool's existing optional agent/session_id filters.

import { describe, it, expect } from "vitest";
import { registerCompanionTools } from "../mcp/tools/companion.js";
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

function makeEnv(): { env: Env; preparedSql: string[] } {
  const preparedSql: string[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        preparedSql.push(sql);
        return {
          bind: (..._args: unknown[]) => ({
            all: async () => ({ results: [] }),
          }),
        };
      },
    },
  };
  return { env: env as unknown as Env, preparedSql };
}

describe("halseth_companion_notes_read -- archived = 0 filter (task 20)", () => {
  it("always scopes the SELECT to archived = 0, with no other filters", async () => {
    const { env, preparedSql } = makeEnv();
    const server = new FakeMcpServer();
    registerCompanionTools(server as never, env);

    await server.tools["halseth_companion_notes_read"]!.handler({ limit: 20 });

    const sql = preparedSql.find((s) => s.includes("FROM companion_journal"));
    expect(sql).toBeDefined();
    expect(sql).toContain("WHERE archived = 0");
    expect(sql).not.toContain("agent = ?");
    expect(sql).not.toContain("session_id = ?");
  });

  it("combines archived = 0 with the optional agent filter (AND, not OR / override)", async () => {
    const { env, preparedSql } = makeEnv();
    const server = new FakeMcpServer();
    registerCompanionTools(server as never, env);

    await server.tools["halseth_companion_notes_read"]!.handler({ agent: "cypher", limit: 20 });

    const sql = preparedSql.find((s) => s.includes("FROM companion_journal"));
    expect(sql).toContain("WHERE archived = 0 AND agent = ?");
  });

  it("combines archived = 0 with both optional filters when both are given", async () => {
    const { env, preparedSql } = makeEnv();
    const server = new FakeMcpServer();
    registerCompanionTools(server as never, env);

    await server.tools["halseth_companion_notes_read"]!.handler({ agent: "cypher", session_id: "s1", limit: 20 });

    const sql = preparedSql.find((s) => s.includes("FROM companion_journal"));
    expect(sql).toContain("WHERE archived = 0 AND agent = ? AND session_id = ?");
  });
});
