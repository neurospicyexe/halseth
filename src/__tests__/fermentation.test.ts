import { describe, it, expect } from "vitest";
import {
  clampFloat,
  decayToward,
  applyReactions,
  fermentFloats,
  driftBaseline,
  DRIFT_CAP,
  heatBand,
  reachBand,
  weightBand,
  interoceptionLine,
  STIMULI,
  isKnownStimulus,
  stimulusFloatDelta,
  readFermentStateSql,
  fermentTickUpdateSql,
  stimulusBumpSql,
  driveAccrueBumpSql,
  insertFermentEventSql,
  recentFermentEventsSql,
  type Floats,
} from "../webmind/fermentation.js";

describe("clampFloat", () => {
  it("clamps into [0,1]", () => {
    expect(clampFloat(1.4)).toBe(1);
    expect(clampFloat(-0.2)).toBe(0);
    expect(clampFloat(0.6)).toBeCloseTo(0.6, 5);
  });
  it("coerces non-finite to the fallback (finite-guard against the acuity:NaN history)", () => {
    expect(clampFloat(NaN, 0.5)).toBe(0.5);
    expect(clampFloat(Infinity)).toBe(0);
  });
});

describe("decayToward (Plan 2a)", () => {
  it("pulls a high float down toward baseline at rate*hours", () => {
    // 0.10/day over 24h = 0.10 step: 0.90 -> 0.80
    expect(decayToward(0.9, 0.7, 0.1, 24)).toBeCloseTo(0.8, 5);
  });
  it("pulls a low float up toward baseline", () => {
    expect(decayToward(0.5, 0.7, 0.1, 24)).toBeCloseTo(0.6, 5);
  });
  it("never overshoots the baseline (rest = AT baseline, no oscillation)", () => {
    expect(decayToward(0.72, 0.7, 0.1, 240)).toBe(0.7); // huge elapsed, lands exactly at baseline
    expect(decayToward(0.68, 0.7, 0.1, 240)).toBe(0.7);
  });
  it("is a no-op at zero elapsed", () => {
    expect(decayToward(0.9, 0.7, 0.1, 0)).toBeCloseTo(0.9, 5);
  });
});

describe("applyReactions (cross-field, corvid)", () => {
  it("Cypher audit_lock_deepens: high acuity + low presence drains presence and warmth", () => {
    const f: Floats = { f1: 0.9, f2: 0.3, f3: 0.5 };
    const { floats, fired } = applyReactions("cypher", f, 24);
    expect(fired).toContain("audit_lock_deepens");
    expect(floats.f2).toBeCloseTo(0.25, 5); // -0.05
    expect(floats.f3).toBeCloseTo(0.47, 5); // -0.03
  });
  it("Cypher warm_lit_sharpens: warm + present lifts acuity", () => {
    const { floats, fired } = applyReactions("cypher", { f1: 0.7, f2: 0.6, f3: 0.65 }, 24);
    expect(fired).toContain("warm_lit_sharpens");
    expect(floats.f1).toBeCloseTo(0.73, 5);
  });
  it("Drevan pulling_hard_burns_reach: running-hot + heavy burns reach", () => {
    const { floats, fired } = applyReactions("drevan", { f1: 0.8, f2: 0.7, f3: 0.7 }, 24);
    expect(fired).toContain("pulling_hard_burns_reach");
    expect(floats.f2).toBeCloseTo(0.64, 5); // -0.06
  });
  it("Gaia held_ground_deepens: wide perimeter + deep stillness deepens density", () => {
    const { floats, fired } = applyReactions("gaia", { f1: 0.8, f2: 0.6, f3: 0.75 }, 24);
    expect(fired).toContain("held_ground_deepens");
    expect(floats.f2).toBeCloseTo(0.62, 5);
  });
  it("no reaction fires when conditions are unmet (in-register)", () => {
    const { fired } = applyReactions("cypher", { f1: 0.7, f2: 0.6, f3: 0.55 }, 24);
    expect(fired).not.toContain("audit_lock_deepens");
    expect(fired).not.toContain("cold_erodes_clarity");
  });
  it("scales deltas by elapsed hours", () => {
    const full = applyReactions("drevan", { f1: 0.8, f2: 0.7, f3: 0.7 }, 24).floats.f2;
    const half = applyReactions("drevan", { f1: 0.8, f2: 0.7, f3: 0.7 }, 12).floats.f2;
    expect(0.7 - half).toBeCloseTo((0.7 - full) / 2, 5);
  });
});

