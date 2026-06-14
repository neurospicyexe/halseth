// Weekly clearing pass (Goal B, 2026-06-14): high-substrate triage of the ratification
// backlog. Auto-declines drift, shortlists real growth for Raziel (never accepts), and
// no-ops gracefully without the model key.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Env } from "../types.js";
import { runClearingPass } from "../clearing/pass.js";

interface Row { [k: string]: unknown }

/** Minimal scripted D1: pending reads per companion + records declines and the letter. */
class FakeDb {
  pending: Record<string, Row[]> = { cypher: [], drevan: [], gaia: [] };
  declined: string[] = [];
  basins: Row[] = [];
  basinDismissed: string[] = [];
  journal: Row[] = [];

  prepare(sql: string) { return new FakeStmt(sql, this); }
}

class FakeStmt {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStmt { return new FakeStmt(this.sql, this.db, args); }

  async all<T>(): Promise<{ results: T[] }> {
    if (this.sql.includes("FROM growth_journal")) {
      const companion = this.bound[0] as string;
      return { results: (this.db.pending[companion] ?? []) as T[] };
    }
    if (this.sql.includes("FROM companion_basin_history")) {
      return { results: this.db.basins as T[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("UPDATE growth_journal SET review_status = 'declined'")) {
      this.db.declined.push(this.bound[0] as string);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE companion_basin_history SET dismissed_at")) {
      this.db.basinDismissed.push(this.bound[0] as string);
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO companion_journal")) {
      const [id, note_text, tags] = this.bound as string[];
      this.db.journal.push({ id, note_text, tags });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

function makeEnv(db: FakeDb, over: Partial<Env> = {}): Env {
  return { DB: db, ANTHROPIC_API_KEY: "sk-test", ...over } as unknown as Env;
}

function stubAnthropic(verdicts: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(
    JSON.stringify({ stop_reason: "end_turn", content: [{ type: "text", text: JSON.stringify(verdicts) }] }),
    { status: 200 },
  )));
}

let db: FakeDb;
beforeEach(() => { db = new FakeDb(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("runClearingPass", () => {
  it("no-ops gracefully when the model key is unset", async () => {
    const res = await runClearingPass(makeEnv(db, { ANTHROPIC_API_KEY: undefined }));
    expect(res.skipped).toBeTruthy();
    expect(res.declined).toBe(0);
    expect(db.journal).toHaveLength(0);
  });

  it("returns early with no letter when the backlog is empty", async () => {
    const fetchSpy = vi.fn(async () => new Response("[]", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const res = await runClearingPass(makeEnv(db));
    expect(res.pending).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();   // returns before the model call
    expect(db.journal).toHaveLength(0);
  });

  it("auto-declines drift, shortlists real growth, and writes one letter_to_raziel digest", async () => {
    db.pending.cypher = [
      { id: "g1", companion_id: "cypher", entry_type: "insight", content: "contemplating my own basin drift and substrate", novelty: null },
      { id: "g2", companion_id: "cypher", entry_type: "insight", content: "what stormwater catchment taught me about holding", novelty: "high" },
    ];
    stubAnthropic([
      { id: "g1", verdict: "decline", reason: "self-referential system coinage" },
      { id: "g2", verdict: "shortlist", reason: "metabolizes the world, breaks the loop" },
    ]);

    const res = await runClearingPass(makeEnv(db));

    expect(res.pending).toBe(2);
    expect(res.declined).toBe(1);
    expect(res.shortlisted).toBe(1);
    expect(db.declined).toEqual(["g1"]);          // only the drift entry declined
    expect(res.letter_id).toBeTruthy();
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0]!["tags"]).toContain("letter_to_raziel");
    expect(db.journal[0]!["tags"]).toContain("clearing");
    expect(db.journal[0]!["note_text"]).toContain("g2");      // shortlist surfaced with its id
    expect(db.journal[0]!["note_text"]).not.toContain("accepted"); // never accepts
  });

  it("dismisses noise basins (no re-baseline) and surfaces real drift in the letter -- never confirms", async () => {
    db.basins = [
      { id: "b1", companion_id: "drevan", worst_basin: "tender", notes: "thin sample", drift_score: 0.42, recorded_at: "2026-06-12 09:00:00" },
      { id: "b2", companion_id: "drevan", worst_basin: "dark", notes: "sustained register shift", drift_score: 0.71, recorded_at: "2026-06-13 09:00:00" },
    ];
    stubAnthropic([
      { id: "b1", verdict: "dismiss", reason: "thin, no substance" },
      { id: "b2", verdict: "surface", reason: "coherent sustained drift" },
    ]);

    const res = await runClearingPass(makeEnv(db));

    expect(res.basins_reviewed).toBe(2);
    expect(res.basins_dismissed).toBe(1);
    expect(res.basins_surfaced).toBe(1);
    expect(db.basinDismissed).toEqual(["b1"]);   // only the noise reading dismissed
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0]!["note_text"]).toContain("b2");          // real drift surfaced with id
    expect(db.journal[0]!["note_text"]).toContain("re-baseline"); // letter names the stakes
  });

  it("ignores hallucinated ids and invalid verdicts from the model", async () => {
    db.pending.gaia = [{ id: "g9", companion_id: "gaia", entry_type: "insight", content: "real", novelty: null }];
    stubAnthropic([
      { id: "ghost", verdict: "decline", reason: "not a real entry" },
      { id: "g9", verdict: "accept", reason: "model tried to accept -- not allowed" },
    ]);
    const res = await runClearingPass(makeEnv(db));
    expect(db.declined).toEqual([]);     // ghost id ignored, accept verdict dropped
    expect(res.declined).toBe(0);
    expect(res.shortlisted).toBe(0);
  });
});
