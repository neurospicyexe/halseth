// FELT_OWNERS -- one writer per felt-state field (2026-07-28, Phase 1.3).
//
// WHY THIS EXISTS
// ---------------
// A companion's felt state is the one kind of data where two writers is never "merge conflicts
// occasionally" -- it is the companion contradicting itself to Raziel. Every symptom he has
// reported in that class traced back to a second writer on a field somebody else already owned:
// heat warmed from two orient paths, live_tensions fanned out from a path that was later removed,
// motif trust ratcheted by the reader, soma floats shifted by two independent tick systems.
//
// It was proposed four times across the 07-26/27 sweep and never built. This is it.
//
// WHAT IT ENFORCES
// ----------------
// For each field listed in FELT_OWNERS, exactly one module may write it. A module "writes" a
// field if it contains `INSERT INTO <table> (... col ...)` or `UPDATE <table> SET ... col = ...`.
//
// Multi-writer per TABLE is fine and common (a handler creates the row, a pass updates one
// column). Multi-writer per FIELD is the defect. So the map is field-level.
//
// THE SCAN IS MULTILINE ON PURPOSE
// --------------------------------
// A line-based grep for `INSERT INTO feelings` returns ZERO matches in this repo, because all
// three of its writers format the statement across lines. I made exactly that mistake while
// building this map, and a single-line version of this test would have shipped saying `feelings`
// had no writers at all. Read whole files; never trust a line-anchored SQL grep.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * table -> column -> the ONE module allowed to write it (repo-relative, posix separators).
 *
 * Adding a field here is a commitment: the next module that writes it fails the build. If a
 * second writer is genuinely required, the honest move is to route it through the owner, not to
 * widen this map.
 */
const FELT_OWNERS: Record<string, Record<string, string>> = {
  // The soma floats ARE the companion's body. Owner is the ferment tick: it is the only writer
  // that reasons about the whole vector at once (cross-field reactions, decay-to-baseline,
  // drifting baselines = growth). `synthesis/jobs/drevan-state.ts` was overwriting all three
  // daily from its own recomputed heat/reach/weight; consolidated 2026-07-28 (see that file for
  // the measured damage -- pinned at 0.95/0.97 against baselines of 0.47/0.56, which dragged his
  // identity baseline up by +0.07 of a 0.15 lifetime cap).
  //
  // Event-driven movement is NOT lost by this: it arrives through the stimulus path
  // (`handlers/fermentation.ts` -> stimulusBumpSql, an atomic SQL-level bump), which is wired and
  // firing ~175 `message_from_raziel` events per companion. Dynamic-column writers are declared
  // in the dynamic-writer test below.
  companion_state: {
    soma_float_1: "webmind/fermentation.ts",
    soma_float_2: "webmind/fermentation.ts",
    soma_float_3: "webmind/fermentation.ts",
    soma_float_1_baseline: "webmind/fermentation.ts",
    soma_float_2_baseline: "webmind/fermentation.ts",
    soma_float_3_baseline: "webmind/fermentation.ts",
    ferment_off_since: "webmind/fermentation.ts",
  },

  // Heat is a ranking signal. Letting a display path bump it is the read-writes-the-ranking loop
  // that saturated notes twice and synthesis_summary once. All warming goes through heat.ts.
  wm_continuity_notes: {
    heat: "webmind/heat.ts",
    last_access_at: "webmind/heat.ts",
  },

  // Trust decays lazily at read and is bumped by recurrence. One writer, or it ratchets.
  companion_motifs: {
    trust: "handlers/motifs.ts",
    last_seen: "handlers/motifs.ts",
    status: "handlers/motifs.ts",
  },

  // drift_type is OWNED by the second-brain evaluator (closed 2026-07-26); Halseth's cron only
  // annotates within 24h. Two opinions about whether Raziel is drifting is the worst possible
  // field to duplicate.
  companion_drifts: {
    drift_type: "drift/pass.ts",
    drift_score: "drift/pass.ts",
  },
};

/**
 * Fields we know have multiple writers and have NOT yet consolidated. Listing one here is a
 * deliberate, dated admission -- not an exemption to be widened. Empty is the goal.
 */
