// One session close must enqueue ONE somatic_snapshot job, not two.
//
// `enqueueSomaticSnapshot` is called twice on every Librarian close: once by
// `execSessionClose` (executors/session.ts) and once by `sessionClose`
// (backends/halseth.ts), which the executor itself calls. That is deliberate and its own
// comment says so -- "executor and backend both call this on the Librarian path -- the
// UNIQUE index on dedup_key ensures only one pending/processing job lands per companion."
//
// The collapse only works if both callers derive the SAME dedup_key. On 2026-07-31 the key
// changed from `${companionId}:somatic_snapshot` (per-companion, which meant one soma
// reading per companion for all time) to `${companionId}:${occasion}:somatic_snapshot`.
// Correct on its own terms, and it silently dropped the second guarantee: the backend
// caller passed no sessionId, so it fell through to `new Date().toISOString()`. A timestamp
// occasion can never collide with anything, so it never dedupes -- one close, two jobs.
//
// Found 2026-08-02 by the first real session_close since 07-21, in prod, with the two keys
// visible side by side. Twelve days of no closes is why a bug in the close path could sit
// unnoticed; these tests are so it cannot recur silently.

import { describe, it, expect } from "vitest";
import { enqueueSomaticSnapshot } from "../synthesis/index.js";
import type { Env } from "../types.js";

interface Captured { sql: string; bound: unknown[] }

function fakeEnv(): { env: Env; writes: Captured[] } {
  const writes: Captured[] = [];
  const make = (sql: string, bound: unknown[]) => ({
    bind: (...args: unknown[]) => make(sql, args),
    run: async () => { writes.push({ sql, bound }); return { meta: { changes: 1 } }; },
    first: async () => null,
    all: async () => ({ results: [] }),
  });
  const env = { DB: { prepare: (sql: string) => make(sql, []) } } as unknown as Env;
  return { env, writes };
}

// dedup_key is the 4th bound parameter of the INSERT.
const keyOf = (w: Captured | undefined) => {
  if (!w) throw new Error("expected a captured INSERT, got none");
  return String(w.bound[3]);
};
const at = (writes: Captured[], i: number): Captured => {
  const w = writes[i];
  if (!w) throw new Error(`expected a captured INSERT at index ${i}`);
  return w;
};

describe("enqueueSomaticSnapshot -- dedup key", () => {
  it("keys on the session id when one is supplied", async () => {
    const { env, writes } = fakeEnv();
    await enqueueSomaticSnapshot("cypher", env, "sess-abc");
    expect(keyOf(writes[0])).toBe("cypher:sess-abc:somatic_snapshot");
  });

  it("BOTH close-path callers passing the same session id produce ONE key", async () => {
    // Simulates the real pair: executors/session.ts and backends/halseth.ts, both firing
    // for a single close. Identical keys means INSERT OR IGNORE collapses them.
    const { env, writes } = fakeEnv();
    await enqueueSomaticSnapshot("cypher", env, "sess-abc"); // executor
    await enqueueSomaticSnapshot("cypher", env, "sess-abc"); // backend
    expect(writes).toHaveLength(2);
    expect(new Set(writes.map(keyOf)).size).toBe(1);
    expect(at(writes, 0).sql).toContain("INSERT OR IGNORE");
  });

  it("REPRODUCTION: a caller that omits the session id can never dedupe", async () => {
    // The exact defect. Kept alongside the fix because the failure is invisible without
    // it -- both rows look like legitimate, correctly-keyed jobs.
    const { env, writes } = fakeEnv();
    await enqueueSomaticSnapshot("cypher", env, "sess-abc"); // executor, session-keyed
    await enqueueSomaticSnapshot("cypher", env);             // backend pre-fix, time-keyed
    expect(new Set(writes.map(keyOf)).size).toBe(2);
    expect(keyOf(writes[1])).not.toContain("sess-abc");
  });

  it("still enqueues rather than blocking when there is genuinely no session id", async () => {
    // The timestamp fallback exists on purpose: a caller without a session must not be
    // permanently blocked. Colliding within a second is the accepted cost; never
    // enqueueing again is not. Pinned so a future fix does not delete the fallback.
    const { env, writes } = fakeEnv();
    await enqueueSomaticSnapshot("gaia", env, null);
    await enqueueSomaticSnapshot("gaia", env, "   ");
    expect(writes).toHaveLength(2);
    for (const w of writes) {
      expect(keyOf(w)).toMatch(/^gaia:.+:somatic_snapshot$/);
      expect(keyOf(w)).not.toBe("gaia::somatic_snapshot");
    }
  });
});

describe("the close path wires session_id through to the enqueue", () => {
  it("backends/halseth.ts passes params.session_id (source-level guard)", async () => {
    // A behavioural test would need the whole sessionClose fan-out stood up. This asserts
    // the one thing that regressed: the argument is present at the call site.
    // Plain relative path, resolved from the vitest cwd (the halseth package root).
    // Deliberately NOT `new URL(..., import.meta.url)`: this package compiles against the
    // Workers lib, whose global URL is not structurally node:url's URL, so fs overloads
    // reject it and `tsc --noEmit` fails while vitest passes. Tests green is not build green.
    const { readFileSync, existsSync } = await import("node:fs");
    const path = "src/librarian/backends/halseth.ts";
    expect(existsSync(path), `expected to run from the halseth package root; ${path} not found`).toBe(true);
    const src = readFileSync(path, "utf8");
    const call = src.match(/enqueueSomaticSnapshot\(params\.companionId, env[^)]*\)/);
    expect(call, "enqueueSomaticSnapshot call not found in backends/halseth.ts").toBeTruthy();
    expect(call![0]).toContain("params.session_id");
  });
});
