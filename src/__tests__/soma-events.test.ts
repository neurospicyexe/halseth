/**
 * The append-only float history (mig 0130, src/soma/events.ts) -- graph memory Phase 2 tranche 1.
 *
 * Three kinds of test, matching what each guarantee actually lives in:
 *   - PURE: diffFloats emits one event per float that really moved, and nothing for a no-op, a
 *     clear, or a non-finite value that slipped past a caller with no Number() coercion.
 *   - SHAPE: somaEventStatements binds columns and values in the same order the INSERT declares
 *     them (the classic silent-corruption failure of a hand-rolled positional INSERT), and the
 *     constant kind/float lists match the migration's CHECK lists.
 *   - SOURCE-READING: sessionClose now bumps `version` (the fix the ferment tick's CAS depends on)
 *     -- a guarantee that lives in the SQL shape, like consolidation-close-kind.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  diffFloats,
  floatKeyFromShort,
  floatShort,
  loadSomaProvenance,
  readFloatsSql,
  somaEventStatements,
  SOMA_EVENT_KINDS,
  SOMA_FLOAT_KEYS,
  type SomaEventInput,
} from "../soma/events.js";
import { eventsFromShift, eventsFromFermentEvent } from "../handlers/soma-events.js";
import type { Env } from "../types.js";

const src = (p: string) => readFile(resolve(__dirname, "..", p), "utf8");
const migration = () => readFile(resolve(__dirname, "..", "..", "migrations", "0130_companion_soma_events.sql"), "utf8");

const BASE: Omit<SomaEventInput, "float_key" | "before_value" | "after_value"> = {
  companion_id: "cypher",
  kind: "authored_close",
  writer: "cypher",
};

// ── A minimal D1 fake, in the suite's miniflare-free style ─────────────────────────

interface Row { [k: string]: unknown }

class FakeStatement {
  constructor(private sql: string, private tables: Record<string, Row[]>, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.tables, args);
  }
  get boundArgs(): unknown[] { return this.bound; }
  get text(): string { return this.sql; }
  async run(): Promise<{ meta: { changes: number } }> {
    return { meta: { changes: 1 } };
  }
  async first<T = Row>(): Promise<T | null> {
    const r = await this.all<T>();
    return (r.results[0] as T) ?? null;
  }
  async all<T = Row>(): Promise<{ results: T[] }> {
    if (/FROM companion_soma_events/.test(this.sql)) {
      const rows = (this.tables.companion_soma_events ?? []).filter((r) => r.companion_id === this.bound[0]);
      const sorted = [...rows].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      // Emulate the ROW_NUMBER() window: newest 3 per float.
      const seen = new Map<string, number>();
      const kept: Row[] = [];
      for (const r of sorted) {
        const n = (seen.get(String(r.float_key)) ?? 0) + 1;
        seen.set(String(r.float_key), n);
        if (n <= 3) kept.push(r);
      }
      return { results: kept as T[] };
    }
    if (/FROM handover_packets/.test(this.sql)) {
      const ids = new Set(this.bound.map(String));
      return { results: (this.tables.handover_packets ?? []).filter((r) => ids.has(String(r.id))) as T[] };
    }
    if (/FROM companion_ferment_events/.test(this.sql)) {
      const ids = new Set(this.bound.map(String));
      return { results: (this.tables.companion_ferment_events ?? []).filter((r) => ids.has(String(r.id))) as T[] };
    }
    if (/FROM companion_soma_shifts/.test(this.sql)) {
      const ids = new Set(this.bound.map(String));
      return { results: (this.tables.companion_soma_shifts ?? []).filter((r) => ids.has(String(r.id))) as T[] };
    }
    if (/FROM companion_journal/.test(this.sql)) {
      const ids = new Set(this.bound.map(String));
      const counts = new Map<string, number>();
      for (const r of this.tables.companion_journal ?? []) {
        const s = String(r.session_id);
        if (!ids.has(s)) continue;
        counts.set(s, (counts.get(s) ?? 0) + 1);
      }
      return { results: [...counts].map(([session_id, n]) => ({ session_id, n })) as T[] };
    }
    return { results: [] as T[] };
  }
}

function fakeEnv(tables: Record<string, Row[]>): Env {
  return {
    DB: {
      prepare: (sql: string) => new FakeStatement(sql, tables),
      batch: async (stmts: FakeStatement[]) => stmts.map(() => ({ meta: { changes: 1 } })),
    },
  } as unknown as Env;
}

// ── diffFloats ────────────────────────────────────────────────────────────────────

describe("diffFloats", () => {
  it("emits one event per CHANGED float and none for unchanged ones", () => {
    const events = diffFloats(
      { soma_float_1: 0.62, soma_float_2: 0.5, soma_float_3: 0.4 },
      { soma_float_1: 0.78, soma_float_2: 0.5, soma_float_3: 0.9 },
      BASE,
    );
    expect(events.map((e) => e.float_key)).toEqual(["soma_float_1", "soma_float_3"]);
    expect(events[0]).toMatchObject({ before_value: 0.62, after_value: 0.78, kind: "authored_close", writer: "cypher" });
  });

  it("treats a sub-1e-9 move as no move at all", () => {
    expect(diffFloats({ soma_float_1: 0.5 }, { soma_float_1: 0.5 + 1e-12 }, BASE)).toEqual([]);
  });

  it("skips floats absent from `after`, and skips a clear or a non-finite after", () => {
    expect(diffFloats({ soma_float_1: 0.2 }, {}, BASE)).toEqual([]);
    expect(diffFloats({ soma_float_1: 0.2 }, { soma_float_1: null }, BASE)).toEqual([]);
    // sessionClose binds somaFields[col] ?? null with no Number() coercion: a string can arrive.
    expect(diffFloats({ soma_float_1: 0.2 }, { soma_float_1: "nope" as unknown as number }, BASE)).toEqual([]);
    expect(diffFloats({ soma_float_1: 0.2 }, { soma_float_1: NaN }, BASE)).toEqual([]);
  });

  it("still emits when `before` is unknown -- the move happened, the origin is just unrecorded", () => {
    const e = diffFloats({}, { soma_float_2: 0.71 }, BASE)[0]!;
    expect(e).toMatchObject({ float_key: "soma_float_2", before_value: null, after_value: 0.71 });
  });

  it("a non-finite BEFORE is treated as unknown, not as a comparison base", () => {
    const e = diffFloats({ soma_float_3: NaN }, { soma_float_3: 0.3 }, BASE)[0]!;
    expect(e.before_value).toBeNull();
  });
});

// ── somaEventStatements ───────────────────────────────────────────────────────────

describe("somaEventStatements", () => {
  it("binds values in exactly the column order the INSERT declares", () => {
    const db = { prepare: (sql: string) => new FakeStatement(sql, {}) } as unknown as D1Database;
    const [stmt0] = somaEventStatements(db, [{
      id: "evt-1",
      companion_id: "drevan",
      float_key: "soma_float_2",
      before_value: 0.4,
      after_value: 0.55,
      kind: "tick",
      writer: "system",
      cause_table: "companion_ferment_events",
      cause_id: "fe-9",
      session_id: null,
      version_after: 12,
      detail: "silence",
      created_at: "2026-09-12T00:00:00.000Z",
    }]) as unknown as FakeStatement[];
    const stmt = stmt0!;

    const cols = /INTO companion_soma_events \(([^)]+)\)/.exec(stmt.text)?.[1]?.split(",").map((s) => s.trim()) ?? [];
    const values = stmt.boundArgs;
    expect(cols.length).toBe(values.length);
    const byCol = Object.fromEntries(cols.map((c, i) => [c, values[i]]));
    expect(byCol).toMatchObject({
      id: "evt-1",
      companion_id: "drevan",
      float_key: "soma_float_2",
      before_value: 0.4,
      after_value: 0.55,
      kind: "tick",
      writer: "system",
      cause_table: "companion_ferment_events",
      cause_id: "fe-9",
      session_id: null,
      version_after: 12,
      detail: "silence",
      created_at: "2026-09-12T00:00:00.000Z",
    });
    expect(byCol.delta).toBeCloseTo(0.15, 6);
    // INSERT OR IGNORE is what makes the deterministic-id backfill safe to re-run.
    expect(stmt.text).toMatch(/INSERT OR IGNORE INTO companion_soma_events/);
  });

  it("falls back to the writer's own delta when the absolutes are unknown (backfilled ferment rows)", () => {
    const db = { prepare: (sql: string) => new FakeStatement(sql, {}) } as unknown as D1Database;
    const [stmt0] = somaEventStatements(db, [{
      companion_id: "gaia", float_key: "soma_float_1", before_value: null, after_value: null,
      delta: -0.04, kind: "tick", writer: "system",
    }]) as unknown as FakeStatement[];
    const stmt = stmt0!;
    const cols = /INTO companion_soma_events \(([^)]+)\)/.exec(stmt.text)?.[1]?.split(",").map((s) => s.trim()) ?? [];
    const byCol = Object.fromEntries(cols.map((c, i) => [c, stmt.boundArgs[i]]));
    expect(byCol.delta).toBe(-0.04);
    expect(byCol.id).toEqual(expect.any(String));
  });
});

// ── constants vs the migration ────────────────────────────────────────────────────

describe("constants match the migration's CHECK lists", () => {
  it("kind and float_key enums do not drift from mig 0130", async () => {
    const sql = await migration();
    const kinds = /kind\s+TEXT NOT NULL CHECK \(kind IN \(([^)]+)\)\)/.exec(sql)?.[1] ?? "";
    expect(kinds.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...SOMA_EVENT_KINDS]);
    const floats = /float_key\s+TEXT NOT NULL CHECK \(float_key IN \(([^)]+)\)\)/.exec(sql)?.[1] ?? "";
    expect(floats.split(",").map((s) => s.trim().replace(/'/g, ""))).toEqual([...SOMA_FLOAT_KEYS]);
  });

  it("readFloatsSql reads the three floats plus version from companion_state", () => {
    expect(readFloatsSql()).toMatch(/SELECT soma_float_1, soma_float_2, soma_float_3, version FROM companion_state WHERE companion_id = \?/);
  });

  it("floatShort and floatKeyFromShort round-trip", () => {
    for (const k of SOMA_FLOAT_KEYS) expect(floatKeyFromShort(floatShort(k))).toBe(k);
    expect(floatKeyFromShort("f4")).toBeNull();
  });
});

// ── sessionClose bumps version (source-reading) ───────────────────────────────────

describe("sessionClose float write", () => {
  it("bumps companion_state.version -- the ferment tick's CAS depends on it", async () => {
    const backend = await src("librarian/backends/halseth.ts");
    const fn = backend.slice(backend.indexOf("export async function sessionClose("));
    const close = fn.slice(0, fn.indexOf("await env.DB.batch(stmts);"));
    expect(close).toMatch(/assignments\.push\("updated_at = datetime\('now'\)", "version = COALESCE\(version, 0\) \+ 1"\)/);
  });

  it("appends the float history in the SAME batch as the float write", async () => {
    const backend = await src("librarian/backends/halseth.ts");
    const fn = backend.slice(backend.indexOf("export async function sessionClose("));
    const close = fn.slice(0, fn.indexOf("await env.DB.batch(stmts);"));
    // 2026-09-14: the event INSERTs and their live graph edges are fused into one statement list
    // (somaEventAndEdgeStatements) and still pushed onto the SAME `stmts` the float UPDATE is in.
    expect(close).toMatch(/stmts\.push\(\.\.\.somaEventAndEdgeStatements\(env, events, prevEventIds\)\)/);
    expect(backend).toMatch(/function somaEventAndEdgeStatements\([\s\S]*?\.\.\.somaEventStatements\(env\.DB, events\)/);
    expect(close).toMatch(/cause_table: "handover_packets"/);
    expect(close).toMatch(/kind: "authored_close"/);
  });
});

// ── backfill ──────────────────────────────────────────────────────────────────────

describe("backfill event derivation", () => {
  const shift = {
    id: "sh-1", companion_id: "cypher", float_key: "soma_float_1", delta: 0.05,
    before_value: 0.6, after_value: 0.65, reason: "crystallized:\nthe blade wants edges", created_at: "2026-08-01T10:00:00Z",
  };

  it("a shift backfills to one drift_shift event with a deterministic id and the SOURCE timestamp", () => {
    const e = eventsFromShift(shift)[0]!;
    expect(e.id).toBe("ss_sh-1");
    expect(e).toMatchObject({
      kind: "drift_shift", writer: "system", cause_table: "companion_soma_shifts", cause_id: "sh-1",
      before_value: 0.6, after_value: 0.65, created_at: "2026-08-01T10:00:00Z",
    });
    expect(e.detail).toBe("crystallized:");
  });

  it("is deterministic: the same source row yields byte-identical ids every run", () => {
    expect(eventsFromShift(shift).map((e) => e.id)).toEqual(eventsFromShift(shift).map((e) => e.id));
  });

  it("a ferment event backfills one event per NON-ZERO float, delta only, no absolutes", () => {
    const events = eventsFromFermentEvent({
      id: "fe-7", companion_id: "drevan", kind: "tick", stimulus: null,
      float_deltas: JSON.stringify({ f1: -0.03, f2: 0, f3: 0.011 }), created_at: "2026-08-02T01:00:00Z",
    });
    expect(events.map((e) => e.id)).toEqual(["fe_fe-7_f1", "fe_fe-7_f3"]);
    expect(events[0]).toMatchObject({
      float_key: "soma_float_1", before_value: null, after_value: null, delta: -0.03,
      kind: "tick", cause_table: "companion_ferment_events", cause_id: "fe-7",
    });
  });

  it("the live tick writer mints the SAME id shape, so a re-run cannot double a recorded move", () => {
    // handlers/fermentation.ts: `fe_${fermentEventId}_${floatShort(e.float_key)}`
    const [e0] = eventsFromFermentEvent({
      id: "fe-7", companion_id: "drevan", kind: "tick", stimulus: null,
      float_deltas: JSON.stringify({ f1: -0.03 }), created_at: "2026-08-02T01:00:00Z",
    });
    expect(e0!.id).toBe(`fe_fe-7_${floatShort("soma_float_1")}`);
  });

  it("ignores unparseable float_deltas and non-float kinds", () => {
    expect(eventsFromFermentEvent({ id: "x", companion_id: "gaia", kind: "tick", stimulus: null, float_deltas: "{oops", created_at: "t" })).toEqual([]);
    expect(eventsFromFermentEvent({ id: "x", companion_id: "gaia", kind: "baseline_drift", stimulus: null, float_deltas: '{"f1":0.1}', created_at: "t" })).toEqual([]);
  });
});

// ── loadSomaProvenance ────────────────────────────────────────────────────────────

describe("loadSomaProvenance", () => {
  it("returns newest-first entries with labels, cause labels and an alongside note count", async () => {
    const env = fakeEnv({
      companion_soma_events: [
        {
          id: "e1", companion_id: "cypher", float_key: "soma_float_1", before_value: 0.62, after_value: 0.78,
          delta: 0.16, kind: "authored_close", writer: "cypher", cause_table: "handover_packets", cause_id: "h1",
          session_id: "s1", detail: null, created_at: "2026-09-11T20:00:00Z",
        },
        {
          id: "e2", companion_id: "cypher", float_key: "soma_float_2", before_value: 0.65, after_value: 0.62,
          delta: -0.03, kind: "tick", writer: "system", cause_table: "companion_ferment_events", cause_id: "f1",
          session_id: null, detail: "silence", created_at: "2026-09-10T20:00:00Z",
        },
      ],
      handover_packets: [{ id: "h1", spine: "fleet check: bots lost the key\nsecond line ignored" }],
      companion_ferment_events: [{ id: "f1", stimulus: null }],
      companion_journal: [{ session_id: "s1" }, { session_id: "s1" }, { session_id: "other" }],
    });

    const out = await loadSomaProvenance(env, "cypher");
    expect(out.map((e) => e.float_key)).toEqual(["soma_float_1", "soma_float_2"]);
    expect(out[0]).toMatchObject({
      label: "acuity", kind: "authored_close", writer: "cypher",
      before_value: 0.62, after_value: 0.78, cause_table: "handover_packets",
      cause_label: "fleet check: bots lost the key", session_id: "s1", alongside_notes: 2,
    });
    // A tick with no stimulus is labelled 'tick'; no session means no notes.
    expect(out[1]).toMatchObject({ label: "presence", cause_label: "tick", alongside_notes: 0 });
  });

  it("is best-effort: a throwing D1 returns [] rather than breaking orient or Hearth", async () => {
    const env = { DB: { prepare: () => { throw new Error("D1 down"); } } } as unknown as Env;
    expect(await loadSomaProvenance(env, "gaia")).toEqual([]);
  });
});