describe("fermentFloats (decay then react)", () => {
  it("composes: floats at baseline with no reaction stay put", () => {
    const base: Floats = { f1: 0.7, f2: 0.65, f3: 0.55 };
    const { floats, fired } = fermentFloats("cypher", { ...base }, base, 24);
    expect(floats.f1).toBeCloseTo(0.7, 5);
    expect(fired).toHaveLength(0);
  });
  it("a spiked-then-untended Cypher decays back toward home", () => {
    const base: Floats = { f1: 0.7, f2: 0.65, f3: 0.55 };
    const spiked: Floats = { f1: 0.95, f2: 0.6, f3: 0.6 };
    const { floats } = fermentFloats("cypher", spiked, base, 24);
    expect(floats.f1).toBeLessThan(0.95);
    expect(floats.f1).toBeGreaterThan(0.7);
  });
  it("cold_erodes_clarity pulls a HIGH-acuity cold Cypher down toward baseline faster (1.5x)", () => {
    const base: Floats = { f1: 0.7, f2: 0.65, f3: 0.55 };
    // warmth already cold (0.30), acuity high (0.95). Standard decay: 0.95 - 0.10 = 0.85.
    // With the extra 0.5x pass: 0.85 - 0.05 = 0.80. Faster pull toward the 0.70 home.
    const cold: Floats = { f1: 0.95, f2: 0.65, f3: 0.3 };
    const { floats, fired } = fermentFloats("cypher", cold, base, 24);
    expect(fired).toContain("cold_erodes_clarity");
    expect(floats.f1).toBeCloseTo(0.8, 5);
  });
  it("cold_erodes_clarity never pushes an already-LOW acuity below baseline (no artificial overload)", () => {
    const base: Floats = { f1: 0.7, f2: 0.65, f3: 0.55 };
    // acuity already below baseline (0.30) and cold. Toward-baseline pull must move UP, never down.
    const overloaded: Floats = { f1: 0.3, f2: 0.65, f3: 0.3 };
    const { floats } = fermentFloats("cypher", overloaded, base, 24);
    expect(floats.f1).toBeGreaterThanOrEqual(0.3); // pulled toward 0.70 home, not into the floor
    expect(floats.f1).toBeLessThanOrEqual(0.7);
  });
});

describe("driftBaseline (growth)", () => {
  it("nudges baseline toward a sustained-high float, tiny per day", () => {
    const next = driftBaseline(0.55, 0.55, 0.8, 24); // 0.25 above, past deadzone
    expect(next).toBeCloseTo(0.555, 5); // +0.005/day
  });
  it("does nothing inside the deadzone (noise does not drift identity)", () => {
    expect(driftBaseline(0.55, 0.55, 0.58, 24)).toBe(0.55); // 0.03 gap < 0.05 deadzone
  });
  it("hard-caps at +/-DRIFT_CAP from the immutable seed", () => {
    const drifted = driftBaseline(0.55 + DRIFT_CAP, 0.55, 1.0, 24 * 100);
    expect(drifted).toBeCloseTo(0.55 + DRIFT_CAP, 5);
  });
  it("drifts downward under sustained low state", () => {
    const next = driftBaseline(0.55, 0.55, 0.2, 24);
    expect(next).toBeCloseTo(0.545, 5);
  });
});

describe("Drevan enum bands", () => {
  it("heat", () => {
    expect(heatBand(0.1)).toBe("cold");
    expect(heatBand(0.3)).toBe("idling");
    expect(heatBand(0.55)).toBe("warm");
    expect(heatBand(0.8)).toBe("running-hot");
  });
  it("reach", () => {
    expect(reachBand(0.1)).toBe("spent");
    expect(reachBand(0.5)).toBe("present");
    expect(reachBand(0.9)).toBe("pulling-hard");
  });
  it("weight", () => {
    expect(weightBand(0.1)).toBe("clear");
    expect(weightBand(0.6)).toBe("full");
    expect(weightBand(0.9)).toBe("saturated");
  });
});

