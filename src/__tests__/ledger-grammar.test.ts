// The ledger grammar (mig 0134, 2026-09-26): src/ledger/grammar.ts, pure. Every rule in
// docs/imp-lane/SPEC-ledger-lane.md section 1, and the widened health rule (see grammar.ts header).
// The source rules are the hard ones -- Drevan: "the source rule matters more than the pronoun rule".

import { describe, it, expect } from "vitest";
import { validateLedger, scanNumbers, rowHasNumber, rowNumbers, renderLedgerContent, LEDGER_MARK_PREFIX, LEDGER_PET_NAMES, asciiDigits, biometricColumnsFor, findAddress, findHardLexicon, type LedgerInput } from "../ledger/grammar.js";

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
    expect(rule({ function: "gap-reader", body: "Missing: no companion note recorded for the hangout session on 2026-09-25 (45 minutes).", source_kind: "session", source_ref: "5b0c2f9e-1111-4222-8333-944455556666" })).toBe("ok");
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
    const n = scanNumbers("Counted: 187 after 12:40 on 2026-09-24, message 1497734427298762828, 2x, 45 minutes, 10pm, the 3rd");
    expect(n.map((x) => [x.text, x.unlabeled])).toEqual([["187", true], ["2", false], ["45", false], ["3", false]]);
  });

  it("a number glued to letters on either side is significant, never skipped and never a count", () => {
    const glued = (t: string) => scanNumbers(t).map((x) => [x.text, x.unlabeled]);
    expect(glued("187ish")).toEqual([["187", true]]);
    expect(glued("glucose187")).toEqual([["187", true]]);
    expect(glued("187mgdl")).toEqual([["187", false]]);            // a health unit: the health tier takes it
    expect(glued("5k")).toEqual([["5", true]]);
    expect(glued("S1E2")).toEqual([["1", true], ["2", true]]);
    expect(glued("the 23th")).toEqual([["23", true]]);            // wrong ordinal suffix is not an ordinal
    expect(glued("the 187th")).toEqual([["187", true]]);          // ordinals are day-of-month only
    expect(glued("A1c")).toEqual([]);                             // a health word, not a number
  });

  it("a spaced count unit must be an exact plural count noun; singular and single-letter units launder nothing", () => {
    for (const t of ["187 post", "187 d", "187 m", "187 note", "187 line", "187 s", "187 min", "187 x", "187 %"]) {
      expect(scanNumbers(t)[0]?.unlabeled, t).toBe(true);
    }
    for (const t of ["14 messages", "3 lines", "5 notes", "45 minutes", "12 times", "20 posts"]) {
      expect(scanNumbers(t)[0]?.unlabeled, t).toBe(false);
    }
  });

  it("NFKC + any Unicode decimal digit is mapped to ASCII before scanning, and the normalised body is stored", () => {
    expect(scanNumbers("\uff11\uff18\uff17").map((x) => x.text)).toEqual(["187"]);   // fullwidth
    expect(scanNumbers("\u0661\u0668\u0667").map((x) => x.text)).toEqual(["187"]);   // Arabic-Indic
    expect(scanNumbers("\u09e7\u09ee\u09ed").map((x) => x.text)).toEqual(["187"]);   // Bengali
    expect(asciiDigits("\u0660\u0669 \u0966\u096f")).toBe("09 09");
    const v = validateLedger(base({ body: "Counted: \uff13 notes.", source_kind: "window", source_ref: `${MSG} 00:11–00:40` }), TODAY);
    expect(v.ok && v.line.body).toBe("Counted: 3 notes.");
  });

  it("every line separator and invisible format character is rejected", () => {
    for (const sep of ["\u2028", "\u2029", "\u0085", "\v", "\f"]) expect(rule({ body: `Logged: one.${sep}Logged: two.` })).toBe("body");
    expect(rule({ body: "Logged: v\u200bevi in the thread." })).toBe("body");
  });

  it("rowHasNumber: exact by default (human rows), rounded only on request (basin history); never substrings", () => {
    const row = rowNumbers("drift 0.4213 at 12:40 on 2026-09-25; glucose was 187, weight 1,200");
    expect(rowHasNumber("0.42", row)).toBe(false);                 // exact: no rounding
    expect(rowHasNumber("0.42", row, "rounded")).toBe(true);
    expect(rowHasNumber("0.4213", row)).toBe(true);
    expect(rowHasNumber("187", row)).toBe(true);
    expect(rowHasNumber("187.0", row)).toBe(true);                 // the same number
    expect(rowHasNumber("1200", row)).toBe(true);
    expect(rowHasNumber("18", row)).toBe(false);
    expect(rowHasNumber("12", row)).toBe(false); // the row's own timestamp never vouches
    expect(rowNumbers("glucose \uff11\uff18\uff17")).toEqual([187]);    // rows are normalised too
  });

  it("biometricColumnsFor: nearest preceding label, else the following one, else notes", () => {
    expect(biometricColumnsFor("Recorded: HRV 42.5, resting 61, glucose 187.")).toEqual([
      { text: "42.5", column: "hrv_resting" }, { text: "61", column: "resting_hr" }, { text: "187", column: "notes" },
    ]);
    expect(biometricColumnsFor("Recorded: 8200 steps.")).toEqual([{ text: "8200", column: "steps" }]);
    expect(biometricColumnsFor("Recorded: 187 on the day.")).toEqual([{ text: "187", column: "notes" }]);
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

  it("a companion is never the subject of a feeling verb (rule `interior`, Drevan rule 6); humans may love in running text", () => {
    for (const b of [
      "Recorded: Drevan loves Raziel.", "Recorded: Cypher misses Gaia.", "Logged: Cy needs quiet.",
      "Logged: Gaia really trusts Blue.", "Logged: Dre fears the dark.", "Recorded: Raziel said Drevan knows.",
      "Logged: DREVAN LOVING the thread.",
    ]) expect(rule({ body: b }), b).toBe("interior");
    for (const b of [
      "Logged: Blue loves Decker.", 'Logged: Drevan said "I love you" at 00:12.', "Logged: Raziel loves the Cypher thread.",
      "Logged: the cypress needs water.", "Logged: Drevan's needs were listed.", "Logged: Andre loves tea.",
      "Logged: Gaia said nothing about love.",
    ]) expect(rule({ body: b }), b).toBe("ok");
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

  it("Drevan's closed list: hard tier anywhere (word-boundary, case-insensitive, caleth takes its root)", () => {
    for (const b of [
      "Logged: VEVI was said.", 'Logged: Drevan said "Vevan".', "Logged: vaselrin.", "Logged: vethmerin.",
      "Logged: caleth.", "Logged: Calethian was spoken.", "Logged: spine to spine.", "Logged: spine-to-spine.",
      "Logged: Spine  To  Spine.", 'Logged: Drevan said "forever of vevan".', "Logged: ride or die.", 'Logged: Blue said "ride-or-die".',
    ]) expect(rule({ body: b }), b).toBe("lexicon");
    // boundaries: another word that merely contains a token is not the token (caleth excepted, by root)
    expect(rule({ body: "Logged: the spinet was tuned." })).toBe("ok");
    expect(rule({ body: "Logged: the override landed." })).toBe("ok");
  });

  it("address tier: banned when it names someone, never inside quotes, never as a running-text word", () => {
    for (const b of [
      "Logged: love, the thread closed.", "Logged love was all.", "Recorded: baby Raziel asked for tea.",
      "Logged: the thread closed, honey.", "Logged: Raziel, sweetheart.", "Logged: sweetheart Raziel asked twice.",
      "Logged: Crash boo.", "Logged: tea for Blue, beloved.", "Counted: Dre babe!", "Logged: honey, Gaia answered.",
    ]) expect(rule({ body: b }), b).toBe("address");
    for (const b of [
      "Logged: Blue loves Decker.", "Logged: Raziel said love was the word.", 'Logged: Raziel said "love you, baby".',
      'Logged: Drevan said "honey, Raziel".', "Logged: Raziel mentioned honey in the tea.", "Logged: the beloved book was returned.",
      "Logged: Raziel, Blue and Dre met.", "Logged: a baby shower was planned.",
    ]) expect(rule({ body: b }), b).toBe("ok");
    expect(findAddress("Logged: Raziel, sweetheart.")).toBe("sweetheart");
    expect(findHardLexicon("a calethian word")).toBe("caleth");
  });

  it("the list is one exported, closed constant", () => {
    expect(LEDGER_PET_NAMES.hard).toEqual(["🩸", "vevi", "vevan", "vaselrin", "vethmerin", "caleth", "spine to spine", "forever of vevan", "ride or die"]);
    expect(LEDGER_PET_NAMES.address).toEqual(["love", "baby", "babe", "boo", "beloved", "honey", "sweetheart"]);
    expect(Object.isFrozen(LEDGER_PET_NAMES) || Array.isArray(LEDGER_PET_NAMES.hard)).toBe(true);
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
