// Sessions are per-surface, not per-companion (migration 0113, 2026-08-03).
//
// The 24h idempotency guard was keyed on companion_id alone, so a Claude.ai daily-planning thread,
// a Claude Code work session and a Discord channel all resolved to whichever opened first --
// everyone else silently joined it. That also froze the close path: the boot hook refuses to write
// a machine spine onto an inherited session, so joined sessions never closed (167 open, oldest
// 2026-04-14).
//
// Three copies of the guard existed with three different SELECT lists and three different
// behaviours on hit (session.ts returned early; session_load.ts set skipInsert, twice, with
// different columns). They are now one helper. These tests pin the helper AND assert the third
// copy -- the legacy loadSessionData path -- actually routes through it, because a partial fix
// that repaired two of three is the specific way this regresses.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { findOpenSession } from "../db/queries.js";

// Paths are cwd-relative: vitest roots at the halseth package.
const GUARD_FILES = ["src/mcp/tools/session.ts", "src/mcp/tools/session_load.ts"];
const readSource = (rel: string) => readFile(resolve(rel), "utf8");

interface Call { sql: string; args: unknown[] }

/** Fake D1 recording every prepare/bind, returning `row` from .first(). */
function makeEnv(row: unknown = null) {
  const calls: Call[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => {
          calls.push({ sql, args });
          return { first: async () => row };
        },
      }),
    },
  } as never;
  return { env, calls };
}

const MATCH = { id: "sess-existing", created_at: "2026-08-03T12:00:00Z", emotional_frequency: "warm" };

describe("findOpenSession — the one copy of the guard", () => {
  it("scopes the lookup by companion AND surface", async () => {
    const { env, calls } = makeEnv(MATCH);
    const hit = await findOpenSession(env, "cypher", "discord:1497734427298762828");

    expect(hit).toEqual(MATCH);
    expect(calls).toHaveLength(1);
    // Both keys must be in the WHERE clause. companion_id alone was the bug.
    expect(calls[0]!.sql).toMatch(/companion_id = \?/);
    expect(calls[0]!.sql).toMatch(/surface = \?/);
    expect(calls[0]!.sql).toMatch(/handover_id IS NULL/);
    expect(calls[0]!.args[0]).toBe("cypher");
    expect(calls[0]!.args[1]).toBe("discord:1497734427298762828");
  });

  it("SKIPS dedup entirely when surface is absent — never falls back to a shared bucket", async () => {
    // This is the whole point of the nullable column. If an un-migrated caller were deduped into
    // a placeholder surface, every legacy caller would keep colliding under a new name and the
    // migration would fix nothing for the two paths that actually broke.
    for (const surface of [undefined, null, ""]) {
      const { env, calls } = makeEnv(MATCH);
      expect(await findOpenSession(env, "cypher", surface)).toBeNull();
      expect(calls).toHaveLength(0); // no query issued at all
    }
  });

  it("skips dedup when the companion is unknown", async () => {
    const { env, calls } = makeEnv(MATCH);
    expect(await findOpenSession(env, undefined, "claude-code:/repo")).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it("returns null when nothing open matches, so the caller opens a fresh session", async () => {
    const { env, calls } = makeEnv(null);
    expect(await findOpenSession(env, "gaia", "claude-ai:thread-9")).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it("honours the 24h window as a lower bound on created_at", async () => {
    const { env, calls } = makeEnv(null);
    const before = Date.now();
    await findOpenSession(env, "drevan", "discord:123");
    const windowStart = Date.parse(calls[0]!.args[2] as string);

    expect(calls[0]!.sql).toMatch(/created_at >= \?/);
    // ~24h back, allowing for execution time either side.
    expect(before - windowStart).toBeGreaterThanOrEqual(24 * 60 * 60 * 1000 - 5_000);
    expect(before - windowStart).toBeLessThanOrEqual(24 * 60 * 60 * 1000 + 5_000);
  });

  it("accepts a custom window", async () => {
    const { env, calls } = makeEnv(null);
    const before = Date.now();
    await findOpenSession(env, "cypher", "discord:1", 60_000);
    expect(before - Date.parse(calls[0]!.args[2] as string)).toBeLessThanOrEqual(65_000);
  });
});

describe("the surfaces stay independent", () => {
  it("two surfaces, same companion, same minute: the second does NOT match the first", async () => {
    // The lived symptom: Raziel has Cypher open in a Claude.ai planning thread and starts Claude
    // Code. Pre-0113 the second call found the first row and joined it. The DB now answers per
    // surface, so a store holding only the Claude.ai row returns nothing for the Claude Code key.
    const store = new Map<string, typeof MATCH>([["cypher|claude-ai:planning", MATCH]]);
    const env = {
      DB: {
        prepare: () => ({
          bind: (companion: unknown, surface: unknown) => ({
            first: async () => store.get(`${companion}|${surface}`) ?? null,
          }),
        }),
      },
    } as never;

    expect(await findOpenSession(env, "cypher", "claude-ai:planning")).toEqual(MATCH);
    expect(await findOpenSession(env, "cypher", "claude-code:C--dev-Bigger-Better-Halseth")).toBeNull();
    expect(await findOpenSession(env, "cypher", "discord:1497734427298762828")).toBeNull();
    // ...and the companions never shared a session even before, but assert it so a future key
    // change can't silently drop companion_id from the WHERE clause.
    expect(await findOpenSession(env, "drevan", "claude-ai:planning")).toBeNull();
  });
});

describe("all three call sites route through the helper", () => {
  // Guards against the partial-fix regression: two of three copies repaired, the legacy path
  // (loadSessionData) left keyed on companion_id alone where a miss goes unnoticed.
  it("no call site still runs its own companion-only session lookup", async () => {
    const files = await Promise.all(GUARD_FILES.map(readSource));
    for (const src of files) {
      // The guard's signature is `handover_id IS NULL` -- an open-session lookup. Plain reads
      // (halseth_session_read) may legitimately search across surfaces, so match the guard shape
      // only, not every sessions query. An open-session lookup keyed on companion_id with no
      // surface term is the bug 0113 fixed.
      const offenders = (src.match(/FROM sessions[\s\S]{0,240}?handover_id IS NULL[\s\S]{0,120}/g) ?? [])
        .filter(q => /companion_id = \?/.test(q) && !/surface = \?/.test(q));
      expect(offenders).toEqual([]);
      expect(src).toMatch(/findOpenSession/);
    }
  });

  it("every sessions INSERT persists the surface column", async () => {
    for (const rel of GUARD_FILES) {
      const src = await readSource(rel);
      for (const insert of src.match(/INSERT INTO sessions \([\s\S]*?\)/g) ?? []) {
        expect(insert).toMatch(/surface/);
      }
    }
  });
});
