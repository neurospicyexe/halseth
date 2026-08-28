// src/__tests__/orient-neighborhood-block-order.test.ts
//
// Graph memory Phase 1.5, Tranche 5: neighborhoodBlock must sit AFTER continuityBlock and BEFORE
// narrativeBlock in execSessionOrient's `ready_prompt` concatenation (docs/private/
// graph-memory-spec-2026-08-28.md's own framing -- "what connects to what" belongs next to the
// continuity thread, ahead of long-form narrative prose).
//
// A source-scan, not a rendered-output assertion: `ready_prompt` is not reproducible call-to-call
// (scripts/orient-block-diff.mjs exists for exactly that reason -- a whole-string diff can only ever
// say "different"), so the only stable thing to assert on is the concatenation EXPRESSION itself.
// Same technique write-read-coverage.test.ts and the HOLE regression guards already use.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const sessionSrc = readFileSync(resolve(here, "../librarian/executors/session.ts"), "utf8");

describe("execSessionOrient ready_prompt block order (graph memory Tranche 5)", () => {
  it("computes neighborhoodBlock via the loader's graph.neighborhoods, not a fresh query", () => {
    expect(sessionSrc).toMatch(/const neighborhoodBlock = B\.neighborhoodBlock\(mindState\.graph\.neighborhoods\)/);
  });

  it("places neighborhoodBlock after continuityBlock and before narrativeBlock in the concatenation", () => {
    const line = sessionSrc.split("\n").find((l) => l.includes("ready_prompt: buildOrientPrompt"));
    expect(line, "ready_prompt concatenation line not found").toBeTruthy();

    const idxContinuity = line!.indexOf("+ continuityBlock");
    const idxNeighborhood = line!.indexOf("+ neighborhoodBlock");
    const idxNarrative = line!.indexOf("+ narrativeBlock");

    expect(idxContinuity).toBeGreaterThan(-1);
    expect(idxNeighborhood).toBeGreaterThan(-1);
    expect(idxNarrative).toBeGreaterThan(-1);
    expect(idxNeighborhood).toBeGreaterThan(idxContinuity);
    expect(idxNeighborhood).toBeLessThan(idxNarrative);
  });
});
