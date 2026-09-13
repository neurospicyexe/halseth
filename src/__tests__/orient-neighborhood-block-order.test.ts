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
    expect(sessionSrc).toMatch(/const neighborhoodBlock = B\.neighborhoodBlock\(mindState\.graph\.neighborhoods(, \{ labels: graphLabels \})?\)/);
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

// Graph memory Phase 2, tranche 1: provenanceBlock ([Why these numbers]) sits IMMEDIATELY after
// buildOrientPrompt's header and before continuityBlock. Not cosmetic -- the header is where the
// floats are stated, and a cause that arrives four blocks later reaches a companion who has already
// read the number as a bare fact. Same source-scan technique as above, same reason.
describe("execSessionOrient ready_prompt block order (graph memory Phase 2, provenance)", () => {
  it("computes provenanceBlock from the loader's felt.soma_provenance, not a fresh query", () => {
    expect(sessionSrc).toMatch(/const provenanceBlock = B\.provenanceBlock\(mindState\.felt\.soma_provenance\)/);
  });

  it("places provenanceBlock immediately after the orient header and before continuityBlock", () => {
    const line = sessionSrc.split("\n").find((l) => l.includes("ready_prompt: buildOrientPrompt"));
    expect(line, "ready_prompt concatenation line not found").toBeTruthy();

    const idxHeader = line!.indexOf("buildOrientPrompt(");
    const idxProvenance = line!.indexOf("+ provenanceBlock");
    const idxContinuity = line!.indexOf("+ continuityBlock");

    expect(idxProvenance).toBeGreaterThan(idxHeader);
    expect(idxContinuity).toBeGreaterThan(-1);
    expect(idxProvenance).toBeLessThan(idxContinuity);
    // "immediately after" is literal: nothing is concatenated between the header and this block.
    // Asserted as "no + in between" rather than by matching the header's argument shape -- the
    // invariant is about concatenation order, and a regex over the args breaks the day someone
    // wraps one in a call.
    expect(line!.slice(idxHeader, idxProvenance)).not.toMatch(/\+/);
  });
});
