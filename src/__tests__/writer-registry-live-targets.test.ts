// A liveness probe may only watch a LIVE writer (2026-09-24).
//
// The `limbic_states` probe watched Brain's background synthesis loop, with a 6h threshold and a
// comment claiming "it survived the cutover". Brain was archived 2026-07-29 and Raziel retired
// felt.limbic on 2026-09-14, so the probe had been raising a `warning` that could never clear --
// 517 hours silent when it was finally read, i.e. three weeks of permanent alarm rendered into
// all three companions' orient, inside a prompt already over budget and dropping sections.
//
// Two costs, and the second is the real one: a dead check evicts a live one, and an alarm that
// can never clear teaches its reader to skip alarms ([[scheduled-restart-must-not-page]]).

import { describe, it, expect } from "vitest";
import { WRITER_REGISTRY } from "../guardian/writer-liveness.js";

// Tables belonging to systems that no longer run. A probe pointed at one of these cannot report
// health -- it can only ever report its own obsolescence, forever.
const ARCHIVED_TABLES = ["limbic_states", "swarm_threads", "brain_sessions"];

describe("WRITER_REGISTRY targets", () => {
  it("watches no table belonging to an archived system", () => {
    const offenders = WRITER_REGISTRY.filter(spec =>
      ARCHIVED_TABLES.some(t => spec.sql.toLowerCase().includes(t.toLowerCase())),
    ).map(spec => spec.key);
    expect(offenders).toEqual([]);
  });

  it("still watches the organs that REPLACED the archived ones", () => {
    // Removing a probe must not silently remove coverage. The register limbic_states carried is
    // now the per-companion soma floats, and those have their own probes.
    const keys = WRITER_REGISTRY.map(s => s.key);
    expect(keys.some(k => k.startsWith("somatic_snapshot:"))).toBe(true);
    expect(keys).toContain("wm_continuity_notes");
  });

  it("gives every probe a positive threshold, so none is a permanent alarm by construction", () => {
    for (const spec of WRITER_REGISTRY) {
      expect(spec.maxSilenceHours).toBeGreaterThan(0);
    }
  });
});
