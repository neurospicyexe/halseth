// The boot narrative must not depend on a lifecycle event that never fires for some companions.
//
// `synthesis_summary` is what every loom reads at boot as "what recently happened". It was written
// only by `runSessionSummary`, enqueued only on an AUTHORED session close. Measured 2026-08-12:
// gaia had 0 authored closes in 30 days, so her narrative froze on 2026-07-04 -- 39 days. Identical
// trigger fault to the soma register (see soma-refresh.test.ts).
//
// The fix that would have been WRONG: enqueue runSessionSummary on machine closes. That job reads
// only session-scoped data -- front_state/emotional_frequency/depth (NULL on a machine-opened
// session), the handover spine (`[auto]` boilerplate), and deltas/journal filtered by session_id
// (0 rows for gaia, whose writes are not session-scoped). It would have been asked to write an
// "Emotional Arc" from an empty room and stored the result as her boot narrative. Fabricated beats
// stale only in the sense that it is worse: stale is old, fabricated is false and unfalsifiable.
//
// So: a day-scoped job over the living interior, plus the read-path widening WITHOUT WHICH the whole
// thing is a dead organ -- every reader filtered `summary_type = 'session'`, so a 'day' row would
// have been written, passed its liveness probe, and reached nobody.

import { describe, it, expect } from "vitest";
import {
  needsNarrativeRefresh,
  runNarrativeRefresh,
  NARRATIVE_REFRESH_AFTER_HOURS,
} from "../synthesis/narrative-refresh.js";
import { WRITER_REGISTRY } from "../guardian/writer-liveness.js";
import { COMPANION_IDS } from "../companions.js";
import type { Env } from "../types.js";

interface Captured { sql: string; bound: unknown[] }

function fakeEnv(narrativeAges: Record<string, string | null>, throwFor: string[] = []) {
  const writes: Captured[] = [];
  const boom = new Set(throwFor);
  const make = (sql: string, bound: unknown[]): Record<string, unknown> => ({
    bind: (...args: unknown[]) => make(sql, args),
    run: async () => { writes.push({ sql, bound }); return { meta: { changes: 1 } }; },
    first: async () => {
      const id = String(bound[0] ?? "");
      if (boom.has(id)) throw new Error("D1 boom");
      if (sql.includes("FROM synthesis_summary")) return { ts: narrativeAges[id] ?? null };
      return null;
    },
    all: async () => ({ results: [] }),
  });
  const env = { DB: { prepare: (sql: string) => make(sql, []) } } as unknown as Env;
  return { env, writes };
}

