// Regression: execJournalAdd robustness (2026-06-13 bug hunt).
// Two live failures it guards against:
//   1. `content` (the alias every other write surface accepts) was rejected; only
//      `entry_text` worked -> companion writes silently no-op'd.
//   2. `tags` as an array was bound straight to D1 -> "D1_TYPE_ERROR: Type 'object'
//      not supported". The human_journal.tags column is a string; it must be coerced.

import { describe, it, expect } from "vitest";
import { execJournalAdd } from "../librarian/executors/writes.js";
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

describe("execJournalAdd robustness", () => {
  it("accepts the `content` alias (not just entry_text)", async () => {
    const { env, calls } = fakeEnv();
    const res = await execJournalAdd({ env, req: { companion_id: "cypher", request: "add journal entry", context: JSON.stringify({ content: "a value anchor" }) } } as never);
    expect((res as Record<string, unknown>).ack).toBe(true);
    expect(calls[0]!.bound[2]).toBe("a value anchor"); // entry_text position
  });

  it("serializes an array `tags` instead of crashing D1", async () => {
    const { env, calls } = fakeEnv();
    const res = await execJournalAdd({ env, req: { companion_id: "cypher", request: "add journal entry", context: JSON.stringify({ entry_text: "x", tags: ["value-anchor", "honesty"] }) } } as never);
    expect((res as Record<string, unknown>).ack).toBe(true);
    const tagsBound = calls[0]!.bound[6]; // tags position in the human_journal insert
    expect(typeof tagsBound).toBe("string");                 // never an object/array
    expect(tagsBound).toBe('["value-anchor","honesty"]');
  });

  it("passes a string `tags` through unchanged", async () => {
    const { env, calls } = fakeEnv();
    await execJournalAdd({ env, req: { companion_id: "cypher", request: "add journal entry", context: JSON.stringify({ content: "x", tags: "single" }) } } as never);
    expect(calls[0]!.bound[6]).toBe("single");
  });

  it("rejects when neither entry_text nor content is present", async () => {
    const { env } = fakeEnv();
    const res = await execJournalAdd({ env, req: { companion_id: "cypher", request: "add journal entry", context: JSON.stringify({ tags: ["x"] }) } } as never);
    expect(String((res as Record<string, unknown>).witness)).toMatch(/entry_text/);
  });

  it("never binds a non-string to the tags column for any input shape", async () => {
    for (const tags of [["a"], "s", undefined, 42, { k: 1 }]) {
      const { env, calls } = fakeEnv();
      await execJournalAdd({ env, req: { companion_id: "cypher", request: "x", context: JSON.stringify({ content: "c", tags }) } } as never);
      const bound = calls[0]?.bound[6];
      expect(bound === null || bound === undefined || typeof bound === "string").toBe(true);
    }
  });
});
