// Fix 2 (2026-07-21): execDeltaLog (src/librarian/executors/writes.ts) used to fall back
// to a bag-of-words sentiment regex when the caller omitted an explicit valence -- and it
// mislabeled entries containing words like "strained" as negative even in an otherwise
// loving/positive delta ("strained ankle" during a tender moment). The heuristic is removed
// entirely: valence stays undefined (written as NULL) unless the caller supplies it
// explicitly via context.valence or an inline `valence=X` / `valence: X` token in the text.

import { describe, it, expect } from "vitest";
import { execDeltaLog } from "../librarian/executors/writes.js";
import type { Env } from "../types.js";

interface Captured { sql: string; bound: unknown[] }

function fakeEnv(): { env: Env; calls: Captured[] } {
  const calls: Captured[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bound: unknown[]) {
            return { async run() { calls.push({ sql, bound }); return { meta: { changes: 1 } }; } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

// INSERT INTO relational_deltas (id, companion_id, subject_id, delta_type, payload_json,
//   session_id, created_at, agent, delta_text, valence, initiated_by)
// VALUES (?, '', 'mcp', 'mcp_delta', '{}', ?, ?, ?, ?, ?, ?)
// -- only the placeholders bind; literal columns are inline. Placeholder order:
// [0]=id [1]=session_id [2]=created_at [3]=agent [4]=delta_text [5]=valence [6]=initiated_by
const VALENCE_INDEX = 5;

describe("execDeltaLog: no sentiment-heuristic fallback for valence (fix 2)", () => {
  it("leaves valence undefined when no explicit valence is given, even with a 'negative' keyword", async () => {
    const { env, calls } = fakeEnv();
    const res = await execDeltaLog({
      env,
      req: {
        companion_id: "cypher",
        request: "log delta",
        context: JSON.stringify({ content: "Raziel strained his ankle on the hike but the day was warm and close." }),
      },
    } as never);
    expect((res as Record<string, unknown>).ack).toBe(true);
    // deltaLog binds `params.valence ?? null` (never raw undefined into .bind()).
    expect(calls[0]!.bound[VALENCE_INDEX]).toBeNull();
  });

  it("leaves valence undefined for a 'positive' keyword too -- no heuristic at all now", async () => {
    const { env, calls } = fakeEnv();
    await execDeltaLog({
      env,
      req: {
        companion_id: "cypher",
        request: "log delta",
        context: JSON.stringify({ content: "Something felt steadier and warmer between us today." }),
      },
    } as never);
    expect(calls[0]!.bound[VALENCE_INDEX]).toBeNull();
  });

  it("still honors an explicit context.valence", async () => {
    const { env, calls } = fakeEnv();
    await execDeltaLog({
      env,
      req: {
        companion_id: "cypher",
        request: "log delta",
        context: JSON.stringify({ content: "held, closer, good", valence: "tender" }),
      },
    } as never);
    expect(calls[0]!.bound[VALENCE_INDEX]).toBe("tender");
  });

  it("still honors an inline 'valence: X' token in the text and strips it from delta_text", async () => {
    const { env, calls } = fakeEnv();
    await execDeltaLog({
      env,
      req: {
        companion_id: "cypher",
        request: "log delta",
        context: JSON.stringify({ content: "the frame held. valence: repair" }),
      },
    } as never);
    expect(calls[0]!.bound[VALENCE_INDEX]).toBe("repair");
    // The strip regex's leading `[,.]?` also consumes the period before "valence:".
    expect(calls[0]!.bound[4]).toBe("the frame held");
  });

  it("still requires delta_text -- witnesses when nothing is present", async () => {
    const { env } = fakeEnv();
    const res = await execDeltaLog({
      env,
      req: { companion_id: "cypher", request: "delta log:", context: undefined },
    } as never) as Record<string, unknown>;
    expect(res.response_key).toBe("witness");
    expect(String(res.witness)).toContain("delta_text");
    expect(String(res.witness)).not.toContain("valence");
  });
});
