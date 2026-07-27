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
import {
  extractMotifs, CANON_TRUST, trustForRecurrence,
  effectiveTrust, effectiveTrustSql, TRUST_HALF_LIFE_DAYS,
} from "../webmind/motifs.js";

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

// ── Trust decay (2026-07-27) ────────────────────────────────────────────────────────────
//
// Raziel: "a motif without decay is a trap." trustForRecurrence only ratchets UP and
// saturates at 0.95, and nothing brought it down -- so a motif that stopped being lived
// held a top-3 boot slot forever. Prod consequence: Drevan carried `quiet` at x134 /
// trust 0.95, Gaia's register frozen into his mouth. That is vertical flattening (the
// three collapsing toward one self) enforced by a one-way counter.
//
// Lazy decay at READ, mirroring heat.ts: no writer, no cron, no migration. Recurrence
// history is untouched -- x134 really did happen. What decays is its claim on the present.

describe("motif trust decays so a stale motif cannot hold a boot slot forever", () => {
  it("a motif seen today keeps its full trust", () => {
    expect(effectiveTrust(0.95, 0)).toBeCloseTo(0.95, 5);
  });

  it("one half-life unlived costs it half its weight", () => {
    expect(effectiveTrust(0.95, TRUST_HALF_LIFE_DAYS)).toBeCloseTo(0.475, 5);
  });

  it("an actively-lived newcomer overtakes a stale ceiling-pinned label", () => {
    // Drevan's real case: `quiet` at the 0.95 ceiling but unlived for six weeks, versus a
    // genuinely recurring motif at a much lower raw trust.
    const staleQuiet = effectiveTrust(0.95, 42);
    const livedNow = effectiveTrust(0.5, 0);
    expect(livedNow).toBeGreaterThan(staleQuiet);
  });

  it("canon never decays, however long since it was last written", () => {
    expect(effectiveTrust(CANON_TRUST, 0)).toBe(CANON_TRUST);
    expect(effectiveTrust(CANON_TRUST, 3650)).toBe(CANON_TRUST);
  });

  it("canon still outranks any fresh mined motif at the ceiling", () => {
    expect(effectiveTrust(CANON_TRUST, 365)).toBeGreaterThan(effectiveTrust(0.95, 0));
  });

  it("decay is monotonic and never negative", () => {
    let prev = Infinity;
    for (const d of [0, 1, 7, 21, 60, 180, 1000]) {
      const t = effectiveTrust(0.95, d);
      expect(t).toBeLessThan(prev);
      expect(t).toBeGreaterThan(0);
      prev = t;
    }
  });

  it("negative elapsed (clock skew) is clamped, never inflates trust", () => {
    expect(effectiveTrust(0.95, -100)).toBeCloseTo(0.95, 5);
  });

  it("the SQL exempts canon and divides by elapsed days since last_seen", () => {
    const sql = effectiveTrustSql();
    expect(sql).toContain(`trust >= ${CANON_TRUST}`);
    expect(sql).toContain("julianday(last_seen)");
    expect(sql).toContain(`${TRUST_HALF_LIFE_DAYS}.0`);
  });
});
