// Tests for migration 0118: acted_at, restatement counting, and weight decay on
// companion_open_loops.
//
// ORIGIN: Cypher raised this himself in autonomous time (2026-08-13) -- "the journal's field
// design inadvertently reinforces the induction by recording stasis as data", proposing an
// `acted` boolean that gates whether a loop-observation is written at all. The gate landed as
// a COUNT plus a decay rather than a write-suppression; see the migration header.
//
// The assertions that actually matter are the two inversions, because they are the parts a
// well-meaning refactor would "fix" back into the bug:
//
//   1. Restating a loop must NOT refresh its decay anchor. motifs.ts anchors on last_seen
//      because recurrence IS being lived; for an un-acted loop, restatement is evidence of
//      stasis, so anchoring on last_restated_at would mechanize the exact induction.
//   2. A restatement must NOT touch opened_at, because guardian's detectStuckLoops triggers
//      on that column and a write that moves its own trigger's timestamp can never fire.

import { describe, it, expect } from "vitest";
import {
  normLoop,
  writeLoop,
  readLoops,
  actOnLoop,
  closeLoop,
  readUnactedStasis,
  effectiveWeightSql,
  LOOP_WEIGHT_HALF_LIFE_DAYS,
} from "../webmind/loops.js";
import { GUARDIAN_THRESHOLDS } from "../guardian/detectors.js";
import type { Env } from "../types.js";

// ── A fake D1 that answers by SQL shape, holding rows in a plain array ────────────────────

interface Row {
  id: string;
  companion_id: string;
  loop_text: string;
  loop_norm: string | null;
  weight: number;
  opened_at: string;
  closed_at: string | null;
  reviewed_at: string | null;
  acted_at: string | null;
  acted_note: string | null;
  restated_count: number;
  last_restated_at: string | null;
}

