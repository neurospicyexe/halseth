// Gaia's seal on the interiority rooms, as the ledger lane sees it (2026-09-26,
// docs/imp-lane/GAIA-ANSWER-2026-09-26.md):
//
//   "A clerk never reads, counts, or references the interiority rooms. Not even a count of them."
//
// The grammar refuses the word root in any ledger body and any `row` source that names the rooms
// (src/ledger/grammar.ts, rule `interiority`). This file is the structural half: the table name may
// appear ONLY in its owner handler. Measured when this was written: src/handlers/interiority.ts is the
// one file under src/ (tests aside) that names it, so the allowlist is exactly that file. Sweeping all of
// src/ is stronger than sweeping the ledger, commons/director supply and /ingest/* feeds alone, and it
// covers them: none of those can grow a read of the rooms without this going red.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");
const TABLE_RE = /\bcompanion_interiority\b/;

/** Adding a file here is a REVIEWED act, and never a clerk, a supply query, or a feed. */
const ALLOWLIST = new Set([
  "handlers/interiority.ts",                 // the owner: the rooms' own reads and writes
  "__tests__/interiority.test.ts",           // behaviour tests for that handler
  "__tests__/interiority-executor.test.ts",  // behaviour tests for its Librarian verbs
  "__tests__/interiority-seal.test.ts",      // this file
]);

/** The surfaces Gaia's line names, checked by name so a failure says which one leaked. */
const CLERK_SURFACES = [
  "ledger/",               // the lane itself: door, grammar, store, friction
  "director/",             // director supply
  "handlers/ledger.ts",    // POST /ledger, GET /ledger, /ingest/ledger, /ingest/ledger-ineligible
  "handlers/ingest.ts",    // the other /ingest/* feeds (if present)
  "handlers/webmind.ts",   // commons supply
  "handlers/commons.ts",   // the commons wall
];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|sql)$/.test(name)) out.push(p);
  }
  return out;
}

describe("interiority seal: no clerk, supply or feed ever names the rooms", () => {
  const hits = walk(SRC)
    .filter((p) => TABLE_RE.test(readFileSync(p, "utf8")))
    .map((p) => relative(SRC, p).replace(/\\/g, "/"));

  it("the table name appears ONLY in its owner handler (and its tests)", () => {
    expect(hits.filter((h) => !ALLOWLIST.has(h))).toEqual([]);
    expect(hits).toContain("handlers/interiority.ts");
  });

  it("none of the ledger, supply, commons or /ingest/* surfaces names it", () => {
    expect(hits.filter((h) => CLERK_SURFACES.some((s) => h.startsWith(s)))).toEqual([]);
  });

  it("every /ingest/* handler file is swept (the feeds are named in index.ts)", () => {
    const index = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(/\/ingest\//.test(index)).toBe(true);
    expect(TABLE_RE.test(index)).toBe(false);
  });
});
