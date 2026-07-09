// Tests for journal lane separation (2026-07-09).
//
// Regression guard for the Brain-cutover audit: chatter (discord_swarm) must be
// searchable but must never occupy orient's 3 recency slots or dominate the motif
// miner's document frequency.

import { describe, it, expect } from "vitest";
import {
  CHATTER_JOURNAL_SOURCES,
  SUBSTANTIVE_JOURNAL_CLAUSE,
  isChatterSource,
} from "../webmind/journal-lanes.js";

describe("journal lanes", () => {
  it("treats discord_swarm as chatter", () => {
    expect(isChatterSource("discord_swarm")).toBe(true);
  });

  it("treats NULL/undefined source (companion-authored) as substantive", () => {
    expect(isChatterSource(null)).toBe(false);
    expect(isChatterSource(undefined)).toBe(false);
  });

  it("treats session/synthesis sources as substantive", () => {
    for (const s of ["session_close", "metronome", "evaluator", "pattern_worker"]) {
      expect(isChatterSource(s)).toBe(false);
    }
  });

  // The clause is a hardcoded SQL literal; this proves it stays in sync with the
  // source list so a future chatter lane can't be silently omitted from the filter.
  it("SUBSTANTIVE_JOURNAL_CLAUSE excludes EVERY declared chatter source", () => {
    for (const src of CHATTER_JOURNAL_SOURCES) {
      expect(SUBSTANTIVE_JOURNAL_CLAUSE).toContain(`'${src}'`);
    }
  });

  it("SUBSTANTIVE_JOURNAL_CLAUSE keeps NULL-source rows (legacy entries)", () => {
    expect(SUBSTANTIVE_JOURNAL_CLAUSE).toContain("source IS NULL");
  });

  it("SUBSTANTIVE_JOURNAL_CLAUSE interpolates nothing", () => {
    expect(SUBSTANTIVE_JOURNAL_CLAUSE).not.toContain("?");
    expect(SUBSTANTIVE_JOURNAL_CLAUSE).not.toContain("${");
  });
});
