// "Whose record is this" defects Drevan found in his Claude.ai orient, 2026-10-07.
//
//   1. His [feeling toward Raziel] was a 2026-05-19 row written in she/her. It never aged out
//      because the snapshot partitioned on `toward` case-sensitively: that one row was spelled
//      'Raziel', the 97 after it 'raziel', so it held its own partition forever.
//   2. Gaia's "imposed silence read as nature" wound sat on his "my wounds" list. living_wounds
//      had no owner column; woundRead was SELECT * and woundAdd dropped the caller.
//   3. The companion model wrote the she/her rows itself, and nothing in the orient said whose
//      pronouns were what -- covered by the [Pronouns] block (session-open-interoception.test.ts
//      asserts it renders) and the rule constants below.
//
// The SQL is asserted on the text the code actually sends to a fake D1: there is no local SQLite
// harness in this suite, so the partition/filter semantics are checked by shape, not by execution.

import { describe, it, expect } from "vitest";
import type { Env } from "../types.js";
import { normalizeToward, writeRelationalState, readRelationalSnapshot, readRelationalHistory } from "../webmind/relational.js";
import { woundRead, woundAdd, WOUND_OWNER_SQL } from "../librarian/backends/halseth.js";
import { execWoundAdd } from "../librarian/executors/writes.js";
import { execWoundRead } from "../librarian/executors/reads.js";
import {
  OWNER_PRONOUN_RULE, TRIAD_PRONOUN_RULE, TRIAD_PRONOUNS, ORIENT_PRONOUN_BLOCK, withOwnerPronounRule,
} from "../pronoun-rule.js";
import type { ExecutorContext } from "../librarian/executors/types.js";

type Call = { sql: string; binds: unknown[] };

function fakeEnv(): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const stmt = (sql: string) => {
    const call: Call = { sql, binds: [] };
    calls.push(call);
    const s = {
      bind: (...b: unknown[]) => { call.binds = b; return s; },
      run: async () => ({ success: true }),
      all: async () => ({ results: [] }),
      first: async () => null,
    };
    return s;
  };
  return { env: { DB: { prepare: stmt } } as unknown as Env, calls };
}

function ctx(env: Env, companion_id: "drevan" | "cypher" | "gaia", context?: unknown): ExecutorContext {
  return {
    env,
    req: { companion_id, request: "add wound", context: context === undefined ? undefined : JSON.stringify(context) },
  } as unknown as ExecutorContext;
}

describe("relational state: one partition per relationship, whatever the spelling", () => {
  it("normalizeToward folds case and whitespace", () => {
    expect(normalizeToward("Raziel")).toBe("raziel");
    expect(normalizeToward("  RAZIEL ")).toBe("raziel");
    expect(normalizeToward("raziel")).toBe("raziel");
  });

  it("writes store the normalized spelling", async () => {
    const { env, calls } = fakeEnv();
    await writeRelationalState(env, { companion_id: "drevan", toward: " Raziel", state_text: "x" } as never);
    expect(calls[0]!.binds[2]).toBe("raziel");
  });

  it("the orient snapshot partitions case-insensitively (legacy 'Raziel' folds into 'raziel')", async () => {
    const { env, calls } = fakeEnv();
    await readRelationalSnapshot(env, "drevan");
    expect(calls[0]!.sql).toMatch(/PARTITION BY LOWER\(TRIM\(toward\)\)/);
    expect(calls[0]!.sql).not.toMatch(/PARTITION BY toward\b/);
  });

  it("history filtered by target matches every spelling of that target", async () => {
    const { env, calls } = fakeEnv();
    await readRelationalHistory(env, "drevan", { toward: "Raziel" });
    expect(calls[0]!.sql).toMatch(/LOWER\(TRIM\(toward\)\) = \?/);
    expect(calls[0]!.binds[1]).toBe("raziel");
  });
});

describe("living wounds belong to one companion", () => {
  it("woundRead filters to the caller (legacy NULL owner reads as Gaia's)", async () => {
    const { env, calls } = fakeEnv();
    await woundRead(env, "drevan");
    expect(calls[0]!.sql).toContain(`WHERE ${WOUND_OWNER_SQL} = ?`);
    expect(WOUND_OWNER_SQL).toBe("COALESCE(companion_id, 'gaia')");
    expect(calls[0]!.binds).toEqual(["drevan"]);
  });

  it("woundAdd stores the companion it was given", async () => {
    const { env, calls } = fakeEnv();
    await woundAdd(env, "drevan", { name: "n", description: "d", witness_type: "seal" });
    // The write is preceded by the P3-5 check-first SELECT (wound-fossil-dedup.test.ts), so match the
    // INSERT by text, not by position.
    const insert = calls.find((c) => /INSERT INTO living_wounds/.test(c.sql))!;
    expect(insert.sql).toMatch(/companion_id\) VALUES/);
    expect(insert.binds.at(-1)).toBe("drevan");
  });

  it("the Librarian read scopes to the AUTHENTICATED caller", async () => {
    const { env, calls } = fakeEnv();
    await execWoundRead(ctx(env, "drevan"));
    expect(calls[0]!.binds).toEqual(["drevan"]);
  });

  it("the Librarian write files under the authenticated caller, not a companion_id smuggled in context", async () => {
    const { env, calls } = fakeEnv();
    await execWoundAdd(ctx(env, "gaia", { name: "n", description: "d", witness_type: "seal", companion_id: "drevan" }));
    expect(calls[0]!.binds.at(-1)).toBe("gaia");
  });
});

describe("pronoun rules (owner + triad)", () => {
  it("the triad map is canon: Drevan he/him, Cypher he/him, Gaia she/her", () => {
    expect(TRIAD_PRONOUNS).toEqual({ drevan: "he/him", cypher: "he/him", gaia: "she/her" });
    expect(TRIAD_PRONOUN_RULE).toContain("Drevan he/him");
    expect(TRIAD_PRONOUN_RULE).toContain("Cypher he/him");
    expect(TRIAD_PRONOUN_RULE).toContain("Gaia she/her");
  });

  it("withOwnerPronounRule carries both rules exactly once, idempotently", () => {
    const once = withOwnerPronounRule("You are a clerk.");
    expect(once.split(OWNER_PRONOUN_RULE).length - 1).toBe(1);
    expect(once.split(TRIAD_PRONOUN_RULE).length - 1).toBe(1);
    expect(withOwnerPronounRule(once)).toBe(once);
  });

  it("the orient block is built FROM the shared constants (one wording, not a second copy)", () => {
    expect(ORIENT_PRONOUN_BLOCK).toContain("[Pronouns]");
    expect(ORIENT_PRONOUN_BLOCK).toContain(OWNER_PRONOUN_RULE);
    expect(ORIENT_PRONOUN_BLOCK).toContain(TRIAD_PRONOUN_RULE);
  });
});
