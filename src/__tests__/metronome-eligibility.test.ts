import { describe, it, expect } from "vitest";
import {
  isEligible, isValidActionType, VALID_ACTION_TYPES,
  isQuietHours, localHourIn, quietHoursVerdict, QUIET_HOURS_PRESENCE_WINDOW_HOURS,
  type MetronomeAction, type EligibilityContext,
} from "../webmind/metronome.js";

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
    inQuietHours: false,
    ...overrides,
  };
}

// Anchors chosen so a FIXED offset gets them wrong. America/Chicago is CDT (UTC-5) in July and
// CST (UTC-6) in December; each pair below is 22:00 local on one side of the DST boundary.
const CDT_2200 = "2026-07-15T03:00:00.000Z"; // 22:00 CDT on 07-14
const CST_2200 = "2026-12-15T04:00:00.000Z"; // 22:00 CST on 12-14
const CST_2100 = "2026-12-15T03:00:00.000Z"; // 21:00 CST -- a fixed -5 offset would read this as 22:00
const CDT_0000 = "2026-07-15T05:00:00.000Z"; // 00:00 CDT (the midnight "24" trap)
const CDT_0600 = "2026-07-15T11:00:00.000Z"; // 06:00 CDT -- end is exclusive, so already morning
const TZ = "America/Chicago";

describe("quiet hours -- DST-aware local window (B7 step 1, 2026-09-27)", () => {
  it("22:00 local is quiet on BOTH DST sides (the regression a fixed UTC offset causes)", () => {
    expect(isQuietHours(CDT_2200, TZ, 22, 6)).toBe(true);
    expect(isQuietHours(CST_2200, TZ, 22, 6)).toBe(true);
  });

  it("21:00 CST is NOT quiet (a hardcoded -5 offset would misread it as 22:00 and suppress)", () => {
    expect(localHourIn(CST_2100, TZ)).toBe(21);
    expect(isQuietHours(CST_2100, TZ, 22, 6)).toBe(false);
  });

  it("the window wraps midnight: 00:00 local is inside it, and the hour is 0 not 24", () => {
    expect(localHourIn(CDT_0000, TZ)).toBe(0);
    expect(isQuietHours(CDT_0000, TZ, 22, 6)).toBe(true);
  });

  it("the end hour is exclusive: 06:00 local is morning, not quiet", () => {
    expect(localHourIn(CDT_0600, TZ)).toBe(6);
    expect(isQuietHours(CDT_0600, TZ, 22, 6)).toBe(false);
  });

  it("midday is not quiet", () => {
    expect(isQuietHours("2026-07-15T17:00:00.000Z", TZ, 22, 6)).toBe(false); // 12:00 CDT
  });

  it("a same-day (non-wrapping) window still works", () => {
    expect(isQuietHours("2026-07-15T17:00:00.000Z", TZ, 9, 17)).toBe(true);  // 12:00 CDT
    expect(isQuietHours("2026-07-15T03:00:00.000Z", TZ, 9, 17)).toBe(false); // 22:00 CDT
  });

  it("FAILS CLOSED on an invalid timezone, an unparseable date, or an out-of-range hour", () => {
    expect(isQuietHours(CDT_0600, "Not/AZone", 22, 6)).toBe(true);
    expect(localHourIn(CDT_0600, "Not/AZone")).toBe(null);
    expect(isQuietHours("not-a-date", TZ, 22, 6)).toBe(true);
    expect(isQuietHours(CDT_0600, TZ, 99, 6)).toBe(true);
    expect(isQuietHours(CDT_0600, TZ, 22, -1)).toBe(true);
    expect(isQuietHours(CDT_0600, TZ, 22, 22)).toBe(true); // degenerate config reads as always quiet
  });
});

describe("quietHoursVerdict -- the presence exception", () => {
  it("does NOT lift the window when he has been silent longer than the presence window", () => {
    const v = quietHoursVerdict(CDT_2200, TZ, 22, 6, 4);
    expect(v.active).toBe(true);
    expect(v.in_force).toBe(true);
    expect(v.local_hour).toBe(22);
  });

  it("lifts the window when he spoke within the presence window (the 2am case, he is awake)", () => {
    const v = quietHoursVerdict(CDT_0000, TZ, 22, 6, QUIET_HOURS_PRESENCE_WINDOW_HOURS - 0.1);
    expect(v.active).toBe(true);
    expect(v.in_force).toBe(false);
  });

  it("null silence (expired activity key = a LONG quiet stretch) never counts as presence", () => {
    expect(quietHoursVerdict(CDT_0000, TZ, 22, 6, null).in_force).toBe(true);
  });

  it("outside the window nothing is in force either way", () => {
    expect(quietHoursVerdict(CDT_0600, TZ, 22, 6, null).in_force).toBe(false);
    expect(quietHoursVerdict(CDT_0600, TZ, 22, 6, 0.1).active).toBe(false);
  });
});

describe("isEligible -- quiet hours gate", () => {
  it("drops an action during quiet hours when quiet_hours_allowed is not 1", () => {
    expect(isEligible(action({ quiet_hours_allowed: 0 }), ctx({ inQuietHours: true }))).toBe(false);
  });

  it("passes an action marked quiet_hours_allowed = 1 during quiet hours", () => {
    expect(isEligible(action({ quiet_hours_allowed: 1 }), ctx({ inQuietHours: true }))).toBe(true);
  });

  it("is checked FIRST: a quiet-hours drop beats every other condition it would also have passed", () => {
    const a = action({ quiet_hours_allowed: 0, silence_min_hours: 6, cooldown_hours: null });
    expect(isEligible(a, ctx({ inQuietHours: true, silenceHours: 12 }))).toBe(false);
    expect(isEligible(a, ctx({ inQuietHours: false, silenceHours: 12 }))).toBe(true);
  });

  it("changes nothing when quiet hours are not in force", () => {
    expect(isEligible(action({ quiet_hours_allowed: 0 }), ctx({ inQuietHours: false }))).toBe(true);
  });

  it("a quiet_hours_allowed action is still subject to cooldown and cap (the gate only subtracts)", () => {
    const cooled = action({
      quiet_hours_allowed: 1, cooldown_hours: 8, last_fired_at: "2026-06-17T08:00:00.000Z",
    });
    expect(isEligible(cooled, ctx({ inQuietHours: true }))).toBe(false);
    const capped = action({
      quiet_hours_allowed: 1, max_per_day: 1, fire_count_today: 1, fire_count_reset_at: "2026-06-17",
    });
    expect(isEligible(capped, ctx({ inQuietHours: true }))).toBe(false);
  });
});

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
