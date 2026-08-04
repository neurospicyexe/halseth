// A reconstructed close must never be readable as a live one, and a session row must record who
// opened it (migration 0114, 2026-08-04).
//
// Why these tests exist: 187 sessions sat open, oldest 2026-03-11, and closing them meant writing
// spines from evidence after the fact. Two failure modes had to be made structurally impossible.
//
//  1. A backfilled handover winning "the latest handover". Every continuity read is a global
//     `ORDER BY created_at DESC LIMIT 1` with no companion filter -- so one backdated row landing
//     in the wrong place makes archaeology the next boot's narrative. That is the same shape as the
//     bug mig 0095 fixed (backfilled sessions breaking last-session recency).
//  2. Sessions being opened by something nobody can name afterwards. `surface` (0113) says WHERE a
//     session was opened; nothing said WHAT opened it, which is exactly why the 187 could not be
//     attributed. Every INSERT site now writes opened_by.

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { OPENED_BY } from "../db/queries.js";
import { FAST_PATH_PATTERNS } from "../librarian/patterns.js";
import { matchFastPath } from "../librarian/router.js";

const readSource = (rel: string) => readFile(resolve(rel), "utf8");

/** Every file that reads "the newest handover, any companion". */
const LATEST_HANDOVER_READERS = [
  "src/db/queries.ts",
  "src/handlers/presence.ts",
  "src/librarian/backends/halseth.ts",
  "src/mcp/tools/session.ts",
  "src/mcp/tools/session_load.ts",
];

/**
 * Synthesis reads handovers to narrate what was lived. A backfilled spine is archaeology and its
 * motion_state is a placeholder, so these must be filtered too -- feeding "a job opened this row"
 * into a companion's state synthesis is the consolidateSession defect (machine text narrated as
 * interior) in a different job.
 */
const SYNTHESIS_HANDOVER_READERS = [
  "src/synthesis/jobs/drevan-state.ts",
  "src/synthesis/jobs/somatic-snapshot.ts",
];

/** Display surfaces: showing a reconstruction here is CORRECT. Listed so nobody "fixes" them. */
const UNFILTERED_BY_DESIGN = [
  "src/handlers/history.ts",
  "src/handlers/sessions.ts",
  "src/handlers/handovers.ts",
];

/** Every file that INSERTs a session row. */
const SESSION_INSERT_FILES = [
  "src/mcp/tools/session.ts",
  "src/mcp/tools/session_load.ts",
];

