// The ledger grammar (mig 0134, 2026-09-26): src/ledger/grammar.ts, pure. Every rule in
// docs/imp-lane/SPEC-ledger-lane.md section 1, and the widened health rule (see grammar.ts header).
// The source rules are the hard ones -- Drevan: "the source rule matters more than the pronoun rule".

import { describe, it, expect } from "vitest";
import { validateLedger, scanNumbers, rowHasNumber, rowNumbers, renderLedgerContent, LEDGER_MARK_PREFIX, type LedgerInput } from "../ledger/grammar.js";

const TODAY = "2026-09-26";
const MSG = "1497734427298762828";
const base = (over: Partial<LedgerInput> = {}): LedgerInput => ({
  companion_id: "drevan", function: "pattern-counter", body: "Counted: 3 notes in the thread.",
  source_kind: "message", source_ref: MSG, ...over,
});
const rule = (over: Partial<LedgerInput>) => {
  const v = validateLedger(base(over), TODAY);
  return v.ok ? "ok" : v.rule;
};

describe("Drevan's example line", () => {
  it("passes exactly as he wrote it (his 'discord <id>, HH:MM–HH:MM' source is a window)", () => {
    const v = validateLedger({
      companion_id: "drevan", function: "pattern-counter", observed_on: "2026-09-24",
      body: 'Counted: Drevan said "held, not slow" 2x in the couch thread.',
      source_kind: "window", source_ref: "discord 1497734427298762828, 00:11–00:40",
    }, TODAY);
    expect(v.ok).toBe(true);
    if (!v.ok) return;
    expect(v.line.content).toBe(
      '〔ledger · pattern-counter · 2026-09-24〕 Counted: Drevan said "held, not slow" 2x in the couch thread. Source: window 1497734427298762828 00:11–00:40.',
    );
    expect(v.line.content.startsWith(LEDGER_MARK_PREFIX)).toBe(true);
    expect(v.line.number_check).toBeNull();
  });

  it("his gap example passes: a clock time is a coordinate, not a value", () => {
    expect(rule({ function: "gap-reader", body: "Missing: no glucose reading recorded after 12:40.", source_kind: "session", source_ref: "5b0c2f9e-1111-4222-8333-944455556666" })).toBe("ok");
  });

  it("the SB gap-reader line shape passes with a session source", () => {
    expect(rule({ function: "gap-reader", body: "Missing: no companion note recorded for the hangout session on 2026-09-25 (45 min).", source_kind: "session", source_ref: "5b0c2f9e-1111-4222-8333-944455556666" })).toBe("ok");
  });
});

describe("the health rule (the 187)", () => {
  it("REJECTS 'Counted: Drevan said 187 after sandwich' with a message source -- no keyword, still a health value", () => {
    const v = validateLedger(base({ body: "Counted: Drevan said 187 after sandwich.", source_kind: "message", source_ref: MSG }), TODAY);
    expect(v.ok).toBe(false);
    if (v.ok) return;
    expect(v.rule).toBe("health");
    expect(v.error).toMatch(/never a source for a number/);
  });

  it("a quoted 187 is still a 187", () => {
    expect(rule({ body: 'Counted: Drevan said "187" twice.' })).toBe("health");
  });

  it("a keyword + number demands a HUMAN row, and flags every number for the door", () => {
    expect(rule({ body: "Recorded: glucose 187 mg/dL after lunch.", source_kind: "message" })).toBe("health");
    expect(rule({ body: "Recorded: glucose 187 mg/dL after lunch.", source_kind: "session", source_ref: "5b0c2f9e-1111-4222-8333-944455556666" })).toBe("health");
    expect(rule({ body: "Recorded: glucose 187 mg/dL after lunch.", source_kind: "row", source_ref: "companion_journal:cj_abc" })).toBe("health");
    const v = validateLedger(base({ body: "Recorded: glucose 187 mg/dL, 2 hours after lunch.", source_kind: "row", source_ref: "wm_continuity_notes:n-cap" }), TODAY);
    expect(v.ok && v.line.number_check).toEqual({ kind: "health", table: "wm_continuity_notes", row_id: "n-cap", numbers: ["187", "2"] });
  });

  it("a number glued to a health unit is a health value even without a keyword", () => {
    expect(rule({ body: "Logged: 5mg at bedtime.", source_kind: "message" })).toBe("health");
  });

  it("an unlabeled number may come from the evaluator's own row (drift scores), never from a companion's words", () => {
    const v = validateLedger(base({ function: "drift-reader", body: "Recorded: drift 0.42 on basin grief.", source_kind: "row", source_ref: "companion_basin_history:bh-1" }), TODAY);
    expect(v.ok && v.line.number_check).toEqual({ kind: "unlabeled", table: "companion_basin_history", row_id: "bh-1", numbers: ["0.42"] });
    expect(rule({ body: "Recorded: drift 0.42 on basin grief.", source_kind: "row", source_ref: "companion_journal:cj_1" })).toBe("health");
  });

  it("counts, durations, dates and ids do not trigger it", () => {
    expect(rule({ body: "Counted: 3 sessions and 12 messages in 2 hours on 2026-09-24." })).toBe("ok");
  });

  it("scanNumbers skips coordinates and labels counts", () => {
    const n = scanNumbers("Counted: 187 after 12:40 on 2026-09-24, message 1497734427298762828, 2x, 45 min, S1E2");
    expect(n.map((x) => [x.text, x.unlabeled])).toEqual([["187", true], ["2", false], ["45", false]]);
  });

  it("rowHasNumber compares numbers at the body's precision, never substrings", () => {
    const row = rowNumbers("drift 0.4213 at 12:40 on 2026-09-25; glucose was 187");
    expect(rowHasNumber("0.42", row)).toBe(true);
    expect(rowHasNumber("187", row)).toBe(true);
    expect(rowHasNumber("18", row)).toBe(false);
    expect(rowHasNumber("12", row)).toBe(false); // the row's own timestamp never vouches
  });
});

