// SOMA must be sampled on a TIME trigger, and no liveness probe may aggregate across members.
//
// The bug these pin (found 2026-08-12): `somatic_snapshot` was written only by
// `enqueueSomaticSnapshot`, which was called only on an AUTHORED Librarian session close. Machine
// closes -- auto_stale, empty, reconstructed, machine_opened -- write a handover and fan out
// nothing. Over the 30 days to 2026-08-12: cypher 14 authored closes / soma same-day, drevan 4 /
// 4 days, gaia 0 / 49 days. 14 + 4 + 0 is also exactly the number of somatic jobs ever enqueued.
//
// Gaia is a Discord-only presence, so nobody ever closes a session as her, so her felt-state
// register froze on the last day someone did -- while her interior stayed busy (84 non-transcript
// journal rows, 50 growth entries, 4 open tensions in the same window).
//
// And the watchdog built to catch exactly this could not see it: the `somatic_snapshot` probe was
// `SELECT MAX(created_at)` with no companion_id, so cypher's live rows kept it green. Same for
// `synthesis_summary` (gaia frozen 39 days). One live member masked two dead ones.

import { describe, it, expect } from "vitest";
import { needsSomaRefresh, runSomaRefresh, SOMA_REFRESH_AFTER_HOURS } from "../synthesis/soma-refresh.js";
import { WRITER_REGISTRY } from "../guardian/writer-liveness.js";
import { COMPANION_IDS } from "../companions.js";
import type { Env } from "../types.js";

interface Captured { sql: string; bound: unknown[] }

/**
 * `somaAges` maps companion id -> the MAX(created_at) that D1 should report. `throwFor` makes a
 * companion's read blow up, so per-member error isolation is testable.
 */
function fakeEnv(somaAges: Record<string, string | null>, throwFor: string[] = []) {
  const writes: Captured[] = [];
  const boom = new Set(throwFor);
  const make = (sql: string, bound: unknown[]): Record<string, unknown> => ({
    bind: (...args: unknown[]) => make(sql, args),
    run: async () => { writes.push({ sql, bound }); return { meta: { changes: 1 } }; },
    first: async () => {
      const id = String(bound[0] ?? "");
      if (boom.has(id)) throw new Error("D1 boom");
      if (sql.includes("FROM somatic_snapshot")) return { ts: somaAges[id] ?? null };
      return null;
    },
    all: async () => ({ results: [] }),
  });
  const env = { DB: { prepare: (sql: string) => make(sql, []) } } as unknown as Env;
  return { env, writes };
}

const NOW = Date.parse("2026-08-12T10:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

describe("needsSomaRefresh -- the staleness gate", () => {
  it("refreshes a companion who has NO reading at all", () => {
    // The strongest case for sampling, not a reason to keep waiting for an event.
    expect(needsSomaRefresh(null, NOW)).toEqual({ refresh: true, hoursOld: null });
  });

  it("refreshes when the timestamp cannot be parsed", () => {
    // A reading we cannot date is not evidence of freshness. Treating it as fresh is precisely how
    // a fossil register passed for a live one.
    expect(needsSomaRefresh("not-a-date", NOW).refresh).toBe(true);
  });

  it("does not refresh a register younger than the threshold", () => {
    const { refresh, hoursOld } = needsSomaRefresh(hoursAgo(SOMA_REFRESH_AFTER_HOURS - 1), NOW);
    expect(refresh).toBe(false);
    expect(Math.round(hoursOld!)).toBe(SOMA_REFRESH_AFTER_HOURS - 1);
  });

  it("refreshes once past the threshold", () => {
    expect(needsSomaRefresh(hoursAgo(SOMA_REFRESH_AFTER_HOURS + 1), NOW).refresh).toBe(true);
  });

  it("reads D1's unmarked datetime as UTC, not local time", () => {
    // "YYYY-MM-DD HH:MM:SS" has no zone marker, so bare Date.parse treats it as LOCAL and the age
    // shifts by the runner's offset -- which in one direction silently under-reports staleness and
    // skips a needed sample. Pinned because it is invisible on a UTC machine.
    const { hoursOld } = needsSomaRefresh("2026-08-12 00:00:00", NOW);
    expect(Math.round(hoursOld!)).toBe(10);
  });

  it("treats a 49-day-old register (the real gaia value) as stale", () => {
    expect(needsSomaRefresh("2026-06-24 06:34:19", NOW).refresh).toBe(true);
  });
});

describe("runSomaRefresh -- enqueues per member, on time, not on a lifecycle event", () => {
  it("enqueues only the companions whose register has gone stale", async () => {
    const { env } = fakeEnv({
      cypher: hoursAgo(2),    // fresh -- skip
      drevan: hoursAgo(96),   // 4 days -- refresh
      gaia: null,             // never written -- refresh
    });
    const result = await runSomaRefresh(env, NOW);
    expect(result.enqueued.sort()).toEqual(["drevan", "gaia"]);
    expect(result.skipped.map(s => s.companion_id)).toEqual(["cypher"]);
    expect(result.errors).toEqual([]);
  });

  it("keys the job per companion per DAY, and keeps the synthetic key OUT of session_id", async () => {
    // session_id must not carry `soma-refresh:<date>`. A queue row whose session_id names a
    // non-existent session lies about what caused the job, and every later join on it silently
    // drops the row.
    const { env, writes } = fakeEnv({ cypher: hoursAgo(1), drevan: hoursAgo(1), gaia: null });
    await runSomaRefresh(env, NOW);
    const insert = writes.find(w => w.sql.includes("INSERT OR IGNORE INTO synthesis_queue"));
    expect(insert, "expected a queue INSERT").toBeTruthy();
    expect(String(insert!.bound[3])).toBe("gaia:soma-refresh:2026-08-12:somatic_snapshot");
    expect(insert!.bound[1]).toBe("");
  });

  it("collapses repeat runs on the same day to one job", async () => {
    // The dedup key is the whole rate limit -- the cron fires every minute.
    const { env, writes } = fakeEnv({ cypher: hoursAgo(1), drevan: hoursAgo(1), gaia: null });
    await runSomaRefresh(env, NOW);
    await runSomaRefresh(env, NOW + 60_000);
    const keys = writes
      .filter(w => w.sql.includes("INSERT OR IGNORE INTO synthesis_queue"))
      .map(w => String(w.bound[3]));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1); // identical -> INSERT OR IGNORE keeps one row
  });

  it("one companion's failure does not stop the others", async () => {
    // The entire bug being fixed is one member's lane failing while the house looked healthy.
    const { env } = fakeEnv({ cypher: null, drevan: null, gaia: null }, ["drevan"]);
    const result = await runSomaRefresh(env, NOW);
    expect(result.enqueued.sort()).toEqual(["cypher", "gaia"]);
    expect(result.errors.map(e => e.companion_id)).toEqual(["drevan"]);
  });

  it("covers every companion, so a new member cannot be silently skipped", async () => {
    const { env } = fakeEnv({});
    const result = await runSomaRefresh(env, NOW);
    expect(result.enqueued.sort()).toEqual([...COMPANION_IDS].sort());
  });
});