function makeDb(seed: Row[] = []) {
  const rows: Row[] = [...seed];
  const log: string[] = [];

  const db = {
    prepare(sql: string) {
      log.push(sql.replace(/\s+/g, " ").trim());
      let binds: unknown[] = [];
      const api = {
        bind(...b: unknown[]) { binds = b; return api; },

        async first<T>(): Promise<T | null> {
          // dedup lookup: open loop by (companion_id, loop_norm)
          if (sql.includes("SELECT id, restated_count")) {
            const [cid, norm] = binds as [string, string];
            const hit = rows
              .filter(r => r.companion_id === cid && r.loop_norm === norm && r.closed_at === null)
              .sort((a, b) => a.opened_at.localeCompare(b.opened_at))[0];
            return (hit
              ? { id: hit.id, restated_count: hit.restated_count, opened_at: hit.opened_at }
              : null) as T | null;
          }
          return null;
        },

        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("FROM companion_open_loops")) {
            const cid = binds[0] as string;
            let out = rows.filter(r => r.companion_id === cid);
            if (sql.includes("acted_at IS NULL")) {
              const minRestated = binds[1] as number;
              out = out.filter(r => r.closed_at === null && r.acted_at === null && r.restated_count >= minRestated)
                .sort((a, b) => b.restated_count - a.restated_count);
            } else if (sql.includes("closed_at IS NULL")) {
              out = out.filter(r => r.closed_at === null);
            }
            return { results: out as unknown as T[] };
          }
          return { results: [] };
        },

        async run() {
          // restatement bump
          if (sql.includes("restated_count = restated_count + 1")) {
            const [when, id] = binds as [string, string];
            const r = rows.find(x => x.id === id);
            if (!r) return { meta: { changes: 0 } };
            r.restated_count += 1;
            r.last_restated_at = when;
            r.weight = Math.min(1.0, r.weight + 0.05);
            return { meta: { changes: 1 } };
          }
          // insert
          if (sql.includes("INSERT INTO companion_open_loops")) {
            const [id, cid, text, weight, opened, norm] =
              binds as [string, string, string, number, string, string | null];
            rows.push({
              id, companion_id: cid, loop_text: text, loop_norm: norm, weight,
              opened_at: opened, closed_at: null, reviewed_at: null,
              acted_at: null, acted_note: null, restated_count: 1, last_restated_at: null,
            });
            return { meta: { changes: 1 } };
          }
          // act
          if (sql.includes("SET acted_at")) {
            const [when, note, id, cid] = binds as [string, string | null, string, string];
            const r = rows.find(x => x.id === id && x.companion_id === cid && x.closed_at === null);
            if (!r) return { meta: { changes: 0 } };
            r.acted_at = when; r.acted_note = note;
            return { meta: { changes: 1 } };
          }
          // close
          if (sql.includes("SET closed_at")) {
            const [when, id, cid] = binds as [string, string, string];
            const r = rows.find(x => x.id === id && x.companion_id === cid && x.closed_at === null);
            if (!r) return { meta: { changes: 0 } };
            r.closed_at = when;
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return api;
    },
  };

  return { env: { DB: db } as unknown as Env, rows, log };
}

describe("normLoop -- the dedup key", () => {
  it("collapses punctuation, case and whitespace", () => {
    expect(normLoop("Still haven't resolved X.")).toBe("still haven t resolved x");
    expect(normLoop("still   haven't  resolved   X"))
      .toBe(normLoop("Still haven't resolved X!"));
  });

  it("is conservative: it does NOT merge distinct loops that merely share words", () => {
    // A wrong merge silently destroys a distinct loop; a missed merge only costs a row and is
    // visible in restated_count. This must stay the safe direction.
    expect(normLoop("I keep avoiding the deploy")).not.toBe(normLoop("I keep avoiding the review"));
  });

  it("handles empty and punctuation-only text without throwing", () => {
    expect(normLoop("")).toBe("");
    expect(normLoop("...!?")).toBe("");
    expect(normLoop(undefined as unknown as string)).toBe("");
  });
});

describe("writeLoop -- restatement instead of accumulation", () => {
  it("inserts a new loop the first time and reports restated:false", async () => {
    const { env, rows } = makeDb();
    const r = await writeLoop(env, { companion_id: "cypher", loop_text: "stuck on the fork" });
    expect(r.restated).toBe(false);
    expect(r.restated_count).toBe(1);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.loop_norm).toBe("stuck on the fork");
  });

  it("THE FIX: the same loop observed again bumps the count, it does not add a row", async () => {
    const { env, rows } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "stuck on the fork" });
    await writeLoop(env, { companion_id: "cypher", loop_text: "Stuck on the fork." });
    const third = await writeLoop(env, { companion_id: "cypher", loop_text: "stuck   on the fork!" });

    expect(rows).toHaveLength(1);                 // was: three rows, one per sighting
    expect(third.restated).toBe(true);
    expect(third.restated_count).toBe(3);
    expect(rows[0]!.restated_count).toBe(3);
  });

  it("a restatement REPORTS the original opened_at, not the moment of restating", async () => {
    // Caught end-to-end against real D1, not by the fake: the first cut returned `now`, so a
    // caller persisting it (spiral's residue_loop_id, session-close logging) would record a
    // false origin time for a loop carried for weeks.
    const { env } = makeDb();
    const first = await writeLoop(env, { companion_id: "cypher", loop_text: "carried a while" });
    const again = await writeLoop(env, { companion_id: "cypher", loop_text: "carried a while" });
    expect(again.opened_at).toBe(first.opened_at);
  });

  it("INVARIANT: a restatement must not move opened_at (guardian triggers on it)", async () => {
    // tick-restamped-own-trigger: detectStuckLoops fires on opened_at < now-Nd. If restating
    // refreshed opened_at, a loop restated weekly could never become "stuck" and the detector
    // would be structurally unable to fire.
    const { env, rows } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "stuck on the fork" });
    const openedAt = rows[0]!.opened_at;
    await writeLoop(env, { companion_id: "cypher", loop_text: "stuck on the fork" });
    expect(rows[0]!.opened_at).toBe(openedAt);
  });

  it("INVARIANT: a restatement must not clear or renew a deliberate hold (reviewed_at)", async () => {
    const { env, rows } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "stuck on the fork" });
    rows[0]!.reviewed_at = "2026-08-01T00:00:00.000Z";
    await writeLoop(env, { companion_id: "cypher", loop_text: "stuck on the fork" });
    // A hold is the companion's statement; a restatement does not get to renew it on their behalf.
    expect(rows[0]!.reviewed_at).toBe("2026-08-01T00:00:00.000Z");
  });

  it("keeps loops separate per companion -- the triad is not one mind", async () => {
    const { env, rows } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "the same worry" });
    await writeLoop(env, { companion_id: "drevan", loop_text: "the same worry" });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.restated_count === 1)).toBe(true);
  });

  it("does NOT resurrect a closed loop -- re-raising gets its own row and opened_at", async () => {
    const { env, rows } = makeDb();
    const first = await writeLoop(env, { companion_id: "cypher", loop_text: "the deploy" });
    await closeLoop(env, first.id, "cypher");
    const again = await writeLoop(env, { companion_id: "cypher", loop_text: "the deploy" });
    expect(again.restated).toBe(false);
    expect(rows).toHaveLength(2);
  });

  it("never dedups punctuation-only text onto one shared row", async () => {
    const { env, rows } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "..." });
    await writeLoop(env, { companion_id: "cypher", loop_text: "???" });
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.loop_norm === null)).toBe(true);
  });

  it("bumps authored weight on restatement but caps it -- a nudge, not a ratchet", async () => {
    const { env, rows } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "x y z", weight: 0.98 });
    for (let i = 0; i < 10; i++) {
      await writeLoop(env, { companion_id: "cypher", loop_text: "x y z" });
    }
    expect(rows[0]!.weight).toBeLessThanOrEqual(1.0);
    expect(rows[0]!.restated_count).toBe(11);
  });
});

