// Tests for the motif handler (migration 0076; inspo take 16): detection UPSERT
// semantics (cumulative recurrence, no double-count) and the resurrection read.
// Scripted in-memory D1 fake -- the corpus is settable per run so we can model the
// watermark excluding already-seen entries.

import { describe, it, expect, beforeEach } from "vitest";
import type { Env } from "../types.js";
import { postMotifsDetect, getMotifs } from "../handlers/motifs.js";
import { trustForRecurrence, type MotifRow } from "../webmind/motifs.js";

interface Row { [k: string]: unknown }

/** In-memory motif store keyed by `${companion}|${label}`; corpus is settable. */
class FakeDb {
  motifs = new Map<string, MotifRow>();
  corpus: string[] = [];

  setCorpus(texts: string[]) { this.corpus = texts; }

  prepare(sql: string) { return new FakeStatement(sql, this); }
}

class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement { return new FakeStatement(this.sql, this.db, args); }

  async first(): Promise<Row | null> {
    if (this.sql.includes("MAX(last_seen) AS wm")) {
      const id = this.bound[0] as string;
      const rows = [...this.db.motifs.values()].filter(m => m.companion_id === id);
      const wm = rows.length ? rows.map(r => r.last_seen).sort().at(-1)! : null;
      return { wm };
    }
    if (this.sql.includes("SELECT recurrence_count FROM companion_motifs")) {
      const [id, label] = this.bound as string[];
      const m = this.db.motifs.get(`${id}|${label}`);
      return m ? { recurrence_count: m.recurrence_count } : null;
    }
    return null;
  }

  async all(): Promise<{ results: Row[] }> {
    if (this.sql.includes("FROM companion_journal")) {
      return { results: this.db.corpus.map(t => ({ t })) };
    }
    if (this.sql.includes("FROM growth_journal")) {
      return { results: [] };
    }
    if (this.sql.includes("status = 'faded'")) {
      const id = this.bound[0] as string;
      return { results: [...this.db.motifs.values()].filter(m => m.companion_id === id && m.status === "faded") as unknown as Row[] };
    }
    if (this.sql.includes("FROM companion_motifs")) {
      const id = this.bound[0] as string;
      let rows = [...this.db.motifs.values()].filter(m => m.companion_id === id);
      if (this.sql.includes("status = ?")) {
        const status = this.bound[1] as string;
        rows = rows.filter(m => m.status === status);
      }
      rows.sort((a, b) => b.trust - a.trust || b.recurrence_count - a.recurrence_count);
      return { results: rows as unknown as Row[] };
    }
    return { results: [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT INTO companion_motifs")) {
      const [id, companion_id, label, display, recurrence, trust] = this.bound as [string, string, string, string, number, number];
      const key = `${companion_id}|${label}`;
      const existing = this.db.motifs.get(key);
      const now = new Date().toISOString();
      if (existing) {
        existing.recurrence_count = recurrence;
        existing.display = display;
        existing.trust = trust;
        existing.status = "active";
        existing.last_seen = now;
      } else {
        this.db.motifs.set(key, {
          id, companion_id, label, display, recurrence_count: recurrence, trust,
          first_seen: now, last_seen: now, last_surfaced_at: null, status: "active",
        });
      }
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE companion_motifs SET status = 'faded'")) {
      return { meta: { changes: 0 } }; // fresh corpus -> nothing ages out in these tests
    }
    return { meta: { changes: 0 } };
  }
}

