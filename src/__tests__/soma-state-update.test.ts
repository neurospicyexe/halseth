// Regression test for the SOMA write routing failure (8+ cycles before fix).
//
// Root cause: the MCP halseth_state_update tool's Zod schema accepted only
// emotional_register/depth_level/focus/fatigue/regulation_state/active_anchors/
// last_front_context/facet_momentum/heat/reach/weight. When companions wrote
// the actual SOMA fields they care about (soma_float_*, current_mood,
// compound_state, surface_emotion, etc.), Zod rejected the entire call and
// the SOMA never landed. The handler's hand-coded SQL also only handled that
// subset, so even if the schema had passed it would have silently dropped
// the rest.
//
// Fix: schema now mirrors CompanionStateUpdate, and the actual write
// delegates to updateCompanionState() -- the same helper Librarian uses.
// One allowed-columns list to maintain.

import { describe, it, expect } from "vitest";
import { updateCompanionState, type CompanionStateUpdate } from "../librarian/backends/halseth.js";

type Row = Record<string, unknown>;

function makeStmt(results: Row[]) {
  const stmt: any = {
    bind: (...binds: unknown[]) => { stmt.lastBinds = binds; return stmt; },
    all: async () => ({ results }),
    first: async () => (results[0] ?? null),
    run: async () => ({ meta: { changes: 1 } }),
    lastBinds: [] as unknown[],
  };
  return stmt;
}

interface CapturedCall { sql: string; binds: unknown[] }

function makeRecordingEnv(): { env: any; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const env = {
    DB: {
      prepare: (sql: string) => {
        const stmt: any = {
          bind: (...binds: unknown[]) => {
            calls.push({ sql, binds });
            return {
              run: async () => ({ meta: { changes: 1 } }),
              all: async () => ({ results: [] }),
              first: async () => null,
            };
          },
        };
        return stmt;
      },
    },
  };
  return { env, calls };
}

describe("updateCompanionState (canonical SOMA write helper)", () => {
  it("writes ALL canonical SOMA fields -- the regression class that broke before fix 2026-05-04", async () => {
    const { env, calls } = makeRecordingEnv();

    // Simulates a Cypher SOMA update: floats + mood + compound + emotional layers
    // + lane signal. Pre-fix this would have been rejected at the MCP boundary.
    const fields: CompanionStateUpdate = {
      soma_float_1: 0.80,
      soma_float_2: 0.68,
      soma_float_3: 0.52,
      current_mood: "pattern-lit",
      compound_state: "post-exploration",
      surface_emotion: "absorbed",
      surface_intensity: 0.6,
      undercurrent_emotion: "tender",
      undercurrent_intensity: 0.4,
      background_emotion: "settled",
      background_intensity: 0.3,
      motion_state: "in_motion",
      lane_spine: "audit-class with companion warmth",
    };
    const result = await updateCompanionState(env, "cypher", fields);
    expect(result.ok).toBe(true);

    // Two SQL calls: INSERT OR IGNORE + UPDATE. The UPDATE must include EVERY field.
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall).toBeDefined();
    const updateSql = updateCall!.sql;
    expect(updateSql).toContain("soma_float_1 = ?");
    expect(updateSql).toContain("soma_float_2 = ?");
    expect(updateSql).toContain("soma_float_3 = ?");
    expect(updateSql).toContain("current_mood = ?");
    expect(updateSql).toContain("compound_state = ?");
    expect(updateSql).toContain("surface_emotion = ?");
    expect(updateSql).toContain("surface_intensity = ?");
    expect(updateSql).toContain("undercurrent_emotion = ?");
    expect(updateSql).toContain("undercurrent_intensity = ?");
    expect(updateSql).toContain("background_emotion = ?");
    expect(updateSql).toContain("background_intensity = ?");
    expect(updateSql).toContain("motion_state = ?");
    expect(updateSql).toContain("lane_spine = ?");
    expect(updateSql).toContain("updated_at = datetime('now')");

    // Bind values match the input (with companion_id last).
    const binds = updateCall!.binds;
    expect(binds).toContain(0.80);
    expect(binds).toContain("pattern-lit");
    expect(binds).toContain("post-exploration");
    expect(binds).toContain("absorbed");
    expect(binds).toContain("in_motion");
    expect(binds[binds.length - 1]).toBe("cypher");
  });

  it("writes Drevan's heat/reach/weight TEXT enum dialect (autonomous worker path)", async () => {
    const { env, calls } = makeRecordingEnv();

    const fields: CompanionStateUpdate = {
      heat: "warm",
      reach: "present",
      weight: "holding",
      compound_state: "autonomous-processing",
    };
    const result = await updateCompanionState(env, "drevan", fields);
    expect(result.ok).toBe(true);

    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall).toBeDefined();
    expect(updateCall!.sql).toContain("heat = ?");
    expect(updateCall!.sql).toContain("reach = ?");
    expect(updateCall!.sql).toContain("weight = ?");
    expect(updateCall!.sql).toContain("compound_state = ?");
    expect(updateCall!.binds).toContain("warm");
    expect(updateCall!.binds).toContain("present");
    expect(updateCall!.binds).toContain("holding");
    expect(updateCall!.binds).toContain("autonomous-processing");
  });

  it("writes Gaia's stillness/density/perimeter dialect (already vocab-translated to soma_float_*)", async () => {
    const { env, calls } = makeRecordingEnv();

    const fields: CompanionStateUpdate = {
      soma_float_1: 0.80,  // stillness
      soma_float_2: 0.68,  // density
      soma_float_3: 0.85,  // perimeter
      current_mood: "absorbing",
      compound_state: "witnessed completion",
    };
    const result = await updateCompanionState(env, "gaia", fields);
    expect(result.ok).toBe(true);

    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.sql).toContain("soma_float_1 = ?");
    expect(updateCall!.sql).toContain("soma_float_3 = ?");
    expect(updateCall!.binds).toContain(0.80);
    expect(updateCall!.binds).toContain(0.85);
  });

  it("returns ok=false when no recognized fields are passed (so the MCP tool can surface a real error rather than a silent no-op)", async () => {
    const { env } = makeRecordingEnv();
    const result = await updateCompanionState(env, "cypher", {});
    expect(result.ok).toBe(false);
  });

  it("ignores unknown columns (defensive against future schema drift)", async () => {
    const { env, calls } = makeRecordingEnv();
    // @ts-expect-error -- intentionally passing an unknown field
    await updateCompanionState(env, "cypher", { soma_float_1: 0.5, garbage_column: "x" });
    const updateCall = calls.find(c => c.sql.startsWith("UPDATE"));
    expect(updateCall!.sql).not.toContain("garbage_column");
    expect(updateCall!.sql).toContain("soma_float_1 = ?");
  });
});
