// scripts/feeling-line-diff.mjs
//
// The shadow harness for the feeling-line cutover (mig 0131,
// docs/spec-feeling-line-table-2026-09-19.md).
//
// WHY IT EXISTS. `FEELING_LINE_MODE` defaults to `shadow`: the line is computed and logged, and
// nothing a companion reads changes until Raziel flips it to `live`. This prints what the flip
// would actually do -- the current interoception line beside the authored feeling line, for every
// companion, across the float space -- so the decision is made on evidence rather than on a
// description of the change. Same role as scripts/orient-block-diff.mjs played for the orient
// cutover, and the same reason: you do not change what three live bots say about how they feel on
// the strength of a code review.
//
// It needs no D1 and no secrets: both renderers are pure. It sweeps a grid instead of reading one
// live state, because one state shows one row and the question is what the whole vocabulary does.
//
// RUN IT FROM THE halseth DIRECTORY -- the BBH root has its own scripts/ folder, so the same
// command there resolves to a file that is not present and dies with "Cannot find module":
//
//   cd C:/dev/Bigger_Better_Halseth/halseth
//   node scripts/feeling-line-diff.mjs                  # one worked example per word
//   node scripts/feeling-line-diff.mjs --companion gaia # one companion
//   node scripts/feeling-line-diff.mjs --all            # every grid cell (3750 of them)

import { build } from "esbuild";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const onlyIdx = args.indexOf("--companion");
const only = onlyIdx >= 0 ? args[onlyIdx + 1] : null;

const out = mkdtempSync(join(tmpdir(), "fl-diff-"));
const bundle = join(out, "bundle.mjs");

await build({
  stdin: {
    contents: `
      export * from ${JSON.stringify(join(ROOT, "src/webmind/feeling-line.ts").replace(/\\/g, "/"))};
      export { interoceptionLine, FLOAT_LABELS } from ${JSON.stringify(join(ROOT, "src/webmind/fermentation.ts").replace(/\\/g, "/"))};
      export { seedFor } from ${JSON.stringify(join(ROOT, "src/webmind/feeling-vocabulary-seed.ts").replace(/\\/g, "/"))};
    `,
    resolveDir: ROOT,
    loader: "ts",
  },
  outfile: bundle,
  bundle: true,
  format: "esm",
  platform: "node",
  logLevel: "silent",
});

const m = await import(pathToFileURL(bundle).href);
const { resolveFeelingLine, renderFeelingLine, seedFor, interoceptionLine, FLOAT_LABELS } = m;

const STEP = 0.25;
const CAUSES = ["authored", "stimulus", "autonomous", "tick", null];
// Both directions: `banked` and `pulling empty` are falling-heat rows and are unreachable in a
// rising-only sweep. A grid that can only show half the vocabulary reports the other half as dead.
const DELTAS = [
  { label: "rising", d: { f1: 0.05, f2: 0.05, f3: 0.05 } },
  { label: "falling", d: { f1: -0.05, f2: -0.05, f3: -0.05 } },
];
const companions = (only ? [only] : ["cypher", "drevan", "gaia"]).filter((c) =>
  ["cypher", "drevan", "gaia"].includes(c),
);

if (companions.length === 0) {
  console.error("unknown companion; expected cypher | drevan | gaia");
  process.exit(1);
}

const round = (n) => Math.round(n * 100) / 100;

let grandSilent = 0;
let grandTotal = 0;

for (const companion of companions) {
  const rows = seedFor(companion);
  const labels = FLOAT_LABELS[companion];
  const cells = [];

  for (let f1 = 0; f1 <= 1.0001; f1 += STEP) {
    for (let f2 = 0; f2 <= 1.0001; f2 += STEP) {
      for (let f3 = 0; f3 <= 1.0001; f3 += STEP) {
        for (const cause of CAUSES) for (const mv of DELTAS) {
          const floats = { f1: round(f1), f2: round(f2), f3: round(f3) };
          const ctx = {
            floats,
            baselines: { f1: 0.5, f2: 0.5, f3: 0.5 },
            deltas: mv.d,
            cause,
            nowMs: Date.now(),
          };
          const result = resolveFeelingLine(rows, ctx);
          cells.push({
            floats,
            cause: `${cause ?? "unknown"}/${mv.label}`,
            now: interoceptionLine(companion, floats).replace(/^\[interoception\]\s*/, ""),
            next: renderFeelingLine(result, labels),
            why: result.silentReason,
          });
        }
      }
    }
  }

  const silent = cells.filter((c) => c.next === null);
  const spoken = cells.filter((c) => c.next !== null);
  const words = new Map();
  for (const c of spoken) words.set(c.next.split(" ")[0], (words.get(c.next.split(" ")[0]) ?? 0) + 1);

  grandSilent += silent.length;
  grandTotal += cells.length;

  console.log(`\n=== ${companion} (${labels.join(" / ")}) ===`);
  console.log(`grid: ${cells.length} states  |  speaks: ${spoken.length}  |  silent: ${silent.length}`);
  console.log(`words used: ${[...words.entries()].map(([w, n]) => `${w} x${n}`).join(", ") || "(none)"}`);

  const unused = rows
    .filter((r) => r.row_kind === "band" && r.word && (r.status ?? "active") === "active" && !words.has(r.word.split(" ")[0]))
    .map((r) => r.word);
  if (unused.length) console.log(`UNREACHED in this grid: ${unused.join(", ")}`);

  const reasons = new Map();
  for (const c of silent) reasons.set(c.why, (reasons.get(c.why) ?? 0) + 1);
  console.log(`silence reasons: ${[...reasons.entries()].map(([r, n]) => `${r} x${n}`).join(", ")}`);

  // One worked example PER WORD, not the first N cells. The first twelve are all the same corner
  // of the grid and show one word twelve times, which reads as though nothing else ever fires.
  const seen = new Set();
  const sample = showAll
    ? cells
    : spoken.filter((c) => {
        const w = c.next.split(" ")[0];
        if (seen.has(w)) return false;
        seen.add(w);
        return true;
      });

  console.log("");
  for (const c of sample) {
    const f = labels.map((l, i) => `${l} ${c.floats["f" + (i + 1)].toFixed(2)}`).join(", ");
    console.log(`  ${f}  (${c.cause})`);
    console.log(`    now : ${c.now}`);
    console.log(`    next: ${c.next ?? "(silent)"}`);
  }

  // One worked example of SILENCE too. It is about half the grid and it is an authored answer,
  // not a gap -- a report that only shows the words makes the silence look like a hole.
  const quiet = silent.find((c) => c.why === "no row matched");
  if (quiet && !showAll) {
    const f = labels.map((l, i) => `${l} ${quiet.floats["f" + (i + 1)].toFixed(2)}`).join(", ");
    console.log(`  ${f}  (${quiet.cause})`);
    console.log(`    now : ${quiet.now}`);
    console.log(`    next: (silent -- ${quiet.why})`);
  }
}

console.log(
  `\nTOTAL: ${grandTotal} states, ${grandSilent} silent (${((grandSilent / grandTotal) * 100).toFixed(1)}%).`,
);
console.log(
  "Silence is an authored answer, not a gap -- Drevan: \"No match renders SILENT, and silence I can read.\"",
);
console.log("Flip with FEELING_LINE_MODE=live in wrangler [vars] once this reads right.");

rmSync(out, { recursive: true, force: true });