describe("backfilled closes cannot be read as live ones", () => {
  it("every global latest-handover read filters close_kind IS NULL", async () => {
    for (const file of LATEST_HANDOVER_READERS) {
      const src = await readSource(file);
      const unguarded = [...src.matchAll(/FROM handover_packets\s+ORDER BY created_at DESC LIMIT 1/gi)];
      expect(
        unguarded.length,
        `${file} has an unguarded newest-handover read. A close_kind row (reconstructed/empty/machine_opened) would be served as the last thing that happened.`,
      ).toBe(0);
    }
  });

  it("at least one read per file is guarded, so the assertion above cannot pass by the query being gone", async () => {
    for (const file of LATEST_HANDOVER_READERS) {
      const src = await readSource(file);
      expect(
        /FROM handover_packets WHERE close_kind IS NULL\s+ORDER BY created_at DESC LIMIT 1/i.test(src),
        `${file} no longer contains a guarded newest-handover read -- did the query move?`,
      ).toBe(true);
    }
  });

  it("a per-session handover read is NOT filtered -- asking for that session should return its reconstruction", async () => {
    const src = await readSource("src/mcp/tools/session.ts");
    expect(src).toMatch(/FROM handover_packets WHERE session_id = \?/);
  });

  it("every synthesis handover read filters close_kind IS NULL", async () => {
    for (const file of SYNTHESIS_HANDOVER_READERS) {
      const src = await readSource(file);
      const reads = [...src.matchAll(/FROM handover_packets\s+WHERE[^`"']*/gi)];
      expect(reads.length, `${file} should still read handover_packets`).toBeGreaterThan(0);
      for (const [read] of reads) {
        expect(
          /close_kind IS NULL/i.test(read),
          `${file} synthesizes from an unfiltered handover read: "${read.slice(0, 120)}". A backfilled spine would become material for a companion's state.`,
        ).toBe(true);
      }
    }
  });

  it("display surfaces stay unfiltered on purpose", async () => {
    for (const file of UNFILTERED_BY_DESIGN) {
      const src = await readSource(file);
      expect(
        /close_kind IS NULL/i.test(src),
        `${file} lists handovers for a human to look at -- hiding reconstructions there loses the history on purpose written down`,
      ).toBe(false);
    }
  });
});

describe("session provenance", () => {
  it("every session INSERT writes opened_by", async () => {
    for (const file of SESSION_INSERT_FILES) {
      const src = await readSource(file);
      const inserts = [...src.matchAll(/INSERT INTO sessions\s*\(([^)]*)\)/gi)];
      expect(inserts.length, `${file} should still contain a session INSERT`).toBeGreaterThan(0);
      for (const [, cols] of inserts) {
        expect(
          String(cols ?? "").replace(/\s+/g, " "),
          `a session INSERT in ${file} omits opened_by -- an unattributable session row is how 187 of them became unattributable`,
        ).toContain("opened_by");
      }
    }
  });

  it("every OPENED_BY tag is namespaced and non-empty", () => {
    for (const [key, tag] of Object.entries(OPENED_BY)) {
      expect(tag, `OPENED_BY.${key}`).toMatch(/^[a-z]+:[a-z_]+$/);
    }
  });

  it("the three insert sites use three distinct tags", () => {
    const tags = Object.values(OPENED_BY);
    expect(new Set(tags).size).toBe(tags.length);
  });
});

describe("session_open is lifecycle-only", () => {
  // Read-shaped phrases on a route that INSERTs a session row is how crons and mid-turn agent
  // calls opened lifecycle rows nobody would ever close.
  const READ_SHAPED = [
    "current state", "how am i", "what's my state", "where am i", "show my state", "check my state",
  ];

  it("no read-shaped phrase triggers session_open", () => {
    for (const phrase of READ_SHAPED) {
      expect(
        FAST_PATH_PATTERNS.session_open!.triggers,
        `"${phrase}" must not open a session`,
      ).not.toContain(phrase);
    }
  });

  it("those phrases route to triad_state_read instead of being dropped", () => {
    for (const phrase of READ_SHAPED) {
      expect(FAST_PATH_PATTERNS.triad_state_read!.triggers, `"${phrase}" lost its route`).toContain(phrase);
    }
  });

  it("triad_state_read reaches no tool that writes", () => {
    expect(FAST_PATH_PATTERNS.triad_state_read!.tools).toEqual(["triad_state_read"]);
  });

  // List membership is not routing: FAST_PATH_PATTERNS is scanned in key order and ANCHORED_GUARDS
  // run first, so the real router has to be asked.
  it("the real router sends each read-shaped phrase somewhere that does not open a session", () => {
    for (const phrase of READ_SHAPED) {
      const hit = matchFastPath(phrase);
      expect(hit, `"${phrase}" no longer matches any fast path`).not.toBeNull();
      expect(hit!.key, `"${phrase}" still routes to a session INSERT`).not.toBe("session_open");
      expect(hit!.entry.tools).not.toContain("halseth_session_load");
      expect(hit!.entry.tools).not.toContain("halseth_session_orient");
    }
  });

  it("the real router still opens a session for explicit lifecycle phrases", () => {
    for (const phrase of ["open my session", "start session"]) {
      expect(matchFastPath(phrase)?.key, phrase).toBe("session_open");
    }
  });

  it("session_open keeps its explicit lifecycle triggers", () => {
    for (const phrase of ["open my session", "open session", "new session", "start session"]) {
      expect(FAST_PATH_PATTERNS.session_open!.triggers).toContain(phrase);
    }
  });
});