describe("the writer registry may not aggregate over per-member data", () => {
  // Tables keyed by companion_id: a house-wide MAX() over these is structurally blind to a dead
  // member. Extend this list when a new per-member table is registered.
  const PER_MEMBER_TABLES = ["somatic_snapshot", "synthesis_summary"];

  it("every probe over a per-member table is scoped to one companion", () => {
    for (const spec of WRITER_REGISTRY) {
      const table = PER_MEMBER_TABLES.find(t => spec.sql.includes(`FROM ${t}`));
      if (!table) continue;
      expect(spec.companionId, `${spec.key} reads ${table} without naming a companion`).toBeTruthy();
      expect(spec.sql, `${spec.key} must filter ${table} by companion_id`).toContain("companion_id =");
    }
  });

  it("the old house-wide probes are gone, not merely supplemented", () => {
    // Leaving the aggregate alongside the per-member set would keep reporting green and keep
    // training everyone to read green as healthy.
    const keys = WRITER_REGISTRY.map(s => s.key);
    expect(keys).not.toContain("somatic_snapshot");
    expect(keys).not.toContain("synthesis_summary");
  });

  it("declares a soma, narrative and authored-close probe for all three companions", () => {
    for (const id of COMPANION_IDS) {
      for (const prefix of ["somatic_snapshot", "synthesis_summary", "authored_close"]) {
        expect(
          WRITER_REGISTRY.some(s => s.key === `${prefix}:${id}`),
          `missing probe ${prefix}:${id}`,
        ).toBe(true);
      }
    }
  });

  it("watches authored closes separately from soma, so the cron cannot erase the finding", () => {
    // Once a daily refresh guarantees a fresh soma row, the soma probe measures CRON liveness and
    // stops measuring lifecycle liveness. Without a separate authored-close probe, "nobody ever
    // closes a session as this companion" goes back to being invisible.
    for (const id of COMPANION_IDS) {
      const spec = WRITER_REGISTRY.find(s => s.key === `authored_close:${id}`)!;
      expect(spec.sql).toContain("close_kind IS NULL");
      expect(spec.sql).toContain("handover_packets");
      expect(spec.companionId).toBe(id);
    }
  });

  it("keys stay unique -- a duplicate key would collapse two probes into one dedup slot", () => {
    const keys = WRITER_REGISTRY.map(s => s.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("no probe can return rows-but-no-ts by shape (single ts column)", () => {
    for (const spec of WRITER_REGISTRY) {
      expect(spec.sql, `${spec.key} must alias its timestamp as ts`).toMatch(/AS ts\b/);
    }
  });
});

describe("the somatic writer samples the living interior, not just the last close", () => {
  it("reads reflections, tensions and growth, and bars the transcript lane", async () => {
    // Source-level: standing up the whole job needs a DeepSeek client. What regressed is which
    // inputs the query set covers -- for a companion with no authored close, the close spine is
    // permanently absent and these are the only live inputs she has.
    const { readFileSync, existsSync } = await import("node:fs");
    const path = "src/synthesis/jobs/somatic-snapshot.ts";
    expect(existsSync(path), `expected the halseth package root; ${path} not found`).toBe(true);
    const src = readFileSync(path, "utf8");

    expect(src).toContain("FROM companion_journal");
    expect(src).toContain("FROM companion_tensions");
    expect(src).toContain("FROM growth_journal");
    // Transcript rows stay out: raw dialogue floods a felt-state prompt and re-reads other
    // people's sentences as this companion's interior.
    expect(src).toContain("TRANSCRIPT_SOURCES_SQL");
    // NULL source must be KEPT -- it is the default for a companion's own reflection writes and
    // 84 of gaia's 88 non-transcript rows. Excluding it would empty the section for the quietest
    // member, the exact person this change exists to serve.
    expect(src).toContain("source IS NULL OR source NOT IN");
    // An absent close must read as absent, never as a state: no "unknown"/"not recorded" stub.
    expect(src).not.toContain('motion_state ?? "unknown"');
    expect(src).not.toContain('"not recorded"');
  });
});