function makeEnv(db: FakeDb): Env { return { DB: db } as unknown as Env; }
function detectReq(body?: unknown): Request {
  return new Request("http://local/mind/motifs/detect", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let db: FakeDb;
let env: Env;
beforeEach(() => { db = new FakeDb(); env = makeEnv(db); });

describe("postMotifsDetect", () => {
  it("stores a motif recurring across distinct entries with trust from recurrence", async () => {
    db.setCorpus(["the bridge at dusk", "we crossed the bridge", "bridge holds"]);
    const res = await (await postMotifsDetect(detectReq({ companion_id: "cypher" }), env)).json() as { detected: Record<string, number> };
    expect(res.detected["cypher"]).toBeGreaterThanOrEqual(1);
    const bridge = db.motifs.get("cypher|bridge")!;
    expect(bridge.recurrence_count).toBe(3);
    expect(bridge.trust).toBeCloseTo(trustForRecurrence(3), 5);
  });

  it("accumulates recurrence across runs (watermark model) without resetting", async () => {
    db.setCorpus(["bridge one", "bridge two", "bridge three"]); // df bridge = 3
    await postMotifsDetect(detectReq({ companion_id: "cypher" }), env);
    db.setCorpus(["bridge four", "bridge five"]);               // new entries, df bridge = 2
    await postMotifsDetect(detectReq({ companion_id: "cypher" }), env);
    const bridge = db.motifs.get("cypher|bridge")!;
    expect(bridge.recurrence_count).toBe(5);
    expect(bridge.trust).toBeCloseTo(trustForRecurrence(5), 5);
  });

  it("does not invent motifs from a single entry's internal repetition", async () => {
    db.setCorpus(["lighthouse lighthouse lighthouse lighthouse"]);
    await postMotifsDetect(detectReq({ companion_id: "cypher" }), env);
    expect(db.motifs.has("cypher|lighthouse")).toBe(false);
  });

  it("rejects unknown companion by falling back to all three", async () => {
    db.setCorpus(["recursion holds", "recursion again", "recursion still"]);
    const res = await (await postMotifsDetect(detectReq({ companion_id: "stranger" }), env)).json() as { detected: Record<string, number> };
    expect(Object.keys(res.detected).sort()).toEqual(["cypher", "drevan", "gaia"]);
  });

  // Regression: the corpus SELECTs must NOT mix anonymous `?` and numbered `?N`
  // placeholders. SQLite parses `... ? ... ? ... ?2 ...` as only TWO distinct
  // params (the second `?` and `?2` collapse to index 2), so a 3-bind call throws
  // "Incorrect number of bindings supplied (statement uses 2, 3 supplied)" in D1.
  // The FakeDb above ignores binding semantics, so this asserts the SQL text
  // directly -- the only layer that would have caught the prod 500.
  it("corpus queries use consistent numbered placeholders, not mixed styles", async () => {
    const captured: string[] = [];
    const realPrepare = db.prepare.bind(db);
    db.prepare = (sql: string) => { captured.push(sql); return realPrepare(sql); };

    db.setCorpus(["bridge here", "bridge there", "bridge again"]);
    await postMotifsDetect(detectReq({ companion_id: "cypher" }), env);

    const corpusSql = captured.filter(s => s.includes("FROM companion_journal") || s.includes("FROM growth_journal"));
    expect(corpusSql.length).toBeGreaterThanOrEqual(2);
    for (const sql of corpusSql) {
      const hasAnonymous = /\?(?!\d)/.test(sql); // a ? not followed by a digit
      const hasNumbered = /\?\d/.test(sql);
      expect(hasAnonymous && hasNumbered).toBe(false); // never both in one statement
    }
  });
});

describe("getMotifs", () => {
  it("returns active motifs ranked by trust", async () => {
    db.motifs.set("cypher|a", { id: "1", companion_id: "cypher", label: "a", display: "a", recurrence_count: 2, trust: 0.4, first_seen: "x", last_seen: "x", last_surfaced_at: null, status: "active" });
    db.motifs.set("cypher|b", { id: "2", companion_id: "cypher", label: "b", display: "b", recurrence_count: 9, trust: 0.8, first_seen: "x", last_seen: "x", last_surfaced_at: null, status: "active" });
    const res = await (await getMotifs(new Request("http://local/mind/motifs/cypher?status=active"), env, { companion_id: "cypher" })).json() as { motifs: MotifRow[] };
    expect(res.motifs.map(m => m.label)).toEqual(["b", "a"]);
  });

  it("surfaces high-trust faded motifs as resurrection candidates", async () => {
    db.motifs.set("cypher|old", { id: "1", companion_id: "cypher", label: "old", display: "old", recurrence_count: 7, trust: 0.85, first_seen: "2026-01-01 00:00:00", last_seen: "2026-03-01 00:00:00", last_surfaced_at: null, status: "faded" });
    db.motifs.set("cypher|weak", { id: "2", companion_id: "cypher", label: "weak", display: "weak", recurrence_count: 2, trust: 0.2, first_seen: "2026-01-01 00:00:00", last_seen: "2026-03-01 00:00:00", last_surfaced_at: null, status: "faded" });
    const res = await (await getMotifs(new Request("http://local/mind/motifs/cypher?status=faded"), env, { companion_id: "cypher" })).json() as { resurrections: MotifRow[] };
    expect(res.resurrections.map(m => m.label)).toEqual(["old"]);
  });

  it("400s on an unknown companion", async () => {
    const res = await getMotifs(new Request("http://local/mind/motifs/nobody"), env, { companion_id: "nobody" });
    expect(res.status).toBe(400);
  });
});