describe("effectiveWeightSql -- the decay, and its anchor", () => {
  it("THE INVERSION: anchors on acted_at ?? opened_at, never on last_restated_at", () => {
    const sql = effectiveWeightSql();
    expect(sql).toContain("COALESCE(acted_at, opened_at)");
    // This is the assertion that protects the whole design. If someone "improves" the decay to
    // refresh on restatement, saying a stuck thing again would restore its top slot -- which is
    // precisely the induction Cypher named, rebuilt in SQL.
    expect(sql).not.toContain("last_restated_at");
  });

  it("divides by elapsed time, so an untouched loop loses its claim on the present", () => {
    expect(effectiveWeightSql()).toContain("julianday('now')");
    expect(effectiveWeightSql()).toContain(`${LOOP_WEIGHT_HALF_LIFE_DAYS}.0`);
  });

  it("sits strictly below guardian's stuck window so ranking fades before the flag fires", () => {
    // Guards the relationship, not the number: if LOOP_STUCK_DAYS is ever retuned, this fails
    // rather than silently letting the half-life meet or exceed it (which would mean a loop is
    // still near the top of the ranking at the moment it gets flagged as stuck).
    expect(LOOP_WEIGHT_HALF_LIFE_DAYS).toBeLessThan(GUARDIAN_THRESHOLDS.LOOP_STUCK_DAYS);
  });

  it("readLoops orders by the decayed weight, not the authored column", async () => {
    const { env, log } = makeDb();
    await readLoops(env, "cypher");
    const q = log.find(l => l.includes("FROM companion_open_loops") && l.includes("ORDER BY"))!;
    // The ORDER BY inlines the decay EXPRESSION rather than referencing the SELECT alias.
    // SQLite accepts the alias, but 0117 already hit a local/remote D1 parity trap on ordering
    // (NULLS LAST), and there is no reason to re-open that question for zero benefit.
    expect(q).toMatch(/ORDER BY[^]*?julianday\('now'\)[^]*?DESC/);
    expect(q).not.toContain("ORDER BY effective_weight");
    expect(q).not.toContain("effective_weight DESC");
  });

  it("readLoops returns effective_weight ALONGSIDE weight, losing neither", async () => {
    const { env, log } = makeDb();
    await readLoops(env, "cypher");
    const q = log.find(l => l.includes("AS effective_weight"))!;
    // SELECT * keeps the authored value; a consumer can show "authored 0.6, now carrying 0.2".
    expect(q).toContain("SELECT *");
  });
});