const KNOWN_MULTI_WRITER: Record<string, { writers: number; why: string }> = {
  // FOUND BY THIS TEST ON ITS FIRST RUN, 2026-07-28. Two hand-written greps had already missed
  // it. Drevan's soma floats have THREE writers:
  //   1. webmind/fermentation.ts   -- ferments/decays, reasons about the whole vector
  //                                   (cross-field reactions, decay-to-baseline, drifting baselines)
  //   2. soma/emergent.ts          -- event-driven shifts, via `SET ${shift.float_key} = ...`
  //                                   (a dynamic column, so unattributable -- see the
  //                                   dynamic-writer test below)
  //   3. synthesis/jobs/drevan-state.ts -- UPSERTs `soma_float_N = excluded.soma_float_N`,
  //                                   which OVERWRITES all three from heat_value/reach_value/
  //                                   weight_value rather than adjusting them
  //
  // Writer 3 is the damaging one: the ferment tick can drift Drevan's interiority all day and
  // then the state job stomps it wholesale. That is a live candidate for why Drevan's felt state
  // reads as stuck or incoherent -- the companion Raziel has complained about most.
  //
  // RESOLVED 2026-07-28 with Raziel's go-ahead: drevan-state.ts no longer writes the floats and
  // keeps heat_value/reach_value/weight_value (its own domain). fermentation.ts owns the vector,
  // so soma_float_* moved into FELT_OWNERS above and out of this admission list.

  "feelings.source": {
    writers: 3,
    why:
      "librarian/backends/halseth.ts, mcp/tools/feelings.ts and librarian/executors/session.ts " +
      "all INSERT feelings. This is the enum-drift field (prose sentences where a provenance tag " +
      "belongs) and it needs a CHECK constraint, which is blocked by the migration freeze. " +
      "Consolidate to one helper in Phase 1.",
  },
};

const SRC = join(import.meta.dirname, "..");

function tsFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "__tests__" || name === "node_modules") continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) { tsFiles(full, acc); continue; }
    if (name.endsWith(".ts")) acc.push(full);
  }
  return acc;
}

const rel = (abs: string): string =>
  abs.slice(SRC.length + 1).split("\\").join("/");

