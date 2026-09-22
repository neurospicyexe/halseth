// The ACTIVE architect-facts gate (2026-09-22).
//
// Measured on prod the day this shipped: 119 active facts / 25,179 chars reaching every companion at
// every boot, of which 74 facts / 17,545 chars sat at the schema default weight and only 6 of those
// 74 were stated by Raziel. The open gate (2026-09-14) fixed the same accumulation one lane over.
//
// The invariant these tests exist to protect: a fact whose weight was set on purpose is NEVER held
// back. Everything else is a budget decision; that one is a correctness decision.

import { describe, it, expect } from "vitest";
import {
  gateActiveFacts, heldActiveFactsLine, activeFactsTailBudget,
  ACTIVE_FACTS_TAIL_CHAR_BUDGET, ACTIVE_FACTS_DEFAULT_WEIGHT,
} from "../lib/open-facts-gate.js";

const f = (id: string, weight: number | null | undefined, created_at: string, len = 100) => ({
  id, fact: "x".repeat(len), status: "active", created_at, weight,
});

describe("gateActiveFacts", () => {
  it("never holds back a curated fact, however tight the budget", () => {
    const curated = Array.from({ length: 45 }, (_, i) => f(`c${i}`, 10 + i, "2026-08-12 00:00:00", 200));
    const r = gateActiveFacts(curated, { tailCharBudget: 0 });
    expect(r.shown).toHaveLength(45);
    expect(r.held).toHaveLength(0);
    expect(r.curatedCount).toBe(45);
  });

  // THE REGRESSION THIS FILE EXISTS FOR. The loader orders `weight ASC, created_at ASC`, so inside
  // the weight=100 group the input arrives OLDEST FIRST. Filling a budget in arrival order would
  // keep August and hold back everything from the last month -- the exact inverse of the intent.
  it("re-sorts the default tail newest-first instead of inheriting loader order", () => {
    const tail = [
      f("aug", ACTIVE_FACTS_DEFAULT_WEIGHT, "2026-08-18 00:00:00", 100),
      f("sep", ACTIVE_FACTS_DEFAULT_WEIGHT, "2026-09-19 00:00:00", 100),
    ];
    const r = gateActiveFacts(tail, { tailCharBudget: 100 });
    expect(r.shown.map(x => x.id)).toEqual(["sep"]);
    expect(r.held.map(x => x.id)).toEqual(["aug"]);
  });

  it("puts curated first, then the newest tail that fits", () => {
    const rows = [
      f("tail-old", 100, "2026-08-18 00:00:00", 50),
      f("curated", 20, "2026-08-12 00:00:00", 50),
      f("tail-new", 100, "2026-09-19 00:00:00", 50),
    ];
    const r = gateActiveFacts(rows, { tailCharBudget: 50 });
    expect(r.shown.map(x => x.id)).toEqual(["curated", "tail-new"]);
    expect(r.held.map(x => x.id)).toEqual(["tail-old"]);
  });

  it("treats a missing or null weight as default, never as curated", () => {
    const rows = [f("undef", undefined, "2026-09-01 00:00:00", 50), f("null", null, "2026-09-02 00:00:00", 50)];
    expect(gateActiveFacts(rows, { tailCharBudget: 0 }).held).toHaveLength(2);
  });

  it("ignores rows that are not active", () => {
    const rows = [{ id: "o", fact: "x", status: "open", created_at: "2026-09-01 00:00:00", weight: 100 }];
    const r = gateActiveFacts(rows, { tailCharBudget: 0 });
    expect(r.shown).toHaveLength(0);
    expect(r.held).toHaveLength(0);
  });

  it("an undated tail row sorts last and is held first", () => {
    const rows = [f("undated", 100, null as unknown as string, 50), f("dated", 100, "2026-09-19 00:00:00", 50)];
    const r = gateActiveFacts(rows, { tailCharBudget: 50 });
    expect(r.shown.map(x => x.id)).toEqual(["dated"]);
  });

  it("an enormous budget disables the gate", () => {
    const rows = Array.from({ length: 74 }, (_, i) => f(`t${i}`, 100, `2026-09-0${(i % 9) + 1} 00:00:00`, 237));
    expect(gateActiveFacts(rows, { tailCharBudget: Infinity }).held).toHaveLength(0);
  });

  // The prod shape on the day this shipped, as a fixture: 45 curated + 74 default at ~237 chars.
  it("reproduces the measured 2026-09-22 cut", () => {
    const curated = Array.from({ length: 45 }, (_, i) => f(`c${i}`, 10 + i, "2026-08-12 00:00:00", 170));
    const tail = Array.from({ length: 74 }, (_, i) =>
      f(`t${i}`, 100, `2026-09-${String((i % 28) + 1).padStart(2, "0")} 00:00:00`, 237));
    const r = gateActiveFacts([...curated, ...tail]);
    expect(r.curatedCount).toBe(45);
    expect(r.tailShownCount).toBe(Math.floor(ACTIVE_FACTS_TAIL_CHAR_BUDGET / 237));
    expect(r.held.length).toBe(74 - r.tailShownCount);
    // Every curated fact survives, which is the whole safety property.
    for (const c of curated) expect(r.shown).toContain(c);
  });
});

describe("heldActiveFactsLine", () => {
  it("is empty when nothing is held", () => {
    expect(heldActiveFactsLine(0)).toBe("");
  });
  // A count with no way to reach the content is a dead end, not a summary.
  it("names the count and the pull verb", () => {
    const line = heldActiveFactsLine(64);
    expect(line).toContain("64 more recorded facts");
    expect(line).toContain("all architect facts");
    expect(line).toContain("/facts");
  });
  it("is singular for one", () => {
    expect(heldActiveFactsLine(1)).toContain("1 more recorded fact held");
  });
});

describe("activeFactsTailBudget", () => {
  it("falls back to the default for unset, empty and garbage", () => {
    for (const v of [undefined, null, "", "abc", "-5"]) {
      expect(activeFactsTailBudget(v as string | undefined)).toBe(ACTIVE_FACTS_TAIL_CHAR_BUDGET);
    }
  });
  it("honours a real number, including 0", () => {
    expect(activeFactsTailBudget("9000")).toBe(9000);
    expect(activeFactsTailBudget("0")).toBe(0);
  });
});