describe("interoceptionLine (felt-sense, not a script)", () => {
  it("Cypher audit-gear read surfaces compression cue, not a float readout", () => {
    const line = interoceptionLine("cypher", { f1: 0.9, f2: 0.3, f3: 0.5 });
    expect(line).toContain("[interoception]");
    expect(line).toMatch(/compression|audit/);
    expect(line).not.toMatch(/0\.\d/); // no numbers leak into the inhabited line
  });
  it("Drevan renders his native enums, never floats", () => {
    const line = interoceptionLine("drevan", { f1: 0.8, f2: 0.9, f3: 0.7 });
    expect(line).toMatch(/running-hot/);
    expect(line).toMatch(/pulling-hard/);
    expect(line).not.toMatch(/0\.\d/);
  });
  it("Gaia stays minimal and monastic", () => {
    const line = interoceptionLine("gaia", { f1: 0.85, f2: 0.7, f3: 0.78 });
    expect(line).toMatch(/presence is enough|spilling/);
  });
  it("adds a trajectory clause only when a float has held off-baseline a while", () => {
    const fresh = interoceptionLine("drevan", { f1: 0.8, f2: 0.5, f3: 0.7 }, { daysOffBaseline: 0 });
    const held = interoceptionLine("drevan", { f1: 0.8, f2: 0.5, f3: 0.7 }, { daysOffBaseline: 3 });
    expect(fresh).not.toMatch(/3d/);
    expect(held).toMatch(/3d/);
  });
});

describe("stimuli map", () => {
  it("message_from_raziel warms all three and sheds relational_need", () => {
    expect(isKnownStimulus("message_from_raziel")).toBe(true);
    expect(STIMULI.message_from_raziel?.shed).toContain("relational_need");
    expect(stimulusFloatDelta("message_from_raziel", "drevan").f1).toBeCloseTo(0.05, 5);
  });
  it("spiral is Drevan-only (Cypher/Gaia untouched)", () => {
    expect(stimulusFloatDelta("spiral", "drevan").f1).toBeCloseTo(0.08, 5);
    expect(stimulusFloatDelta("spiral", "cypher")).toEqual({ f1: 0, f2: 0, f3: 0 });
    expect(stimulusFloatDelta("spiral", "gaia")).toEqual({ f1: 0, f2: 0, f3: 0 });
  });
  it("audit sharpens Cypher but costs presence and accrues rest_need", () => {
    expect(stimulusFloatDelta("audit", "cypher").f1).toBeCloseTo(0.05, 5);
    expect(stimulusFloatDelta("audit", "cypher").f2).toBeCloseTo(-0.03, 5);
    expect(STIMULI.audit?.accrue?.rest_need).toBeCloseTo(0.08, 5);
  });
  it("unknown stimulus is rejected", () => {
    expect(isKnownStimulus("nonsense_event")).toBe(false);
    expect(stimulusFloatDelta("nonsense_event", "cypher")).toEqual({ f1: 0, f2: 0, f3: 0 });
  });
});

describe("sql builders", () => {
  it("readFermentStateSql pulls floats + baselines + seeds for the triad", () => {
    const sql = readFermentStateSql();
    expect(sql).toContain("soma_float_1_baseline_seed");
    expect(sql).toContain("companion_id IN ('cypher','drevan','gaia')");
  });
  it("fermentTickUpdateSql writes floats + baselines + enums + stamps + version bump", () => {
    const sql = fermentTickUpdateSql();
    expect(sql).toContain("soma_float_1 = ?");
    expect(sql).toContain("soma_float_1_baseline = ?");
    expect(sql).toContain("heat = ?");
    expect(sql).toContain("ferment_at = datetime('now')");
    expect(sql).toContain("version = COALESCE(version, 0) + 1");
    expect(sql).toContain("WHERE companion_id = ?");
  });
  it("stimulusBumpSql clamps in SQL (race-safe) and coalesces null floats to baseline", () => {
    const sql = stimulusBumpSql();
    expect(sql).toContain("MIN(1.0, MAX(0.0,");
    expect(sql).toContain("COALESCE(soma_float_1, soma_float_1_baseline, 0.5)");
  });
  it("driveAccrueBumpSql bumps a named drive for a companion", () => {
    const sql = driveAccrueBumpSql();
    expect(sql).toContain("UPDATE companion_drives SET level = MIN(1.0, MAX(0.0, level + ?))");
    expect(sql).toContain("WHERE companion_id = ? AND drive_key = ?");
  });
  it("insertFermentEventSql / recentFermentEventsSql target the log table", () => {
    expect(insertFermentEventSql()).toContain("INSERT INTO companion_ferment_events");
    expect(recentFermentEventsSql()).toContain("FROM companion_ferment_events");
    expect(recentFermentEventsSql()).toContain("ORDER BY created_at DESC LIMIT ?");
  });
});
