// src/__tests__/motif-name-noise.test.ts
//
// Speaker names are not motifs (2026-07-27).
//
// companion_motifs is described as "recurring symbolic threads" and its top 3 by trust are
// injected into every boot. The miner had a stopword list and a metadata-token guard but no
// NAME filter, and document frequency over companion text is dominated by the participants'
// names. Measured in prod, the actual top-3 active motifs, all pinned at the 0.95 ceiling:
//
//   cypher: "cypher" x354, "drevan" x326, "same"    x281
//   drevan: "drevan" x516, "without" x338, "crash"  x333
//   gaia:   "gaia"   x257, "drevan" x252, "held"    x176
//
// So every boot told Drevan his recurring symbolic threads were his own name, a preposition,
// and Raziel's name. Noise in the slot, and self-referential noise -- it feeds exactly the
// name-centric commons turns Raziel reported ("Gaia. Drevan. ...").
//
// nullsafe-discord/packages/shared/src/echo-guard.ts already excludes this same set for this
// same stated reason ("Speaker names never count as motif or echo signal -- they recur by
// construction"). The miner never got the guard. This is the third fix of this exact shape
// in the file: transport stamps (discord:swarm), contractions, now names.

import { describe, it, expect } from "vitest";
import { extractMotifs, CANON_TRUST, trustForRecurrence } from "../webmind/motifs.js";

const labels = (texts: string[]) => extractMotifs(texts).map(m => m.label);

describe("motif mining excludes speaker names", () => {
  const corpus = [
    "Drevan named the threshold again and Crash held the thread",
    "Drevan and Cypher circled the threshold; Crash was steady",
    "Gaia witnessed it, Drevan reached the threshold, Crash stayed",
  ];

  it("does not mine the companions' or Raziel's names", () => {
    const got = labels(corpus);
    for (const name of ["drevan", "cypher", "gaia", "raziel", "crash"]) {
      expect(got).not.toContain(name);
    }
  });

  it("still mines the real recurring thread from the same corpus", () => {
    expect(labels(corpus)).toContain("threshold");
  });

  it("does not mine names inside bigrams either", () => {
    const got = labels(corpus);
    expect(got.some(l => /\b(drevan|cypher|gaia|raziel|crash)\b/.test(l))).toBe(false);
  });

  it("keeps world content that only LOOKS like a name -- Heidi, Rome", () => {
    const got = labels([
      "Heidi came to the rail again this morning, Rome still on my mind",
      "Heidi took the offering; I thought about Rome and the long road",
      "Heidi waited. Rome returns when I am quiet.",
    ]);
    expect(got).toContain("heidi");
    expect(got).toContain("rome");
  });

  // Noted while writing the test above, not fixed here: MOTIF_TUNING.MIN_TOKEN_LEN is 4,
  // so "Sol" (three letters) can never become a motif no matter how often he recurs. Same
  // for "vow". Real gap in the world-texture layer; lowering the floor would also readmit
  // a lot of noise, so it needs its own measurement rather than a drive-by change.
  it("documents the 3-letter blind spot: Sol can never be mined", () => {
    const got = labels([
      "Sol came to the rail again", "Sol took the offering", "Sol waited at the rail",
    ]);
    expect(got).not.toContain("sol");
  });
});

describe("bare function words that owned top-3 slots are excluded", () => {
  it("drops 'without' and 'same' (x338 and x281 in prod)", () => {
    const got = labels([
      "the same shape without the weight, the same again",
      "without the frame it is the same problem",
      "same again, without end",
    ]);
    expect(got).not.toContain("without");
    expect(got).not.toContain("same");
  });
});

describe("canon tier", () => {
  it("CANON_TRUST sits above anything extraction can reach", () => {
    // trustForRecurrence saturates at 0.95, so only an authored write lands on 1.0 --
    // which is what makes it a usable marker without a schema migration.
    for (const n of [1, 10, 100, 1000, 100000]) {
      expect(trustForRecurrence(n)).toBeLessThan(CANON_TRUST);
    }
    expect(CANON_TRUST).toBe(1.0);
  });
});
