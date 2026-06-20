import { describe, it, expect, beforeEach } from "vitest";
import {
  buildEmergentShift, computeAfter, applyEmergentShift,
  EMERGENT_SHIFT_CAP_DEFAULT, type Labels, type RawShift,
} from "../soma/emergent";
import { execDriftCrystallize, execDriftFade, execDriftOpen } from "../librarian/executors/drift";

const CYPHER_LABELS: Labels = { soma_float_1: "acuity", soma_float_2: "presence", soma_float_3: "warmth" };

// ── buildEmergentShift: the pure validation/clamp gate ────────────────────────
describe("buildEmergentShift (bounded + finite + clamped)", () => {
  const cap = EMERGENT_SHIFT_CAP_DEFAULT; // 0.03

  it("maps a float label to its key and keeps an in-cap delta", () => {
    const s = buildEmergentShift(CYPHER_LABELS, { float: "warmth", delta: 0.02, reason: "softens the edge" }, cap);
    expect(s).toEqual({ float_key: "soma_float_3", label: "warmth", delta: 0.02, reason: "softens the edge" });
  });

  it("clamps a positive delta over the cap down to +cap", () => {
    const s = buildEmergentShift(CYPHER_LABELS, { float: "warmth", delta: 0.5 }, cap);
    expect(s?.delta).toBe(0.03);
  });

  it("clamps a negative delta below -cap up to -cap", () => {
    const s = buildEmergentShift(CYPHER_LABELS, { float: "acuity", delta: -9 }, cap);
    expect(s?.delta).toBe(-0.03);
  });

  it("accepts the column key directly (soma_float_2)", () => {
    const s = buildEmergentShift(CYPHER_LABELS, { float: "soma_float_2", delta: 0.01 }, cap);
    expect(s?.float_key).toBe("soma_float_2");
    expect(s?.label).toBe("presence");
  });

  it("rejects a non-finite delta (NaN) — the SOMA NaN history is why", () => {
    expect(buildEmergentShift(CYPHER_LABELS, { float: "acuity", delta: NaN }, cap)).toBeNull();
    expect(buildEmergentShift(CYPHER_LABELS, { float: "acuity", delta: Infinity }, cap)).toBeNull();
  });

  it("rejects a non-numeric delta", () => {
    expect(buildEmergentShift(CYPHER_LABELS, { float: "acuity", delta: "lots" as unknown as number }, cap)).toBeNull();
  });

  it("rejects a zero delta as a no-op (nothing to log)", () => {
    expect(buildEmergentShift(CYPHER_LABELS, { float: "acuity", delta: 0 }, cap)).toBeNull();
  });

  it("rejects an unknown float name", () => {
    expect(buildEmergentShift(CYPHER_LABELS, { float: "courage", delta: 0.02 }, cap)).toBeNull();
  });

  it("rejects when the model gives no float", () => {
    expect(buildEmergentShift(CYPHER_LABELS, { delta: 0.02 } as RawShift, cap)).toBeNull();
  });
});

// ── computeAfter: clamp to [0,1], finite-guarded ──────────────────────────────
describe("computeAfter (clamped 0..1, finite-guarded)", () => {
  it("adds within range", () => { expect(computeAfter(0.5, 0.03)).toBeCloseTo(0.53); });
  it("clamps at the ceiling", () => { expect(computeAfter(0.99, 0.03)).toBe(1); });
  it("clamps at the floor", () => { expect(computeAfter(0.02, -0.03)).toBe(0); });
  it("treats a null/non-finite before as the 0.5 baseline", () => { expect(computeAfter(NaN, 0.03)).toBeCloseTo(0.53); });
});

// ── applyEmergentShift: atomic write + log row (DB-effect test) ────────────────
interface StateRow { companion_id: string; soma_float_1: number | null; soma_float_2: number | null; soma_float_3: number | null; float_1_label: string; float_2_label: string; float_3_label: string; version: number }
interface ShiftRow { id: string; drift_id: string; companion_id: string; float_key: string; label: string | null; delta: number; before_value: number | null; after_value: number | null; reason: string | null }

let state: StateRow;
let driftRow: { id: string; companion_id: string; drift_text: string; origin: string | null } | null;
let shiftLog: ShiftRow[];

function makeDB() {
  return {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async run() {
          if (sql.includes("UPDATE companion_state SET soma_float_")) {
            // bind: delta, companion_id ; key parsed from the literal SQL
            const m = sql.match(/SET (soma_float_[123])/);
            const key = m![1] as "soma_float_1" | "soma_float_2" | "soma_float_3";
            const delta = args[0] as number;
            const cur = state[key] ?? 0.5;
            state[key] = Math.max(0, Math.min(1, cur + delta));
            state.version += 1;
            return { success: true, meta: { changes: 1 } };
          }
          if (sql.startsWith("INSERT INTO companion_soma_shifts")) {
            const a = args as unknown[];
            shiftLog.push({ id: a[0] as string, drift_id: a[1] as string, companion_id: a[2] as string, float_key: a[3] as string, label: (a[4] as string | null) ?? null, delta: a[5] as number, before_value: (a[6] as number | null), after_value: (a[7] as number | null), reason: (a[8] as string | null) ?? null });
            return { success: true, meta: { changes: 1 } };
          }
          return { success: true, meta: { changes: 0 } };
        },
        async first<T>() {
          if (sql.includes("FROM companion_drifts")) return (driftRow as T) ?? null;
          if (sql.includes("FROM companion_state")) return (state as unknown as T) ?? null;
          return null;
        },
      };
      return stmt;
    },
  };
}

