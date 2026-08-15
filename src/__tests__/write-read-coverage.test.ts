// Write→read coverage guardrail (2026-07-26, foundation audit).
//
// The failure mode this prevents: a companion writes a thought to a D1 table and no read
// surface ever returns it -- a write-only hole. It happened silently at least four times
// (sits read from dead pre-0034 tables for months; feelings never appeared in any boot;
// journal_read returned a different table than every journal write filled; broadcasts were
// boot-visible but never re-readable). docs/write-read-coverage.md is the human matrix;
// this test enforces the structural floor:
//
//   1. every D1 table a Librarian verb writes (per write-routing-map.md) is SELECTed
//      somewhere in src/ -- unless explicitly allowlisted as write-only by design
//   2. dead tables stay dead -- nothing regresses to reading a superseded sibling table
//   3. spot-checks for the specific 2026-07-26 hole fixes stay in place
//
// Like write-routing-map.test.ts, this is a source-scan: it asserts on SQL text, not on
// runtime behavior. Indirection (a reader helper imported elsewhere) still counts because
// the helper's SQL is in the scan.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(here, "..");
const migrationsDir = resolve(here, "../../migrations");
const mapDoc = readFileSync(resolve(here, "../../docs/write-routing-map.md"), "utf8");

/** All .ts sources under src/, excluding tests (this file must not satisfy its own assertions). */
function collectSources(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) {
      if (name === "__tests__") continue;
      out.push(...collectSources(p));
    } else if (name.endsWith(".ts")) {
      out.push(p);
    }
  }
  return out;
}

const sourceFiles = collectSources(srcRoot);
const allSource = sourceFiles.map((f) => readFileSync(f, "utf8")).join("\n");

/** D1 table names, from CREATE TABLE statements across all migrations. */
function knownTables(): Set<string> {
  const tables = new Set<string>();
  for (const name of readdirSync(migrationsDir)) {
    if (!name.endsWith(".sql")) continue;
    const sql = readFileSync(join(migrationsDir, name), "utf8");
    for (const m of sql.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?([a-z][a-z0-9_]*)/gi)) {
      tables.add(m[1]!.toLowerCase());
    }
  }
  return tables;
}

/**
 * Tables written by Librarian verbs, parsed from the write-routing-map target column
 * (3rd cell). Identifiers in that cell that are real D1 tables count; "READ" rows and
 * external-SB rows contribute nothing.
 */
function writtenTables(doc: string, known: Set<string>): Set<string> {
  const written = new Set<string>();
  for (const row of doc.matchAll(/^\| `[a-zA-Z_]\w*` \| \w+ \| [\w.]+ \| ([^|]+) \|/gm)) {
    const cell = row[1]!;
    if (/^\s*READ\b/.test(cell)) continue;
    for (const ident of cell.matchAll(/[a-z][a-z0-9_]{2,}/g)) {
      if (known.has(ident[0]!)) written.add(ident[0]!);
    }
  }
  return written;
}

/** Write-only by design: each entry needs a reason, reviewed when the matrix changes. */
const WRITE_ONLY_BY_DESIGN: Record<string, string> = {
  wm_thread_events:
    "pure audit log of thread lifecycle (synthesis/index.ts says so); 0 reads is intentional. " +
    "Hidden until 2026-08-15 because its 90-day DELETE FROM purge satisfied the old read regex -- " +
    "declared here instead so the guard stays honest (coherence review D8)",
};

/** Superseded tables no non-test source may reference again. */
const DEAD_TABLES: Record<string, string> = {
  companion_note_sits:
    "superseded by companion_journal_sits in migration 0034; ground.ts kept reading it " +
    "for ~4 months so sits were invisible at every ground boot (fixed 2026-07-26)",
};

describe("write→read coverage floor", () => {
  const known = knownTables();
  const written = writtenTables(mapDoc, known);

  it("parses plausible table sets", () => {
    expect(known.size).toBeGreaterThan(40);
    expect(written.size).toBeGreaterThan(15);
  });

  it("every Librarian-written D1 table is SELECTed somewhere in src/", () => {
    // A retention purge is not a read: `DELETE FROM x` matched the old FROM regex and kept
    // wm_thread_events green for months while nothing ever read it (coherence review D8).
    const readableSource = allSource.replace(/DELETE\s+FROM\s+[a-z0-9_]+/gi, "");
    const holes: string[] = [];
    for (const table of written) {
      if (table in WRITE_ONLY_BY_DESIGN) continue;
      // FROM <table> or JOIN <table> anywhere in non-test source counts as a read path.
      const readRe = new RegExp(`(?:FROM|JOIN)\\s+${table}\\b`, "i");
      if (!readRe.test(readableSource)) holes.push(table);
    }
    expect(
      holes,
      `write-only holes -- these tables are written by a Librarian verb but never SELECTed; ` +
        `wire a read surface or add to WRITE_ONLY_BY_DESIGN with a reason: ${holes.join(", ")}`
    ).toEqual([]);
  });

  it("dead tables are never referenced again", () => {
    const regressions: string[] = [];
    for (const [table, why] of Object.entries(DEAD_TABLES)) {
      if (new RegExp(`\\b${table}\\b`).test(allSource)) {
        regressions.push(`${table} (${why})`);
      }
    }
    expect(regressions).toEqual([]);
  });
});

describe("2026-07-26 hole-fix regression guards", () => {
  const groundSrc = readFileSync(resolve(srcRoot, "webmind/ground.ts"), "utf8");
  const orientSrc = readFileSync(resolve(srcRoot, "webmind/orient.ts"), "utf8");
  const readsSrc = readFileSync(resolve(srcRoot, "librarian/executors/reads.ts"), "utf8");
  const backendSrc = readFileSync(resolve(srcRoot, "librarian/backends/halseth.ts"), "utf8");
  const builderSrc = readFileSync(resolve(srcRoot, "librarian/response/builder.ts"), "utf8");

  it("HOLE 1: ground reads sits through the canonical reader, not inline SQL", () => {
    expect(groundSrc).toMatch(/readSittingNotes/);
    expect(groundSrc).not.toMatch(/companion_note_sits/);
  });

  it("HOLE 2: companion journal_read unions companion_journal with growth_journal", () => {
    expect(readsSrc).toMatch(/FROM companion_journal\b/);
    expect(readsSrc).toMatch(/FROM growth_journal\b/);
  });

  it("HOLE 5: mindOrient carries feelings and open loops, and the builder renders them", () => {
    expect(orientSrc).toMatch(/FROM feelings\b/);
    expect(orientSrc).toMatch(/FROM companion_open_loops\b/);
    expect(builderSrc).toMatch(/recent_feelings/);
    expect(builderSrc).toMatch(/open_loops/);
  });

  it("HOLE 6: companion_notes_read includes triad broadcasts", () => {
    const fn = backendSrc.slice(backendSrc.indexOf("function companionNotesRead"));
    const sql = fn.slice(0, fn.indexOf("}"));
    expect(sql).toMatch(/to_id IS NULL/);
  });
});