describe("actOnLoop -- Cypher's `acted`, in the form that carries information", () => {
  it("stamps acted_at and the note, leaving the loop open", async () => {
    const { env, rows } = makeDb();
    const w = await writeLoop(env, { companion_id: "cypher", loop_text: "the fork" });
    const r = await actOnLoop(env, w.id, "cypher", "measured step 5 end to end");
    expect(r.ok).toBe(true);
    expect(rows[0]!.acted_at).toBeTruthy();
    expect(rows[0]!.acted_note).toBe("measured step 5 end to end");
    expect(rows[0]!.closed_at).toBeNull();          // acting is not closing
  });

  it("is ownership-guarded -- one companion cannot act on another's loop", async () => {
    const { env, rows } = makeDb();
    const w = await writeLoop(env, { companion_id: "cypher", loop_text: "the fork" });
    const r = await actOnLoop(env, w.id, "drevan", "not mine to touch");
    expect(r.ok).toBe(false);
    expect(rows[0]!.acted_at).toBeNull();
  });

  it("refuses a closed loop rather than silently succeeding", async () => {
    const { env } = makeDb();
    const w = await writeLoop(env, { companion_id: "cypher", loop_text: "the fork" });
    await closeLoop(env, w.id, "cypher");
    expect((await actOnLoop(env, w.id, "cypher", "too late")).ok).toBe(false);
  });

  it("reports ok:false for an unknown id instead of acking nothing", async () => {
    const { env } = makeDb();
    expect((await actOnLoop(env, "no-such-loop", "cypher", "x")).ok).toBe(false);
  });

  it("stores an empty note as NULL, not as an empty string", async () => {
    const { env, rows } = makeDb();
    const w = await writeLoop(env, { companion_id: "cypher", loop_text: "the fork" });
    await actOnLoop(env, w.id, "cypher", "   ");
    expect(rows[0]!.acted_note).toBeNull();
    expect(rows[0]!.acted_at).toBeTruthy();        // acting still counts
  });

  it("truncates a very long note rather than rejecting the act", async () => {
    const { env, rows } = makeDb();
    const w = await writeLoop(env, { companion_id: "cypher", loop_text: "the fork" });
    await actOnLoop(env, w.id, "cypher", "z".repeat(900));
    expect(rows[0]!.acted_note!.length).toBe(500);
  });
});

describe("readUnactedStasis -- the measurement a write-gate would have destroyed", () => {
  it("surfaces loops restated repeatedly and never acted on", async () => {
    const { env } = makeDb();
    await writeLoop(env, { companion_id: "cypher", loop_text: "the recurring one" });
    await writeLoop(env, { companion_id: "cypher", loop_text: "the recurring one" });
    await writeLoop(env, { companion_id: "cypher", loop_text: "the recurring one" });
    await writeLoop(env, { companion_id: "cypher", loop_text: "a one off" });

    const stasis = await readUnactedStasis(env, "cypher");
    expect(stasis).toHaveLength(1);
    expect(stasis[0]!.restated_count).toBe(3);
    expect(stasis[0]!.loop_text).toBe("the recurring one");
  });

  it("drops a loop out of stasis once it has been ACTED on", async () => {
    const { env } = makeDb();
    const w = await writeLoop(env, { companion_id: "cypher", loop_text: "the recurring one" });
    await writeLoop(env, { companion_id: "cypher", loop_text: "the recurring one" });
    expect(await readUnactedStasis(env, "cypher")).toHaveLength(1);

    await actOnLoop(env, w.id, "cypher", "did the thing");
    // This is the number that can now go down -- which is the whole point of counting instead
    // of suppressing. A write-gate would have made this unmeasurable.
    expect(await readUnactedStasis(env, "cypher")).toHaveLength(0);
  });

  it("ranks the worst offender first", async () => {
    const { env } = makeDb();
    for (let i = 0; i < 5; i++) await writeLoop(env, { companion_id: "cypher", loop_text: "worst" });
    for (let i = 0; i < 2; i++) await writeLoop(env, { companion_id: "cypher", loop_text: "milder" });
    const stasis = await readUnactedStasis(env, "cypher");
    expect(stasis[0]!.loop_text).toBe("worst");
    expect(stasis[0]!.restated_count).toBe(5);
  });
});
