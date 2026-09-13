// Graph memory Phase 2, tranche 1 -- the [Why these numbers] renderer
// (docs/PLAN-graph-memory-phase-2-soma-provenance-2026-09-12.md, orient-blocks.ts::provenanceBlock).
//
// The block exists because the floats had no history: no writer logged a before/after or its own
// identity, so "heat 0.68, apparently" was the most honest thing a companion could say. These tests
// pin the phrasing per kind, the self-cap, and the two shapes that are easy to get wrong -- a null
// after_value (the ONLY shape the backfill produces) and newest-per-float selection.

import { describe, it, expect } from "vitest";
import { provenanceBlock, type SomaProvenanceRow } from "../librarian/response/orient-blocks.js";

function entry(over: Partial<SomaProvenanceRow> = {}): SomaProvenanceRow {
  return {
    float_key: "soma_float_1", label: "acuity",
    kind: "authored_close", writer: "cypher",
    before_value: 0.62, after_value: 0.78, delta: 0.16,
    cause_table: "handover_packets", cause_id: "h1",
    cause_label: "fleet check: bots lost the key",
    session_id: "s1", alongside_notes: 0,
    created_at: "2026-09-11T22:00:00.000Z",
    ...over,
  };
}

describe("provenanceBlock -- shape", () => {
  it("empty input renders nothing at all -- no header, no placeholder", () => {
    expect(provenanceBlock([])).toBe("");
  });

  it("renders the [Why these numbers] header and one bullet per float", () => {
    const out = provenanceBlock([entry(), entry({ float_key: "soma_float_2", label: "presence", kind: "tick" })]);
    expect(out.startsWith("\n[Why these numbers]\n")).toBe(true);
    expect(out.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(2);
  });

  it("renders values as `label 0.78 (was 0.62)`", () => {
    expect(provenanceBlock([entry()])).toContain("acuity 0.78 (was 0.62)");
  });

  it("drops the (was ...) clause when before_value is null", () => {
    const out = provenanceBlock([entry({ before_value: null })]);
    expect(out).toContain("acuity 0.78 —");
    expect(out).not.toContain("was");
  });

  it("renders the float NAME alone when after_value is null -- the backfilled-ferment shape", () => {
    // The plan is explicit that backfilled ferment events know the delta and not the absolute, and
    // until a real authored close lands those are the only rows in the table. A line with no number
    // still answers "where did this come from"; a dropped line answers nothing.
    const out = provenanceBlock([entry({ kind: "tick", label: "presence", before_value: null, after_value: null })]);
    expect(out).toContain("• presence — settled toward home (tick)");
  });
});

describe("provenanceBlock -- phrasing per kind", () => {
  it("authored_close names the day and quotes the cause", () => {
    expect(provenanceBlock([entry()])).toContain(`you set it at close 2026-09-11: "fleet check: bots lost the key"`);
  });

  it("authored_close appends the alongside note count only when there were notes", () => {
    // Short cause_label on purpose: the realistic 80-char one pushes the line past the 110 cap and
    // the count is what gets truncated -- correct behaviour (the cap is the cap), but it would make
    // this test about truncation instead of about the suffix.
    expect(provenanceBlock([entry({ cause_label: "fleet check", alongside_notes: 2 })])).toContain("· 2 notes that session");
    expect(provenanceBlock([entry({ cause_label: "fleet check", alongside_notes: 0 })])).not.toContain("notes that session");
  });

  it("authored_update states only the day -- a bare state write has no cause row yet", () => {
    expect(provenanceBlock([entry({ kind: "authored_update", cause_table: null, cause_id: null, cause_label: null })]))
      .toContain("acuity 0.78 (was 0.62) — you set it 2026-09-11");
  });

  it("tick says it settled toward home, and names silence when the detail says so", () => {
    expect(provenanceBlock([entry({ kind: "tick" })])).toContain("settled toward home (tick)");
    expect(provenanceBlock([entry({ kind: "tick", detail: "silence" })])).toContain("settled toward home (tick, silence)");
  });

  it("stimulus names the stimulus, falling back to cause_label when detail is absent", () => {
    expect(provenanceBlock([entry({ kind: "stimulus", detail: "message_from_raziel" })])).toContain("stimulus: message_from_raziel");
    expect(provenanceBlock([entry({ kind: "stimulus", cause_label: "tend_creature" })])).toContain("stimulus: tend_creature");
  });

  it("drift_shift quotes the reason head", () => {
    expect(provenanceBlock([entry({ kind: "drift_shift", cause_label: "becoming slower on purpose" })]))
      .toContain(`drift: "becoming slower on purpose"`);
  });
});

describe("provenanceBlock -- self-cap", () => {
  it("keeps the FIRST entry per float (input is newest-first from the loader) and ignores the rest", () => {
    const out = provenanceBlock([
      entry({ label: "acuity", after_value: 0.78, created_at: "2026-09-11T22:00:00.000Z" }),
      entry({ label: "acuity", after_value: 0.10, created_at: "2026-09-01T22:00:00.000Z" }),
    ]);
    expect(out).toContain("acuity 0.78");
    expect(out).not.toContain("0.10");
    expect(out.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(1);
  });

  it("renders at most 3 lines even with four distinct floats", () => {
    const out = provenanceBlock(
      ["soma_float_1", "soma_float_2", "soma_float_3", "soma_float_4"].map((k, i) =>
        entry({ float_key: k, label: `f${i}` })),
    );
    expect(out.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(3);
  });

  it("hard-truncates a long line at 110 chars with an ellipsis", () => {
    const out = provenanceBlock([entry({ cause_label: "x".repeat(300) })]);
    const content = out.split("\n").find((l) => l.startsWith("• "))!.slice(2);
    // Same convention as neighborhoodBlock: content truncated to N-1 + the ellipsis glyph.
    expect(content).toHaveLength(110);
    expect(content.endsWith("…")).toBe(true);
  });

  it("respects an explicit maxLines override", () => {
    const out = provenanceBlock(
      ["soma_float_1", "soma_float_2", "soma_float_3"].map((k) => entry({ float_key: k })),
      { maxLines: 1 },
    );
    expect(out.split("\n").filter((l) => l.startsWith("• "))).toHaveLength(1);
  });
});
