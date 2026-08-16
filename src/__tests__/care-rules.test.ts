// Care-loop rule table (consequence layer C1, mig 0121). Pure: signals in, firings out, injected
// values only -- the reaction-tier.ts testing shape. These tests pin the INVARIANTS (what can and
// cannot fire, and why) more than the exact thresholds.

import { describe, it, expect } from "vitest";
import {
  evaluateCareRules,
  assignCompanion,
  moodIsLow,
  CARE_COMPANIONS,
  LOW_SPOONS_MAX,
  BIOMETRICS_FRESH_HOURS,
  MEDS_MISSED_HOURS,
  MEDS_TAKEN_SUPPRESS_HOURS,
  OWNER_SILENCE_HOURS,
  RULE_COOLDOWN_HOURS,
  type CareSignals,
} from "../care/rules.js";
import { deriveRazielState, EMPTY_CARE } from "../mind/blocks/care.js";
import { razielStateBlock } from "../librarian/response/orient-blocks.js";

const quiet: CareSignals = {
  spoons: null,
  mood: null,
  meds_taken: null,
  biometrics_age_hours: null,
  meds_logged_age_hours: null,
  owner_silence_hours: null,
  owner_last_source: null,
  last_fired_hours: {},
};

describe("low_spoons", () => {
  it("fires on a fresh reading at the line", () => {
    const out = evaluateCareRules({ ...quiet, spoons: LOW_SPOONS_MAX, biometrics_age_hours: 3 });
    expect(out.map(f => f.rule)).toEqual(["low_spoons"]);
    expect(out[0]!.detail).toContain(`spoons ${LOW_SPOONS_MAX}/12`);
  });

  it("does not fire above the line", () => {
    expect(evaluateCareRules({ ...quiet, spoons: LOW_SPOONS_MAX + 1, biometrics_age_hours: 3 })).toEqual([]);
  });

  it("a stale reading cannot fire -- a three-day-old '2 spoons' is history, not a state", () => {
    expect(evaluateCareRules({ ...quiet, spoons: 1, biometrics_age_hours: BIOMETRICS_FRESH_HOURS + 1 })).toEqual([]);
  });

  it("absent spoons is not zero spoons", () => {
    expect(evaluateCareRules({ ...quiet, spoons: null, biometrics_age_hours: 1 })).toEqual([]);
  });

  it("cooldown suppresses a repeat firing; expiry re-arms it", () => {
    const base = { ...quiet, spoons: 0, biometrics_age_hours: 1 };
    expect(evaluateCareRules({ ...base, last_fired_hours: { low_spoons: RULE_COOLDOWN_HOURS.low_spoons - 1 } })).toEqual([]);
    expect(evaluateCareRules({ ...base, last_fired_hours: { low_spoons: RULE_COOLDOWN_HOURS.low_spoons + 1 } }).map(f => f.rule)).toEqual(["low_spoons"]);
  });
});

describe("meds_missed", () => {
  it("fires when the routine gap crosses the threshold", () => {
    const out = evaluateCareRules({ ...quiet, meds_logged_age_hours: MEDS_MISSED_HOURS });
    expect(out.map(f => f.rule)).toEqual(["meds_missed"]);
  });

  it("no meds routine ever logged means NO firing -- absent history is not a missed dose", () => {
    expect(evaluateCareRules({ ...quiet, meds_logged_age_hours: null })).toEqual([]);
  });

  it("a recent meds_taken=1 biometrics row suppresses it (took them, didn't log the routine)", () => {
    expect(evaluateCareRules({
      ...quiet,
      meds_logged_age_hours: MEDS_MISSED_HOURS + 5,
      meds_taken: 1,
      biometrics_age_hours: MEDS_TAKEN_SUPPRESS_HOURS - 1,
    })).toEqual([]);
  });

  it("an OLD meds_taken=1 row does not suppress -- yesterday's dose says nothing about today", () => {
    const out = evaluateCareRules({
      ...quiet,
      meds_logged_age_hours: MEDS_MISSED_HOURS + 5,
      meds_taken: 1,
      biometrics_age_hours: MEDS_TAKEN_SUPPRESS_HOURS + 5,
    });
    expect(out.map(f => f.rule)).toEqual(["meds_missed"]);
  });
});

