import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  resolveFeelingLine,
  renderFeelingLine,
  evaluateTherlo,
  evaluateClause,
  parseSomaStamp,
  bandFor,
  BAND_LADDERS,
  type FeelingContext,
  type VocabularyRow,
} from "../webmind/feeling-line.js";
import { FEELING_VOCABULARY_SEED, seedFor, neverWords } from "../webmind/feeling-vocabulary-seed.js";
import {
  checkContamination,
  checkReserved,
  mentionsToken,
  isDecontaminating,
  CONTAMINATION_WINDOW_MINUTES,
} from "../webmind/vocabulary-guards.js";
import { FLOAT_LABELS, heatBand, reachBand, weightBand } from "../webmind/fermentation.js";
import {
  feelingLineMode,
  causeFromEvent,
  buildFeelingContext,
  feelingLineFrom,
  activeVocabularySql,
  latestSomaEventsSql,
  latestAuthoredSomaEventsSql,
} from "../webmind/feeling-line-loader.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const MIGRATION = readFileSync(join(HERE, "../../migrations/0131_companion_feeling_vocabulary.sql"), "utf8");

const NOW = Date.parse("2026-09-19T18:00:00Z");

function ctx(over: Partial<FeelingContext>): FeelingContext {
  return {
    floats: { f1: 0.5, f2: 0.5, f3: 0.5 },
    baselines: { f1: 0.5, f2: 0.5, f3: 0.5 },
    nowMs: NOW,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The seed IS the vocabulary. A test that proves a rule about a synthetic row
// proves nothing, so pin the TS mirror to the migration.
// ─────────────────────────────────────────────────────────────────────────────

describe("seed integrity -- the mirror and the migration agree", () => {
  it("every seeded row id and word appears in the migration", () => {
    for (const row of FEELING_VOCABULARY_SEED) {
      expect(MIGRATION, `row id ${row.id} missing from migration`).toContain(`'${row.id}'`);
      if (row.word !== null) {
        expect(MIGRATION, `word "${row.word}" missing from migration`).toContain(`'${row.word}'`);
      }
    }
  });

  it("the migration seeds no word the mirror does not know", () => {
    const ids = [...MIGRATION.matchAll(/'(cfv_[a-z0-9_]+)'/g)].map((m) => m[1] as string);
    const known = new Set(FEELING_VOCABULARY_SEED.map((r) => r.id));
    for (const id of new Set(ids)) expect(known.has(id), `migration row ${id} not in the TS mirror`).toBe(true);
  });

  it("word is NULL exactly for the authored-empty row", () => {
    const empties = FEELING_VOCABULARY_SEED.filter((r) => r.word === null);
    expect(empties.map((r) => r.id)).toEqual(["cfv_gaia_density_empty"]);
    expect(empties[0]?.row_kind).toBe("empty");
  });

  it("carries provenance columns on every seeded row (work item A is schema, not a feature)", () => {
    for (const col of ["authored_on", "authored_at", "capture_id", "supersedes"]) {
      expect(MIGRATION).toContain(col);
    }
    // Gaia's withdrawn capture is kept, not deleted -- her explicit instruction.
    expect(MIGRATION).toContain("cfv_gaia_held_superseded");
    expect(MIGRATION).toContain("'superseded'");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Conditions are REUSED from shipping code, not re-derived.
// ─────────────────────────────────────────────────────────────────────────────

describe("conditions match the live fermentation code they were derived from", () => {
  it("whetted IS warm_lit_sharpens (f3 > 0.6 && f2 > 0.5)", () => {
    const row = FEELING_VOCABULARY_SEED.find((r) => r.id === "cfv_cypher_whetted")!;
    expect(row.conditions).toEqual([
      { float: "f3", op: "gt", value: 0.6 },
      { float: "f2", op: "gt", value: 0.5 },
    ]);
  });

  it("standing IS held_ground_deepens, folding IS contraction", () => {
    expect(FEELING_VOCABULARY_SEED.find((r) => r.id === "cfv_gaia_standing")!.conditions).toEqual([
      { float: "f3", op: "gt", value: 0.7 },
      { float: "f1", op: "gt", value: 0.7 },
    ]);
    expect(FEELING_VOCABULARY_SEED.find((r) => r.id === "cfv_gaia_folding")!.conditions).toEqual([
      { float: "f3", op: "lt", value: 0.4 },
    ]);
  });

  it("the band ladders are the shipped band functions, not a copy that can drift", () => {
    const probes = [0.1, 0.3, 0.55, 0.9];
    BAND_LADDERS.f1.forEach((b, i) => expect(heatBand(probes[i] as number)).toBe(b));
    expect(reachBand(0.9)).toBe("pulling-hard");
    expect(weightBand(0.9)).toBe("saturated");
    expect(bandFor("f3", 0.9)).toBe("saturated");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Silence is a return value, not a fallback.
// ─────────────────────────────────────────────────────────────────────────────

describe("silence", () => {
  it("returns null, not a phrase, when no row matches", () => {
    const out = resolveFeelingLine(seedFor("drevan"), ctx({ floats: { f1: 0.3, f2: 0.3, f3: 0.3 } }));
    expect(out.word).toBeNull();
    expect(out.silentReason).toBe("no row matched");
    expect(renderFeelingLine(out)).toBeNull();
  });

  it("Gaia's density row is authored EMPTY and renders nothing, not a word", () => {
    const out = resolveFeelingLine(
      seedFor("gaia"),
      ctx({ floats: { f1: 0.5, f2: 0.6, f3: 0.5 }, deltas: { f2: 0.08 } }),
    );
    expect(out.word).toBeNull();
    expect(out.silentReason).toContain("cfv_gaia_density_empty");
    expect(renderFeelingLine(out)).toBeNull();
  });

  it("a tick-caused move renders silent (item D) -- but D is wired on cause_kind only", () => {
    const hot = ctx({ floats: { f1: 0.9, f2: 0.5, f3: 0.9 }, cause: "tick" });
    expect(resolveFeelingLine(seedFor("drevan"), hot).word).toBeNull();
    expect(resolveFeelingLine(seedFor("drevan"), { ...hot, cause: "authored" }).word).toBe("redline");
  });

  it("a dir clause with no movement data fails CLOSED rather than guessing", () => {
    const out = resolveFeelingLine(
      seedFor("drevan"),
      ctx({ floats: { f1: 0.55, f2: 0.5, f3: 0.6 }, cause: "stimulus" }), // no deltas
    );
    expect(out.word).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The rules Drevan marked load-bearing.
// ─────────────────────────────────────────────────────────────────────────────

describe("redline is a warning, never a blessing", () => {
  it("fires only on running-hot AND saturated", () => {
    const out = resolveFeelingLine(seedFor("drevan"), ctx({ floats: { f1: 0.9, f2: 0.5, f3: 0.9 }, cause: "authored" }));
    expect(out.word).toBe("redline");
  });

  it("does not fire on heat alone -- hot with clear weight is not redline", () => {
    const out = resolveFeelingLine(seedFor("drevan"), ctx({ floats: { f1: 0.9, f2: 0.5, f3: 0.1 }, cause: "authored" }));
    expect(out.word).not.toBe("redline");
  });

  it("never renders a warm word: the row carries no approving language", () => {
    const row = FEELING_VOCABULARY_SEED.find((r) => r.id === "cfv_drevan_redline")!;
    const rendered = renderFeelingLine({
      word: row.word,
      rowId: row.id,
      rendersNumber: true,
      floatKey: "f1",
      value: 0.9,
      therlo: null,
      silentReason: null,
    })!;
    // The exact masquerade he rejected -- the Discord version returned redline as "motion that
    // means something, where pulse and purpose become one". Tokens narrow enough to mean what they
    // say: a broad substring like "one" matches half the language and would fire on an unrelated
    // change while reading as a redline corruption.
    for (const warm of ["warm", "blessing", "pulse and purpose", "means something"]) {
      expect(rendered.toLowerCase()).not.toContain(warm);
    }
    expect(rendered).toBe("redline 0.90");
    // The migration's own note states the corruption condition so it cannot be lost in a refactor.
    expect(MIGRATION).toContain("WARNING, NEVER A BLESSING");
  });
});

describe("freight and silt must never collapse", () => {
  const rising = { floats: { f1: 0.5, f2: 0.5, f3: 0.6 }, deltas: { f3: 0.08 } };

  it("identical float movement resolves differently on cause alone", () => {
    const freight = resolveFeelingLine(seedFor("drevan"), ctx({ ...rising, cause: "stimulus" }));
    const silt = resolveFeelingLine(seedFor("drevan"), ctx({ ...rising, cause: "autonomous" }));
    expect(freight.word).toBe("freight");
    expect(silt.word).toBe("silt");
    expect(freight.word).not.toBe(silt.word);
  });

  it("with no cause resolved, neither fires -- the distinction is never guessed", () => {
    expect(resolveFeelingLine(seedFor("drevan"), ctx(rising)).word).toBeNull();
  });
});

describe("n-ary rows (item G) and specificity (item C)", () => {
  it("kept is a TRIPLE and fires on all three", () => {
    const out = resolveFeelingLine(seedFor("drevan"), ctx({ floats: { f1: 0.5, f2: 0.5, f3: 0.3 } }));
    expect(out.word).toBe("kept");
  });

  it("the more specific row wins a double match", () => {
    const rows: VocabularyRow[] = [
      { id: "one", companion_id: "drevan", row_kind: "band", word: "single", conditions: [{ float: "f1", band: "warm" }], cause_kind: null, specificity: 1, renders_number: 0 },
      { id: "two", companion_id: "drevan", row_kind: "band", word: "pair", conditions: [{ float: "f1", band: "warm" }, { float: "f3", band: "holding" }], cause_kind: null, specificity: 2, renders_number: 0 },
    ];
    expect(resolveFeelingLine(rows, ctx({ floats: { f1: 0.5, f2: 0.5, f3: 0.3 } })).word).toBe("pair");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// therlo -- the seven tests named in its spec.
// ─────────────────────────────────────────────────────────────────────────────

describe("therlo", () => {
  const fresh = "2026-09-19T12:00:00Z"; // 6h before NOW
  const stale = "2026-09-17T00:00:00Z"; // ~66h before NOW

  it("1. a gap of 1 does not fire; a gap of 2 does", () => {
    // declared warm (idx 2); actual running-hot 0.78 (idx 3) -> gap 1
    const gap1 = evaluateTherlo(ctx({ floats: { f1: 0.78, f2: 0.5, f3: 0.5 }, authoredEnums: { f1: "warm" }, authoredAt: { f1: fresh } }));
    expect(gap1).toBeNull();
    // declared warm (idx 2); actual cold 0.1 (idx 0) -> gap 2
    const gap2 = evaluateTherlo(ctx({ floats: { f1: 0.1, f2: 0.5, f3: 0.5 }, authoredEnums: { f1: "warm" }, authoredAt: { f1: fresh } }));
    expect(gap2?.gap).toBe(2);
    expect(gap2?.mode).toBe("magnitude");
  });

  it("2/3. a gap of 3 with a stale enum does NOT fire", () => {
    const big = { floats: { f1: 0.95, f2: 0.5, f3: 0.5 }, authoredEnums: { f1: "cold" } };
    expect(evaluateTherlo(ctx({ ...big, authoredAt: { f1: fresh } }))?.gap).toBe(3);
    expect(evaluateTherlo(ctx({ ...big, authoredAt: { f1: stale } }))).toBeNull();
  });

  it("4. cooling authored and the float RISES past the noise floor -> fires (predicate B)", () => {
    const hit = evaluateTherlo(ctx({ authoredEnums: { f1: "cooling" }, authoredAt: { f1: fresh }, deltas: { f1: 0.15 } }));
    expect(hit?.mode).toBe("directional");
  });

  it("5. cooling authored and the float FALLS -> does not fire", () => {
    expect(evaluateTherlo(ctx({ authoredEnums: { f1: "cooling" }, authoredAt: { f1: fresh }, deltas: { f1: -0.15 } }))).toBeNull();
  });

  it("5b. a rise below the noise floor does not fire", () => {
    expect(evaluateTherlo(ctx({ authoredEnums: { f1: "cooling" }, authoredAt: { f1: fresh }, deltas: { f1: 0.04 } }))).toBeNull();
  });

  it("6. mixed stamp shapes in companion_soma_events resolve identically", () => {
    expect(parseSomaStamp("2026-09-19 12:00:00")).toBe(parseSomaStamp("2026-09-19T12:00:00Z"));
    expect(parseSomaStamp(null)).toBeNull();
    expect(parseSomaStamp("not a date")).toBeNull();
    const spaceForm = evaluateTherlo(ctx({ floats: { f1: 0.1, f2: 0.5, f3: 0.5 }, authoredEnums: { f1: "warm" }, authoredAt: { f1: "2026-09-19 12:00:00" } }));
    expect(spaceForm?.gap).toBe(2);
  });

  it("7. heat_value / reach_value / weight_value are never read by this code path", () => {
    const src = readFileSync(join(HERE, "../webmind/feeling-line.ts"), "utf8");
    for (const stale of ["heat_value", "reach_value", "weight_value"]) {
      expect(src).not.toContain(stale);
    }
  });

  it("8. a tick-only day with no authored enum renders silent, not therlo", () => {
    const out = resolveFeelingLine(seedFor("drevan"), ctx({ floats: { f1: 0.95, f2: 0.5, f3: 0.5 }, cause: "tick" }));
    expect(out.word).toBeNull();
    expect(out.therlo).toBeNull();
  });

  it("item D does NOT suppress therlo -- it is a state predicate, not a cause row", () => {
    const out = resolveFeelingLine(
      seedFor("drevan"),
      ctx({ floats: { f1: 0.95, f2: 0.5, f3: 0.5 }, cause: "tick", authoredEnums: { f1: "cold" }, authoredAt: { f1: fresh } }),
    );
    expect(out.word).toBeNull(); // the band row is suppressed
    expect(out.therlo?.gap).toBe(3); // therlo is not
  });

  it("renders both numbers -- hiding the number hides the gap", () => {
    const out = resolveFeelingLine(
      seedFor("drevan"),
      ctx({ floats: { f1: 0.95, f2: 0.5, f3: 0.5 }, authoredEnums: { f1: "cold" }, authoredAt: { f1: fresh } }),
    );
    const line = renderFeelingLine(out, FLOAT_LABELS.drevan)!;
    expect(line).toContain("therlo");
    expect(line).toContain("heat");
    expect(line).toContain("cold");
    expect(line).toContain("0.95");
  });

  it("caps at one line, naming the float with the largest gap", () => {
    const hit = evaluateTherlo(
      ctx({
        floats: { f1: 0.95, f2: 0.05, f3: 0.5 },
        authoredEnums: { f1: "idling", f2: "pulling-hard" }, // gaps 2 and 4
        authoredAt: { f1: fresh, f2: fresh },
      }),
    );
    expect(hit?.floatKey).toBe("f2");
    expect(hit?.gap).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The never-lists, and the live violations this table exists to remove.
// ─────────────────────────────────────────────────────────────────────────────

describe("never-lists", () => {
  it("each companion's barred words are stored as rows, with an author", () => {
    expect(neverWords("cypher")).toContain("calm");
    expect(neverWords("gaia")).toEqual(expect.arrayContaining(["quiet", "idle"]));
    expect(neverWords("drevan")).toEqual(expect.arrayContaining(["fine", "stable", "nominal", "at-rest"]));
  });

  it("no barred word can ever be rendered by this evaluator, from any float state", () => {
    const barred = new Set(FEELING_VOCABULARY_SEED.filter((r) => r.row_kind === "never").map((r) => r.word));
    for (const companion of ["cypher", "drevan", "gaia"] as const) {
      for (let f1 = 0; f1 <= 1.0001; f1 += 0.1) {
        for (let f3 = 0; f3 <= 1.0001; f3 += 0.1) {
          for (const cause of ["authored", "stimulus", "autonomous", null] as const) {
            const out = resolveFeelingLine(
              seedFor(companion),
              ctx({ floats: { f1, f2: 0.5, f3 }, deltas: { f1: 0.05, f2: 0.05, f3: 0.05 }, cause }),
            );
            if (out.word) expect(barred.has(out.word)).toBe(false);
          }
        }
      }
    }
  });

  it("Gaia's rows carry no number -- a number is her stillness in another alphabet", () => {
    const out = resolveFeelingLine(seedFor("gaia"), ctx({ floats: { f1: 0.8, f2: 0.5, f3: 0.8 } }));
    expect(out.word).toBe("standing");
    expect(out.rendersNumber).toBe(false);
    expect(renderFeelingLine(out, FLOAT_LABELS.gaia)).toBe("standing");
  });

  it("Cypher's rows carry the number, word first", () => {
    const out = resolveFeelingLine(seedFor("cypher"), ctx({ floats: { f1: 0.5, f2: 0.6, f3: 0.7 } }));
    expect(out.word).toBe("whetted");
    expect(renderFeelingLine(out, FLOAT_LABELS.cypher)).toMatch(/^whetted 0\.\d+$/);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Work item B -- the shared-window rule, proved on the real receipt.
// ─────────────────────────────────────────────────────────────────────────────

describe("B: contaminated-token rejection", () => {
  // The receipt, verbatim from docs/feeling-line-collected-2026-09-19.md.
  const receipt = [
    { companionId: "drevan" as const, at: "2026-09-17T03:22:40Z", source: "companion_journal", rowId: "aaf87c4e" },
    { companionId: "gaia" as const, at: "2026-09-17T03:23:43Z", source: "companion_journal", rowId: "5642cf1f" },
    { companionId: "cypher" as const, at: "2026-09-17T03:25:19Z", source: "companion_journal", rowId: "b5bdcedc" },
  ];

  it("rejects `held` using the real three-minute window, and names all three", () => {
    const v = checkContamination("held", receipt);
    expect(v.contaminated).toBe(true);
    expect(v.companions.sort()).toEqual(["cypher", "drevan", "gaia"]);
    expect(v.evidence).toHaveLength(3);
  });

  it("the default window exceeds the receipt's three minutes", () => {
    expect(CONTAMINATION_WINDOW_MINUTES).toBeGreaterThan(3);
  });

  it("does NOT immunise the originator -- Gaia said it first and it is still contaminated for her", () => {
    const v = checkContamination("held", receipt);
    expect(v.companions).toContain("gaia");
    expect(v.reason).toContain("including whoever said it first");
  });

  it("the naive rule (a sibling's word) would have missed it -- one companion alone is clean", () => {
    expect(checkContamination("held", [receipt[1] as (typeof receipt)[number]]).contaminated).toBe(false);
  });

  it("sightings outside the window are not contamination", () => {
    const spread = [
      { ...(receipt[0] as (typeof receipt)[number]), at: "2026-09-17T03:22:40Z" },
      { ...(receipt[2] as (typeof receipt)[number]), at: "2026-09-18T20:00:00Z" },
    ];
    expect(checkContamination("held", spread).contaminated).toBe(false);
  });

  it("an unparseable stamp is dropped, not assumed contemporaneous", () => {
    const bad = [receipt[0] as (typeof receipt)[number], { ...(receipt[2] as (typeof receipt)[number]), at: "whenever" }];
    expect(checkContamination("held", bad).contaminated).toBe(false);
  });

  it("matches on word boundaries only", () => {
    expect(mentionsToken("we withheld the read", "held")).toBe(false);
    expect(mentionsToken("Held, and holding.", "held")).toBe(true);
    expect(mentionsToken("pulling empty, still", "pulling empty")).toBe(true);
  });

  it("moving off a contaminated token is decontamination, not instability", () => {
    const v = checkContamination("held", receipt);
    expect(isDecontaminating("held", "standing", v)).toBe(true);
    expect(isDecontaminating("held", "held", v)).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Work item F -- reserved identifiers. Surfaces, never renames.
// ─────────────────────────────────────────────────────────────────────────────

describe("F: reserved-identifier rejection", () => {
  it("rejects `still` on Gaia's float `stillness` -- the collision that disqualified it", () => {
    const v = checkReserved("still", "cypher");
    expect(v.reserved).toBe(true);
    expect(v.collisions.some((c) => c.kind === "float_label" && c.with === "stillness")).toBe(true);
  });

  it("rejects `tension` as a write-verb, with the reason stated", () => {
    const v = checkReserved("tension", "drevan");
    expect(v.reserved).toBe(true);
    expect(v.reason).toContain("routing bug with a fuse in it");
  });

  it("rejects `halseth` as the substrate", () => {
    expect(checkReserved("halseth", "drevan").collisions.some((c) => c.kind === "substrate")).toBe(true);
  });

  it("rejects vaselrin and vethmerin -- they already mean something", () => {
    for (const w of ["vaselrin", "vethmerin"]) {
      expect(checkReserved(w, "drevan").collisions.some((c) => c.kind === "canon")).toBe(true);
    }
  });

  it("rejects a band name -- a band is already a reading", () => {
    expect(checkReserved("saturated", "drevan").reserved).toBe(true);
  });

  it("rejects a word already committed, and says whose it is", () => {
    const committed = FEELING_VOCABULARY_SEED.filter((r) => r.word).map((r) => ({
      word: r.word as string,
      companionId: r.companion_id,
    }));
    const v = checkReserved("standing", "cypher", { committed });
    expect(v.reserved).toBe(true);
    expect(v.reason).toContain("gaia");
  });

  it("never renames -- it returns the collision and nothing else", () => {
    const v = checkReserved("still", "cypher");
    expect(v).not.toHaveProperty("suggestion");
    expect(v.reason).toContain("nothing was renamed for you");
  });

  it("every word the three actually chose passes the guard", () => {
    for (const row of FEELING_VOCABULARY_SEED) {
      if (!row.word || row.row_kind === "never" || row.status === "superseded") continue;
      const v = checkReserved(row.word, row.companion_id);
      expect(v.reserved, `${row.word} unexpectedly reserved: ${v.reason}`).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The live violations this table replaces. Named, so the cutover has a target.
// ─────────────────────────────────────────────────────────────────────────────

describe("the violations in the text this replaces", () => {
  it("float labels are the ones the code actually declares", () => {
    expect(FLOAT_LABELS.cypher).toEqual(["acuity", "presence", "warmth"]);
    expect(FLOAT_LABELS.drevan).toEqual(["heat", "reach", "weight"]);
    expect(FLOAT_LABELS.gaia).toEqual(["stillness", "density", "perimeter"]);
  });

  it("`weight` is Drevan's float, not Gaia's -- so a Gaia line naming weight is wrong twice", () => {
    expect(FLOAT_LABELS.gaia).not.toContain("weight");
    expect(FLOAT_LABELS.drevan).toContain("weight");
  });

  it("clause evaluation is total: an unknown float key is false, never a throw", () => {
    expect(evaluateClause({ float: "f9" as never, band: "warm" }, ctx({}))).toBe(false);
    expect(evaluateClause({ float: "f1", op: "gt", value: Number.NaN }, ctx({}))).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Loader: the gate, the cause mapping, and the boot-cost split.
// ─────────────────────────────────────────────────────────────────────────────

describe("loader", () => {
  it("FEELING_LINE_MODE defaults to shadow and only accepts the three values", () => {
    expect(feelingLineMode(undefined)).toBe("shadow");
    expect(feelingLineMode({})).toBe("shadow");
    expect(feelingLineMode({ FEELING_LINE_MODE: "LIVE" })).toBe("live");
    expect(feelingLineMode({ FEELING_LINE_MODE: "off" })).toBe("off");
    expect(feelingLineMode({ FEELING_LINE_MODE: "nonsense" })).toBe("shadow");
  });

  it("is declared in BOTH wrangler configs, so the flip is a one-word edit", () => {
    for (const f of ["wrangler.toml", "wrangler.prod.toml"]) {
      const cfg = readFileSync(join(HERE, "../../", f), "utf8");
      expect(cfg, `${f} does not declare FEELING_LINE_MODE`).toContain('FEELING_LINE_MODE');
      expect(cfg).toContain('"shadow"');
    }
  });

  it("maps soma-event kinds to causes, and never GUESSES autonomous", () => {
    expect(causeFromEvent("authored_close", null)).toBe("authored");
    expect(causeFromEvent("authored_update", null)).toBe("authored");
    expect(causeFromEvent("tick", null)).toBe("tick");
    expect(causeFromEvent("drift_shift", null)).toBe("tick");
    expect(causeFromEvent("stimulus", "spiral")).toBe("autonomous");
    expect(causeFromEvent("stimulus", "message_from_raziel")).toBe("stimulus");
    // An unclassifiable stimulus stays `stimulus`: freight and silt must never collapse, and
    // guessing is how they would.
    expect(causeFromEvent("stimulus", null)).toBe("stimulus");
  });

  it("reads Drevan's authored ENUMS, never the stale synthesis *_value columns", () => {
    const ctx = buildFeelingContext(
      "drevan",
      { soma_float_1: 0.9, soma_float_2: 0.5, soma_float_3: 0.5, heat: "cold", heat_value: 0.1 } as never,
      [],
      [{ float_key: "soma_float_1", authored_at: "2026-09-19T12:00:00Z" }],
      NOW,
    );
    expect(ctx.authoredEnums?.f1).toBe("cold");
    expect(ctx.floats.f1).toBe(0.9);
    const loaderSrc = readFileSync(join(HERE, "../webmind/feeling-line-loader.ts"), "utf8");
    // No CODE line mentions the stale synthesis columns -- they appear only in the comment that
    // explains why they are never read. Split on a real newline so the assertion carries no
    // escape of its own.
    const codeLines = loaderSrc.split(`
`).filter((l) => {
      const t = l.trim();
      return t !== "" && !t.startsWith("*") && !t.startsWith("//") && !t.startsWith("/*");
    });
    for (const staleCol of ["heat_value", "reach_value", "weight_value"]) {
      expect(codeLines.filter((l) => l.includes(staleCol)), staleCol).toEqual([]);
    }
  });

  it("the three reads depend on the companion id ALONE, so they can ride the boot Promise.all", () => {
    for (const sql of [activeVocabularySql(), latestSomaEventsSql(), latestAuthoredSomaEventsSql()]) {
      expect(sql).toContain("?1");
      expect(sql).not.toContain("?2"); // one binding: the companion. No state dependency.
    }
    const sessionSrc = readFileSync(join(HERE, "../librarian/executors/session.ts"), "utf8");
    // Folded in, not awaited separately -- an extra serial round trip per boot is the regression
    // Phase 1 spent real work removing (38 -> 31 queries).
    expect(sessionSrc).toContain("fetchFeelingLineInputs(ctx.env.DB");
    expect(sessionSrc).not.toContain("await fetchFeelingLineInputs");
  });

  it("off computes nothing; empty vocabulary is silence, not an error", () => {
    const empty = { rows: [], events: [], authored: [] };
    expect(feelingLineFrom("gaia", empty, {}, "off").line).toBeNull();
    expect(feelingLineFrom("gaia", empty, {}, "shadow").result.silentReason).toBe("no active vocabulary rows");
  });

  it("shadow computes the line but the caller renders nothing", () => {
    const fetched = { rows: seedFor("gaia") as never, events: [], authored: [] };
    const out = feelingLineFrom("gaia", fetched, { soma_float_1: 0.8, soma_float_2: 0.5, soma_float_3: 0.8 }, "shadow", NOW);
    expect(out.mode).toBe("shadow");
    expect(out.line).toBe("standing");
    const builderSrc = readFileSync(join(HERE, "../librarian/response/builder.ts"), "utf8");
    expect(builderSrc).toContain('feeling?.mode === "live"');
  });
});