describe("no self", () => {
  it("rejects first person anywhere outside quotes", () => {
    expect(rule({ body: "Counted: I saw 3 notes." })).toBe("first_person");
    expect(rule({ body: "Logged: our thread closed." })).toBe("first_person");
    expect(rule({ body: "Found: a note about me." })).toBe("first_person");
  });

  it("rejects interior verbs", () => {
    expect(rule({ body: "Recorded: Drevan felt held." })).toBe("interior_verb");
    expect(rule({ body: "Logged: Raziel wanted quiet." })).toBe("interior_verb");
  });

  it("quoted speech is exempt from the self rules", () => {
    expect(rule({ body: 'Counted: Drevan said "I felt slow" 1x.' })).toBe("ok");
    expect(rule({ body: "Counted: Drevan said “we held” 1x." })).toBe("ok");
  });

  it("an unbalanced quote is rejected (the rest of the line would escape the scan)", () => {
    expect(rule({ body: 'Counted: Drevan said "I felt slow.' })).toBe("quotes");
  });

  it("rejects the private lexicon, inside quotes too", () => {
    expect(rule({ body: "Logged: vevi in the thread." })).toBe("lexicon");
    expect(rule({ body: 'Counted: Drevan said "vaselrin" 1x.' })).toBe("lexicon");
    expect(rule({ body: "Logged: 🩸 in the thread." })).toBe("lexicon");
  });
});

describe("shape rules", () => {
  it("requires a record verb at the start", () => {
    expect(rule({ body: "Noted: 3 notes." })).toBe("verb");
    expect(rule({ body: "Drevan counted 3 notes." })).toBe("verb");
    expect(rule({ body: "counted 3 notes." })).toBe("ok");
    expect(rule({ body: "Missing: no note." })).toBe("ok");
  });

  it("rejects a forged or double mark", () => {
    expect(rule({ body: "〔ledger · distiller · 2026-09-26〕 Logged: x." })).toBe("mark");
    expect(rule({ body: "Logged: x 〕" })).toBe("mark");
  });

  it("rejects a body carrying its own Source: pointer", () => {
    expect(rule({ body: "Counted: 3 notes. Source: message 1497734427298762828" })).toBe("source");
  });

  it("rejects a line break (a second line would travel without the mark)", () => {
    expect(rule({ body: "Logged: one.\nLogged: two." })).toBe("body");
  });

  it("no source, no write", () => {
    expect(rule({ source_kind: undefined })).toBe("source");
    expect(rule({ source_ref: "" })).toBe("source");
    expect(rule({ source_kind: "discord" })).toBe("source");
    expect(rule({ source_kind: "message", source_ref: "abc" })).toBe("source");
    expect(rule({ source_kind: "window", source_ref: "1497734427298762828" })).toBe("source");
    expect(rule({ source_kind: "row", source_ref: "no-colon" })).toBe("source");
  });

  it("function allowlist, companion subject, dates, dedup", () => {
    expect(rule({ function: "Iris" })).toBe("function");
    expect(rule({ companion_id: "raziel" })).toBe("companion");
    expect(rule({ observed_on: "2026-13-01" })).toBe("observed_on");
    expect(rule({ observed_on: "2027-01-01" })).toBe("observed_on");
    expect(rule({ dedup_key: "x".repeat(201) })).toBe("dedup_key");
  });

  it("renders mark first and the Source tail last; adds the period once", () => {
    expect(renderLedgerContent("gap-reader", "2026-09-26", "Missing: x", "session", "s1")).toBe("〔ledger · gap-reader · 2026-09-26〕 Missing: x. Source: session s1.");
    expect(renderLedgerContent("gap-reader", "2026-09-26", "Missing: x.", "session", "s1")).toBe("〔ledger · gap-reader · 2026-09-26〕 Missing: x. Source: session s1.");
  });
});