describe("owner_silence", () => {
  it("needs BOTH silence and a known-low last mood", () => {
    expect(evaluateCareRules({ ...quiet, owner_silence_hours: OWNER_SILENCE_HOURS + 1 })).toEqual([]);
    expect(evaluateCareRules({ ...quiet, owner_silence_hours: OWNER_SILENCE_HOURS + 1, mood: "steady" })).toEqual([]);
    const out = evaluateCareRules({
      ...quiet,
      owner_silence_hours: OWNER_SILENCE_HOURS + 1,
      mood: "wrung out",
      owner_last_source: "commons",
    });
    expect(out.map(f => f.rule)).toEqual(["owner_silence"]);
    // The detail states its denominator: which source last saw him, and what was checked.
    expect(out[0]!.detail).toContain("commons");
    expect(out[0]!.detail).toContain("sources:");
  });

  it("no owner signal anywhere is unreachable, not infinite silence -- it must not fire", () => {
    expect(evaluateCareRules({ ...quiet, owner_silence_hours: null, mood: "low" })).toEqual([]);
  });
});

describe("moodIsLow", () => {
  it("matches the lexicon, case-insensitive, inside free text", () => {
    expect(moodIsLow("Wrung out and heavy")).toBe(true);
    expect(moodIsLow("pretty good actually")).toBe(false);
    expect(moodIsLow(null)).toBe(false);
  });
});

describe("assignCompanion", () => {
  it("is deterministic and rotates by day", () => {
    const a = assignCompanion("low_spoons", 100);
    expect(assignCompanion("low_spoons", 100)).toBe(a);
    expect(assignCompanion("low_spoons", 101)).not.toBe(a);
  });

  it("spreads simultaneous rules across different companions", () => {
    const day = 4242;
    const assigned = new Set([
      assignCompanion("low_spoons", day),
      assignCompanion("meds_missed", day),
      assignCompanion("owner_silence", day),
    ]);
    expect(assigned.size).toBe(CARE_COMPANIONS.length);
  });
});

describe("deriveRazielState", () => {
  const bio = {
    id: "b1", recorded_at: "2026-08-16T00:00:00Z", hrv_resting: null, resting_hr: null,
    sleep_hours: null, sleep_quality: null, stress_score: null, steps: null, active_energy: null,
    notes: null, mood: "wrung out", pain: 6, energy: 3, focus: null, spoons: 2, meds_taken: 0,
  };

  it("composes readings, staleness, and care state", () => {
    const nowMs = Date.parse("2026-08-16T05:00:00Z");
    const rs = deriveRazielState(bio, { front_state: "Ash", care_hold: true, pending_care: null }, nowMs);
    expect(rs).not.toBeNull();
    expect(rs!.spoons).toBe(2);
    expect(rs!.staleness_hours).toBe(5);
    expect(rs!.front_state).toBe("Ash");
    expect(rs!.care_hold).toBe(true);
  });

  it("returns null only when there is nothing at all to show", () => {
    expect(deriveRazielState(null, EMPTY_CARE)).toBeNull();
    expect(deriveRazielState(null, { ...EMPTY_CARE, front_state: "Ash" })).not.toBeNull();
  });
});

describe("razielStateBlock renderer", () => {
  it("renders readings with age, hold, and the pending gesture", () => {
    const block = razielStateBlock({
      spoons: 2, mood: "wrung out", pain: 6, energy: 3, meds_taken: 0,
      staleness_hours: 5, front_state: "Ash", care_hold: true,
      pending_care: { id: "c1", rule: "low_spoons", detail: "spoons 2/12, logged 5h ago", detected_at: "2026-08-16T05:00:00Z" },
    });
    expect(block).toContain("[Raziel -- register]");
    expect(block).toContain("spoons 2/12");
    expect(block).toContain("logged 5h ago");
    expect(block).toContain("Fronting: Ash");
    expect(block).toContain("Care hold is ON");
    expect(block).toContain("pending care gesture");
  });

  it("flags a stale reading loudly instead of presenting it as current", () => {
    const block = razielStateBlock({
      spoons: 2, mood: null, pain: null, energy: null, meds_taken: null,
      staleness_hours: 80, front_state: null, care_hold: false, pending_care: null,
    });
    expect(block).toContain("STALE");
    expect(block).toContain("weigh lightly");
  });

  it("renders nothing when there is no register", () => {
    expect(razielStateBlock(null)).toBe("");
  });
});