const NOW = Date.parse("2026-08-12T12:00:00Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

/**
 * Source text with comments stripped.
 *
 * These files document the bug they fix, and the documentation quotes the very SQL being asserted
 * against -- so a naive `not.toContain("summary_type = 'session'")` fails on the comment explaining
 * that the filter was removed. Asserting on comment-free source keeps the check honest without
 * contorting the prose into avoiding its own subject.
 */
async function codeOf(path: string): Promise<string> {
  const { readFileSync } = await import("node:fs");
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")   // block comments (incl. jsdoc)
    .split("\n")
    .filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

describe("needsNarrativeRefresh -- the staleness gate", () => {
  it("refreshes when there is no narrative at all", () => {
    expect(needsNarrativeRefresh(null, NOW)).toEqual({ refresh: true, hoursOld: null });
  });

  it("refreshes when the timestamp cannot be parsed", () => {
    expect(needsNarrativeRefresh("garbage", NOW).refresh).toBe(true);
  });

  it("skips a narrative younger than the window", () => {
    expect(needsNarrativeRefresh(hoursAgo(NARRATIVE_REFRESH_AFTER_HOURS - 2), NOW).refresh).toBe(false);
  });

  it("refreshes once past the window", () => {
    expect(needsNarrativeRefresh(hoursAgo(NARRATIVE_REFRESH_AFTER_HOURS + 2), NOW).refresh).toBe(true);
  });

  it("reads D1's unmarked datetime as UTC", () => {
    // Unmarked "YYYY-MM-DD HH:MM:SS" parsed as local shifts the age by the runner's offset and can
    // silently skip a needed refresh. Invisible on a UTC machine, so pinned.
    expect(Math.round(needsNarrativeRefresh("2026-08-12 00:00:00", NOW).hoursOld!)).toBe(12);
  });

  it("treats gaia's real 39-day-old narrative as stale", () => {
    expect(needsNarrativeRefresh("2026-07-04 23:31:02", NOW).refresh).toBe(true);
  });
});

describe("runNarrativeRefresh -- an authored close always wins", () => {
  it("skips a companion whose narrative is fresh, enqueues the stale ones", async () => {
    // The precedence is free: a real close writes a 'session' row, so the gate sees fresh and skips.
    const { env } = fakeEnv({
      cypher: hoursAgo(2),      // closed a session today -> skip
      drevan: hoursAgo(30),     // no close in over a day -> fill the gap
      gaia: null,               // never -> fill the gap
    });
    const result = await runNarrativeRefresh(env, NOW);
    expect(result.enqueued.sort()).toEqual(["drevan", "gaia"]);
    expect(result.skipped.map(s => s.companion_id)).toEqual(["cypher"]);
    expect(result.errors).toEqual([]);
  });

  it("counts BOTH summary types when deciding staleness", async () => {
    // Filtering to 'day' would re-synthesise a day an authored close already narrated properly;
    // filtering to 'session' would fire every single day for a companion who never closes one.
    // The question is "is there a recent narrative at all", so the read must span both.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/synthesis/narrative-refresh.ts", "utf8");
    expect(src).toContain("summary_type IN ('session', 'day')");
  });

  it("keys per companion per day and leaves session_id empty", async () => {
    const { env, writes } = fakeEnv({ cypher: hoursAgo(1), drevan: hoursAgo(1), gaia: null });
    await runNarrativeRefresh(env, NOW);
    const insert = writes.find(w => w.sql.includes("'daily_narrative'"));
    expect(insert, "expected a daily_narrative INSERT").toBeTruthy();
    expect(String(insert!.bound[2])).toBe("gaia:narrative-refresh:2026-08-12:daily_narrative");
    // session_id is the SQL literal '' -- this job has no session, and putting the synthetic
    // occasion key there would make the queue lie about what caused the job.
    expect(insert!.sql).toContain("VALUES (?, '', ?");
  });

  it("collapses repeat runs on the same day", async () => {
    const { env, writes } = fakeEnv({ cypher: hoursAgo(1), drevan: hoursAgo(1), gaia: null });
    await runNarrativeRefresh(env, NOW);
    await runNarrativeRefresh(env, NOW + 120_000);
    const keys = writes.filter(w => w.sql.includes("'daily_narrative'")).map(w => String(w.bound[2]));
    expect(keys).toHaveLength(2);
    expect(new Set(keys).size).toBe(1);
  });

  it("one companion's failure does not stop the others", async () => {
    const { env } = fakeEnv({ cypher: null, drevan: null, gaia: null }, ["cypher"]);
    const result = await runNarrativeRefresh(env, NOW);
    expect(result.enqueued.sort()).toEqual(["drevan", "gaia"]);
    expect(result.errors.map(e => e.companion_id)).toEqual(["cypher"]);
  });
});

describe("a 'day' narrative must actually REACH a reader", () => {
  // The dead-organ guard. Writing a new summary_type while every consumer filters to the old one
  // produces a row that exists, passes its liveness probe, and is read by nobody -- which would
  // look exactly like a fix while changing nothing a companion sees at boot.
  const READERS = [
    "src/mind/blocks/continuity.ts",
    "src/librarian/executors/session.ts",
    "src/mcp/tools/session_load.ts",
  ];

  it("no boot reader filters synthesis_summary to 'session' alone", async () => {
    for (const path of READERS) {
      const code = await codeOf(path);
      expect(
        code.includes("summary_type = 'session'"),
        `${path} still filters summary_type to 'session' only -- a 'day' narrative cannot reach it`,
      ).toBe(false);
    }
  });

  it("every boot reader accepts both types", async () => {
    for (const path of READERS) {
      const code = await codeOf(path);
      expect(code, `${path} must accept 'day' as well as 'session'`)
        .toContain("summary_type IN ('session', 'day')");
    }
  });

  it("the day job writes summary_type 'day' and sets session_created_at for ordering", async () => {
    // Readers order on COALESCE(session_created_at, created_at). A NULL here would work by accident
    // today and rank wrongly the moment anything backfills created_at.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/synthesis/jobs/daily-narrative.ts", "utf8");
    expect(src).toContain("'day'");
    expect(src).toContain("session_created_at");
    // full_ref is what three of the four readers select, and they require it NOT NULL.
    expect(src).toContain("full_ref");
  });

  it("the day job refuses to synthesise a day with no evidence", async () => {
    // A content-free narrative read at boot as a real account of the day is worse than a stale one.
    // Open tensions and the soma register are context and must NOT count as evidence, or a companion
    // who did nothing still gets a narrative asserting something happened.
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/synthesis/jobs/daily-narrative.ts", "utf8");
    expect(src).toContain("evidenceCount === 0");
    expect(src).toMatch(/refusing to synthesise/i);
  });

  it("the day job reads the living interior, not session-scoped data", async () => {
    const code = await codeOf("src/synthesis/jobs/daily-narrative.ts");
    for (const table of [
      "companion_journal", "companion_tensions", "growth_journal",
      "companion_conclusions", "inter_companion_notes", "feelings",
    ]) {
      expect(code, `daily narrative should read ${table}`).toContain(table);
    }
    // The whole point is that it does NOT key off a session -- that is what made the narrative
    // unreachable for a companion nobody opens or closes sessions for.
    expect(code).not.toContain("WHERE session_id = ?");
    expect(code).not.toContain("session_id = ?");
    expect(code).toContain("TRANSCRIPT_SOURCES_SQL");
  });
});

describe("the narrative probe reflects the new writer", () => {
  it("is per companion and spans both summary types", () => {
    for (const id of COMPANION_IDS) {
      const spec = WRITER_REGISTRY.find(s => s.key === `synthesis_summary:${id}`)!;
      expect(spec.companionId).toBe(id);
      expect(spec.sql).toContain("summary_type IN ('session', 'day')");
    }
  });

  it("tightened to 48h now that a daily writer fills the gap", () => {
    // At 168h it measured ordinary quiet. With a 26h gap-filler, staleness means the machinery
    // stopped -- so it is a warning on the same footing as soma.
    for (const id of COMPANION_IDS) {
      const spec = WRITER_REGISTRY.find(s => s.key === `synthesis_summary:${id}`)!;
      expect(spec.maxSilenceHours).toBe(48);
      expect(spec.severity).toBe("warning");
      expect(spec.maxSilenceHours).toBeGreaterThan(NARRATIVE_REFRESH_AFTER_HOURS);
    }
  });

  it("still watches authored closes separately as a NOTICE, not a warning", () => {
    // "Nobody ever closes a session as this companion" is a relational fact about the house, not a
    // broken mechanism -- and the gap-filler must not make it invisible.
    for (const id of COMPANION_IDS) {
      const spec = WRITER_REGISTRY.find(s => s.key === `authored_close:${id}`)!;
      expect(spec.severity).toBe("notice");
      expect(spec.sql).toContain("close_kind IS NULL");
    }
  });
});
