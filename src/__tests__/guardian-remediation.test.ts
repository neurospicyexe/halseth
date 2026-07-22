// Remediation hints (Wave 3 starvation fix, mig 0109, 2026-07-21): guardian flags describe
// a problem but never named the verb that already exists to act on it. This test anchors to
// a HARDCODED literal list of the guardian_flags.flag_type CHECK values (mirroring migration
// 0109 exactly) rather than deriving from REMEDIATION_HINTS' own keys -- a test that reads its
// expectation off the thing it's testing can never catch drift between the CHECK and the map,
// which is precisely the class of bug 0109 fixes (dead_writer was in the TS union and emitted
// by the detector for two weeks before the CHECK ever allowed it).

import { describe, it, expect } from "vitest";
import { REMEDIATION_HINTS, remediationHint } from "../guardian/remediation.js";

// Mirrors migrations/0109_guardian_dead_writer_check.sql's flag_type CHECK exactly.
const CHECK_FLAG_TYPES = [
  "voice_drift",
  "starved_organ",
  "loop_stuck",
  "burnout",
  "basin_pressure",
  "ratification_backlog",
  "orphan_memory",
  "echo_chamber",
  "dead_writer",
] as const;

describe("REMEDIATION_HINTS -- covers every guardian_flags.flag_type CHECK value", () => {
  it("has a non-empty hint for every CHECK value, including dead_writer", () => {
    for (const flagType of CHECK_FLAG_TYPES) {
      const hint = (REMEDIATION_HINTS as Record<string, string>)[flagType];
      expect(hint, `missing remediation hint for flag_type "${flagType}"`).toBeTruthy();
      expect(hint?.length).toBeGreaterThan(0);
    }
  });

  it("has exactly the CHECK's flag_types -- no extra, no missing (schema-drift tripwire)", () => {
    expect(new Set(Object.keys(REMEDIATION_HINTS))).toEqual(new Set(CHECK_FLAG_TYPES));
  });

  it("names an actual existing verb for the flag_types that have one", () => {
    expect(REMEDIATION_HINTS.loop_stuck).toContain("close loop");
    expect(REMEDIATION_HINTS.starved_organ).toContain("log a tension");
    expect(REMEDIATION_HINTS.basin_pressure).toContain("confirm drift");
    expect(REMEDIATION_HINTS.basin_pressure).toContain("dismiss drift");
    expect(REMEDIATION_HINTS.ratification_backlog).toContain("accept journal entry");
    expect(REMEDIATION_HINTS.ratification_backlog).toContain("decline journal entry");
  });

  it("is honest (no invented verb) for flag_types with no companion-facing affordance", () => {
    for (const flagType of ["voice_drift", "burnout", "echo_chamber", "dead_writer"] as const) {
      expect(REMEDIATION_HINTS[flagType]).toMatch(/surface it to Raziel/i);
    }
  });

  it("remediationHint() never throws and falls back honestly on an unrecognized flag_type", () => {
    for (const flagType of CHECK_FLAG_TYPES) {
      expect(remediationHint(flagType)).toBe(REMEDIATION_HINTS[flagType]);
    }
    expect(remediationHint("something_new_the_schema_added")).toMatch(/surface it to Raziel/i);
  });
});
