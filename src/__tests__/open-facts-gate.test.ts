/**
 * lib/open-facts-gate.ts (2026-09-14): open architect facts are questions, and a question nobody
 * asked in two weeks is not a live one. 107 open rows (105 of them the Hermes-queue drain) were
 * rendered in full at every orient. The gate renders the newest few and COUNTS the rest.
 */
import { describe, it, expect } from "vitest";
import { gateOpenFacts, heldOpenFactsLine, OPEN_FACTS_MAX, OPEN_FACTS_MAX_AGE_DAYS } from "../lib/open-facts-gate.js";
import { architectFactsBlock, architectFactsCounts } from "../librarian/response/orient-blocks.js";

const NOW = new Date("2026-09-14T12:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString().slice(0, 19).replace("T", " ");
const open = (id: string, age: number, fact = `fact ${id}`) => ({ id, fact, category: "general", status: "open", created_at: daysAgo(age) });

describe("gateOpenFacts", () => {
  it("shows fresh open facts newest-first and holds the stale ones with their age", () => {
    const rows = [open("a", 1), open("b", 40), open("c", 3), open("d", 20)];
    const g = gateOpenFacts(rows, { now: NOW });
    expect(g.shown.map(r => r.id)).toEqual(["a", "c"]);
    expect(g.held.map(r => r.id).sort()).toEqual(["b", "d"]);
    expect(g.oldestHeldDays).toBe(40);
  });

  it("caps the shown set even when everything is fresh; the overflow is held, not dropped", () => {
    const rows = Array.from({ length: OPEN_FACTS_MAX + 5 }, (_, i) => open(`f${i}`, i % 5));
    const g = gateOpenFacts(rows, { now: NOW });
    expect(g.shown).toHaveLength(OPEN_FACTS_MAX);
    expect(g.held).toHaveLength(5);
    expect(g.shown.length + g.held.length).toBe(rows.length);
  });

  it("treats the age boundary inclusively and undated rows as old", () => {
    const rows = [open("edge", OPEN_FACTS_MAX_AGE_DAYS), open("over", OPEN_FACTS_MAX_AGE_DAYS + 0.01), { ...open("nodate", 0), created_at: null }];
    const g = gateOpenFacts(rows, { now: NOW });
    expect(g.shown.map(r => r.id)).toEqual(["edge"]);
    expect(g.held.map(r => r.id).sort()).toEqual(["nodate", "over"]);
  });

  it("ignores rows that are not open (active facts are the caller's business)", () => {
    const g = gateOpenFacts([{ ...open("x", 1), status: "active" }], { now: NOW });
    expect(g.shown).toHaveLength(0);
    expect(g.held).toHaveLength(0);
  });

  it("parses both D1 and ISO stamps", () => {
    const iso = { ...open("iso", 1), created_at: new Date(NOW.getTime() - 86_400_000).toISOString() };
    expect(gateOpenFacts([iso, open("d1", 1)], { now: NOW }).shown).toHaveLength(2);
  });
});

describe("heldOpenFactsLine", () => {
  it("is empty when nothing is held and names count + age otherwise", () => {
    expect(heldOpenFactsLine(0, null)).toBe("");
    expect(heldOpenFactsLine(1, 33)).toContain("1 older open question held back, oldest 33d");
    expect(heldOpenFactsLine(99, null)).toContain("99 older open questions held back --");
  });
});

describe("architectFactsBlock with the gate", () => {
  it("renders the 2026-09-14 shape: 45 active in full, 8 fresh open, the other 99 counted", () => {
    const active = Array.from({ length: 45 }, (_, i) => ({ id: `a${i}`, fact: `active ${i}`, category: "work", status: "active", created_at: daysAgo(30) }));
    const fresh = Array.from({ length: 8 }, (_, i) => open(`fresh${i}`, 2));
    const stale = Array.from({ length: 99 }, (_, i) => open(`stale${i}`, 20 + (i % 14)));
    const block = architectFactsBlock([...active, ...fresh, ...stale], { now: NOW });
    expect(block.match(/• \(work\) active /g)).toHaveLength(45);
    expect(block.match(/• fact fresh/g)).toHaveLength(8);
    expect(block).not.toContain("fact stale");
    expect(block).toContain("99 older open questions held back, oldest 33d");
    expect(architectFactsCounts([...active, ...fresh, ...stale], { now: NOW })).toEqual({ active: 45, open_shown: 8, open_held: 99 });
  });

  it("renders nothing for no facts and no OPEN section when there are none", () => {
    expect(architectFactsBlock([])).toBe("");
    const block = architectFactsBlock([{ id: "a", fact: "x", category: "life", status: "active" }]);
    expect(block).toContain("[About Raziel]");
    expect(block).not.toContain("OPEN");
  });
});
