import { describe, it, expect } from "vitest";
import { isEligible, isValidActionType, VALID_ACTION_TYPES, type MetronomeAction, type EligibilityContext } from "../webmind/metronome.js";

// Minimal factory: a fully-populated row with sane defaults, overridable per test.
function action(overrides: Partial<MetronomeAction> = {}): MetronomeAction {
  return {
    id: "a1",
    companion_id: "cypher",
    name: "post heartbeat",
    action_type: "post_heartbeat",
    target: null,
    prompt: null,
    quiet_hours_allowed: 0,
    status: "on",
    silence_min_hours: null,
    silence_max_hours: null,
    max_per_day: null,
    cooldown_hours: null,
    requires_signal: null,
    signal_lookback_hours: null,
    last_fired_at: null,
    fire_count_today: 0,
    fire_count_reset_at: null,
    created_at: "2026-06-17T00:00:00.000Z",
    updated_at: "2026-06-17T00:00:00.000Z",
    ...overrides,
  } as MetronomeAction;
}

function ctx(overrides: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    silenceHours: null,
    nowIso: "2026-06-17T12:00:00.000Z",
    todayUtc: "2026-06-17",
    ...overrides,
  };
}

describe("metronome isEligible -- silence floor null semantics (2026-06-17 heartbeat-starvation fix)", () => {
  it("null silenceHours SATISFIES a silence_min_hours floor (expired key = long quiet = should fire)", () => {
    // Regression: before the fix, null disqualified every silence-floored action, so
    // post_heartbeat (and all heartbeat-channel actions, which carry 6-24h floors) could
    // never fire while the floorless inter-companion/note actions always won.
    const a = action({ silence_min_hours: 6 });
    expect(isEligible(a, ctx({ silenceHours: null }))).toBe(true);
  });

  it("a measured silence BELOW the floor still filters the action out", () => {
    const a = action({ silence_min_hours: 6 });
    expect(isEligible(a, ctx({ silenceHours: 2 }))).toBe(false);
  });

  it("a measured silence AT/above the floor passes", () => {
    const a = action({ silence_min_hours: 6 });
    expect(isEligible(a, ctx({ silenceHours: 6 }))).toBe(true);
    expect(isEligible(a, ctx({ silenceHours: 9 }))).toBe(true);
  });

  it("null silenceHours FAILS a silence_max_hours ceiling (too quiet for recency-gated actions)", () => {
    // A silence_max ceiling gates an action to 'only while activity is still recent'
    // (the prod share_media rows use this) -- null silence = too quiet to qualify.
    const a = action({ silence_max_hours: 48 });
    expect(isEligible(a, ctx({ silenceHours: null }))).toBe(false);
    expect(isEligible(a, ctx({ silenceHours: 20 }))).toBe(true);
    expect(isEligible(a, ctx({ silenceHours: 60 }))).toBe(false);
  });

  it("cooldown_hours still filters a recently-fired action regardless of silence", () => {
    const a = action({
      silence_min_hours: 6,
      cooldown_hours: 8,
      last_fired_at: "2026-06-17T08:00:00.000Z", // 4h before nowIso 12:00
    });
    expect(isEligible(a, ctx({ silenceHours: null }))).toBe(false);
  });

  it("max_per_day still caps a floorless action that has hit its daily count today", () => {
    const a = action({
      action_type: "write_inter_companion",
      silence_min_hours: null,
      max_per_day: 1,
      fire_count_today: 1,
      fire_count_reset_at: "2026-06-17",
    });
    expect(isEligible(a, ctx({ silenceHours: null }))).toBe(false);
  });
});

describe("VALID_ACTION_TYPES -- declare_preference metronome affordance (mig 0108, Wave 3 starvation fix)", () => {
  it("includes declare_preference", () => {
    expect(VALID_ACTION_TYPES).toContain("declare_preference");
    expect(isValidActionType("declare_preference")).toBe(true);
  });

  it("does NOT include declare_refusal (deliberate: refusals must come from genuine friction, not a metronome prompt)", () => {
    expect(VALID_ACTION_TYPES).not.toContain("declare_refusal");
    expect(isValidActionType("declare_refusal")).toBe(false);
  });

  it("also validates the action types the DB CHECK (mig 0093/0090/0072) already allowed but this guard had never caught up to", () => {
    // Pre-existing gap found while fixing this: share_media (0072), tend_creature (0090), and
    // drift_open (0093) were all valid in the D1 CHECK but missing from this TS type guard --
    // any admin-API attempt to create/patch a metronome_actions row with one of these types
    // would have failed client-side validation despite being perfectly valid in the DB.
    for (const t of ["share_media", "tend_creature", "drift_open"]) {
      expect(VALID_ACTION_TYPES).toContain(t);
      expect(isValidActionType(t)).toBe(true);
    }
  });
});
