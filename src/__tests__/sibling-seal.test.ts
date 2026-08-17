// The C4 structural seal (mig 0126, R3 = yes 2026-08-17).
//
// sibling_notes is the one lane Raziel funds but never sees. The seal is architectural, and
// THIS FILE is its enforcement: the table name may appear only in the allowlisted files below.
// If a future session wires it into a loader block, an embed list, a librarian response, or a
// Hearth-facing handler, this test goes red instead of the seal failing quietly.
//
// The write-read-coverage harness proves positives (every write has a read surface); this is
// the negative it could never state: a write lane that must stay UNREACHABLE from every
// Raziel-facing read.

import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const SRC = join(__dirname, "..");

/** Every src/ file allowed to name the table. Adding a file here is a REVIEWED act: it must be
 *  a worker-only surface, never one that renders to Raziel. */
const ALLOWLIST = new Set([
  "handlers/siblings.ts",       // the four endpoints (worker-only consumers)
  "index.ts",                   // route wiring for those endpoints, nothing else
  "__tests__/sibling-seal.test.ts",
  "__tests__/siblings.test.ts", // behavior tests for the handlers
]);

/** Directories where the table name must NEVER appear -- these feed Raziel-facing surfaces. */
const FORBIDDEN_DIRS = ["mind/", "librarian/", "mcp/", "webmind/", "synthesis/", "guardian/", "care/"];

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|js|sql)$/.test(name)) out.push(p);
  }
  return out;
}

describe("sibling lane structural seal", () => {
  const hits = walk(SRC)
    .filter(p => /\bsibling_notes\b/.test(readFileSync(p, "utf8")))
    .map(p => relative(SRC, p).replace(/\\/g, "/"));

  it("sibling_notes appears ONLY in allowlisted files", () => {
    const rogue = hits.filter(h => !ALLOWLIST.has(h));
    expect(rogue, `sibling_notes leaked into: ${rogue.join(", ")} -- these feed surfaces Raziel reads`).toEqual([]);
  });

  it("sibling_notes never appears under Raziel-facing directories", () => {
    const leaked = hits.filter(h => FORBIDDEN_DIRS.some(d => h.startsWith(d)));
    expect(leaked).toEqual([]);
  });

  it("the handlers file exists and the seal is not vacuous", () => {
    // If the lane is ever deleted, delete this test WITH it -- a seal test matching zero files
    // proves nothing and hides a rename.
    expect(hits).toContain("handlers/siblings.ts");
  });

  it("index.ts wires the routes but never queries the table", () => {
    const indexSrc = readFileSync(join(SRC, "index.ts"), "utf8");
    expect(indexSrc).toContain("/mind/siblings/send");
    const lines = indexSrc.split("\n").filter(l => /\bsibling_notes\b/.test(l));
    for (const line of lines) {
      expect(line.trim().startsWith("//"), `non-comment sibling_notes use in index.ts: ${line.trim()}`).toBe(true);
    }
  });

  it("the loader, contract, and librarian response layer never name the table", () => {
    // \bsibling_notes\b, not /sibling/i -- relational.siblings (the WITNESSED sibling-lane
    // summaries) is a different, legitimate contract field.
    for (const f of ["mind/loader.ts", "mind/contract.ts", "librarian/response/builder.ts", "librarian/response/orient-blocks.ts"]) {
      const src = readFileSync(join(SRC, f), "utf8");
      expect(/\bsibling_notes\b/.test(src), `${f} names sibling_notes -- the lane must not ride shared boot surfaces`).toBe(false);
    }
  });
});