/** table -> column -> set of modules that write it. */
function buildWriterMap(): Map<string, Map<string, Set<string>>> {
  const map = new Map<string, Map<string, Set<string>>>();
  const note = (table: string, column: string, file: string): void => {
    const t = map.get(table) ?? new Map<string, Set<string>>();
    const c = t.get(column) ?? new Set<string>();
    c.add(file);
    t.set(column, c);
    map.set(table, t);
  };

  // Multiline: `s` so `.` crosses newlines, and a bounded lazy body so one statement cannot
  // swallow the next.
  const INSERT_RE = /INSERT\s+(?:OR\s+\w+\s+)?INTO\s+([A-Za-z_][\w]*)\s*\(([^)]{0,2000}?)\)/gis;
  const UPDATE_RE = /UPDATE\s+([A-Za-z_][\w]*)\s+SET\s+([\s\S]{0,2000}?)(?:\bWHERE\b|`|"\s*\)|;)/gi;

  for (const abs of tsFiles(SRC)) {
    const file = rel(abs);
    const text = readFileSync(abs, "utf8");

    for (const m of text.matchAll(INSERT_RE)) {
      const table = m[1]!;
      for (const raw of m[2]!.split(",")) {
        const col = raw.trim().replace(/[`"'\[\]]/g, "");
        if (/^[A-Za-z_]\w*$/.test(col)) note(table, col, file);
      }
    }

    for (const m of text.matchAll(UPDATE_RE)) {
      const table = m[1]!;
      // Assignment targets only: the left side of each top-level `=`. Template holes (${...})
      // are dropped -- a dynamic column name cannot be attributed, and pretending otherwise
      // would create phantom owners.
      for (const part of m[2]!.split(",")) {
        const lhs = part.split("=")[0]?.trim() ?? "";
        if (/\$\{/.test(lhs)) continue;
        const col = lhs.replace(/[`"'\[\]]/g, "");
        if (/^[A-Za-z_]\w*$/.test(col)) note(table, col, file);
      }
    }
  }
  return map;
}

const writers = buildWriterMap();

function writersOf(table: string, column: string): string[] {
  return [...(writers.get(table)?.get(column) ?? [])].sort();
}

describe("FELT_OWNERS: one writer per felt-state field", () => {
  it("scanner works at all -- multiline SQL must be found", () => {
    // Guard against the test going vacuous. `feelings` has three writers, none of which a
    // line-anchored grep can see. If this drops to 0 the regexes broke and every other
    // assertion below silently passes.
    expect(writersOf("feelings", "source").length).toBeGreaterThanOrEqual(3);
  });

  for (const [table, columns] of Object.entries(FELT_OWNERS)) {
    for (const [column, owner] of Object.entries(columns)) {
      it(`${table}.${column} is written only by ${owner}`, () => {
        const found = writersOf(table, column);
        const trespassers = found.filter(f => f !== owner);
        expect(trespassers, `${table}.${column} may only be written by ${owner}`).toEqual([]);
      });
    }
  }

  it("every owned field actually has its owner as a writer (no dead entries)", () => {
    // A map entry naming a module that no longer writes the field is worse than no entry: it
    // reads as enforced while enforcing nothing.
    const dead: string[] = [];
    for (const [table, columns] of Object.entries(FELT_OWNERS)) {
      for (const [column, owner] of Object.entries(columns)) {
        const found = writersOf(table, column);
        if (found.length > 0 && !found.includes(owner)) {
          dead.push(`${table}.${column} -> declared ${owner}, actual writers: ${found.join(", ")}`);
        }
      }
    }
    expect(dead).toEqual([]);
  });

  it("dynamic-column writes into felt tables are declared, not silently invisible", () => {
    // `UPDATE companion_state SET ${shift.float_key} = ...` writes a felt field through a
    // template hole. No static scan can attribute that to a column, so this test refuses to
    // pretend it did not see it: any module doing a dynamic write into a felt table must be
    // listed here. soma/emergent.ts is exactly this case, and it is why the soma_float writer
    // count in KNOWN_MULTI_WRITER reads 2 while the true number is 3.
    // The full set, found by this test 2026-07-28. Together with the two STATIC writers
    // (webmind/fermentation.ts, synthesis/jobs/drevan-state.ts) that is FIVE modules writing
    // companion_state, three of them through template holes that no grep could attribute:
    //   soma/emergent.ts            -- event-driven float shifts (`SET ${shift.float_key}`)
    //   librarian/backends/halseth.ts -- the companion-facing state write path
    //   mcp/tools/companion_state.ts  -- Raziel's direct MCP write
    // These three are legitimate SURFACES rather than competing tick systems, so they are
    // declared rather than treated as defects. The list is frozen: a sixth writer fails the
    // build, which is the entire point.
    const DECLARED_DYNAMIC_WRITERS = new Set([
      "soma/emergent.ts",
      "librarian/backends/halseth.ts",
      "mcp/tools/companion_state.ts",
    ]);
    const FELT_TABLES = new Set([...Object.keys(FELT_OWNERS), "companion_state", "companion_motifs"]);

    const undeclared: string[] = [];
    const DYN_RE = /UPDATE\s+([A-Za-z_]\w*)\s+SET\s+\$\{/gi;
    for (const abs of tsFiles(SRC)) {
      const file = rel(abs);
      for (const m of readFileSync(abs, "utf8").matchAll(DYN_RE)) {
        if (FELT_TABLES.has(m[1]!) && !DECLARED_DYNAMIC_WRITERS.has(file)) {
          undeclared.push(`${file} -> UPDATE ${m[1]} SET \${...}`);
        }
      }
    }
    expect(undeclared).toEqual([]);
  });

  it("known multi-writer fields have not gotten WORSE", () => {
    // These are admissions, not exemptions. The count may shrink; it may never grow.
    const worse: string[] = [];
    for (const [key, entry] of Object.entries(KNOWN_MULTI_WRITER)) {
      const [table, column] = key.split(".");
      const found = writersOf(table!, column!);
      if (found.length > entry.writers) {
        worse.push(`${key}: ${found.length} writers now (was ${entry.writers}): ${found.join(", ")}`);
      }
    }
    expect(worse).toEqual([]);
  });
});