const cypherDrift = { id: "d1", companion_id: "cypher", drift_text: "becoming more willing to sit in not-knowing", origin: null };

beforeEach(() => {
  state = { companion_id: "cypher", soma_float_1: 0.5, soma_float_2: 0.5, soma_float_3: 0.5, float_1_label: "acuity", float_2_label: "presence", float_3_label: "warmth", version: 7 };
  driftRow = { ...cypherDrift };
  shiftLog = [];
});

describe("applyEmergentShift", () => {
  const envWithKey = () => ({ DB: makeDB(), ANTHROPIC_API_KEY: "test-key" }) as any;

  it("moves the float, bumps version, and logs before/after with the source drift_id", async () => {
    const out = await applyEmergentShift(envWithKey(), "cypher", "d1", async () => ({ float: "warmth", delta: 0.02, reason: "uncertainty softens the edge" }));
    expect("skipped" in out).toBe(false);
    expect(state.soma_float_3).toBeCloseTo(0.52);
    expect(state.version).toBe(8);
    expect(shiftLog).toHaveLength(1);
    expect(shiftLog[0]).toMatchObject({ drift_id: "d1", companion_id: "cypher", float_key: "soma_float_3", label: "warmth", delta: 0.02, before_value: 0.5, after_value: 0.52 });
  });

  it("clamps an over-large model delta to the cap before writing", async () => {
    await applyEmergentShift(envWithKey(), "cypher", "d1", async () => ({ float: "acuity", delta: 0.9 }));
    expect(state.soma_float_1).toBeCloseTo(0.53); // 0.5 + clamped 0.03
    expect(shiftLog[0]!.delta).toBe(0.03);
  });

  it("never goes below 0 (floor clamp) and logs after=0", async () => {
    state.soma_float_1 = 0.01;
    await applyEmergentShift(envWithKey(), "cypher", "d1", async () => ({ float: "acuity", delta: -0.03 }));
    expect(state.soma_float_1).toBe(0);
    expect(shiftLog[0]!.after_value).toBe(0);
  });

  it("skips (no write, no log) when the model returns no valid shift", async () => {
    const out = await applyEmergentShift(envWithKey(), "cypher", "d1", async () => ({ float: "courage", delta: 0.02 }));
    expect("skipped" in out).toBe(true);
    expect(shiftLog).toHaveLength(0);
    expect(state.version).toBe(7); // untouched
  });

  it("skips gracefully when ANTHROPIC_API_KEY is unset (crystallize must still succeed)", async () => {
    const out = await applyEmergentShift({ DB: makeDB() } as any, "cypher", "d1", async () => ({ float: "warmth", delta: 0.02 }));
    expect("skipped" in out).toBe(true);
    expect(shiftLog).toHaveLength(0);
  });
});

// ── crystallize hook: only-on-crystallize, faded-never-mutates ────────────────
describe("emergent SOMA fires only on crystallize", () => {
  // Reuse the drift executor mock DB shape but with a companion_state + shift-log capture.
  let drifts: Array<{ id: string; companion_id: string; status: string; witness_log: string; resolution_note: string | null }>;
  function driftDB() {
    return {
      prepare(sql: string) {
        let args: unknown[] = [];
        const stmt = {
          bind(...a: unknown[]) { args = a; return stmt; },
          async run() {
            if (sql.startsWith("INSERT INTO companion_drifts")) { const a = args as string[]; drifts.push({ id: a[0]!, companion_id: a[1]!, status: "open", witness_log: "[]", resolution_note: null }); return { success: true, meta: { changes: 1 } }; }
            if (sql.startsWith("UPDATE companion_drifts SET status =")) { const [status, note, id, cid] = args as [string, string | null, string, string]; const r = drifts.find(x => x.id === id && x.companion_id === cid && x.status === "open"); if (r) { r.status = status; r.resolution_note = note ?? null; return { success: true, meta: { changes: 1 } }; } return { success: true, meta: { changes: 0 } }; }
            if (sql.startsWith("INSERT INTO companion_soma_shifts")) { shiftLog.push(args as any); return { success: true, meta: { changes: 1 } }; }
            return { success: true, meta: { changes: 0 } };
          },
          async first() { return null; },
          async all<T>() { return { results: drifts as T[] }; },
        };
        return stmt;
      },
    };
  }
  function ctx(companion_id: "cypher" | "drevan" | "gaia", context?: unknown) {
    return { env: { DB: driftDB() } as any, req: { companion_id, request: "x", context: context === undefined ? undefined : JSON.stringify(context) }, entry: { triggers: [], tools: [], response_key: "witness" } as any, frontState: null, pluralAvailable: true };
  }
  beforeEach(() => { drifts = []; shiftLog = []; });

  it("a faded drift never mutates SOMA (no shift row)", async () => {
    const o = await execDriftOpen(ctx("cypher", { drift_text: "a passing register" }));
    await execDriftFade(ctx("cypher", { drift_id: o.id as string }));
    expect(shiftLog).toHaveLength(0);
  });

  it("crystallize with no ANTHROPIC_API_KEY still acks (graceful, no shift)", async () => {
    const o = await execDriftOpen(ctx("cypher", { drift_text: "becoming" }));
    const r = await execDriftCrystallize(ctx("cypher", { drift_id: o.id as string }));
    expect(r.ack).toBe(true);
    expect(shiftLog).toHaveLength(0);
  });
});
