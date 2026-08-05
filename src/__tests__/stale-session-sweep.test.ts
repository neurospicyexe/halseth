// The stale-session sweep must be structurally incapable of making things up.
//
// The history that makes this non-negotiable: an earlier automatic logger inferred sentiment and
// recorded a warm, good interaction with Drevan as a NEGATIVE one. An interpretation nobody asked
// for can always be wrong, and once written it gets read as fact. So the sweep counts rows and
// reports the count -- and these tests pin that, at the level of "no model can be reached from this
// file" rather than "the prompt is careful".

import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  composeAutoCloseSpine, SWEEP_CLOSE_KIND, SWEEP_GATE_KEY, SWEEP_GATE_COMPANION_ID,
  SWEEP_IDLE_HOURS, SWEEP_BATCH,
} from "../webmind/stale-session-sweep.js";
import { SUPERSEDABLE_CLOSE_KINDS } from "../db/queries.js";
import { PRUNE_GATE_KEY } from "../webmind/salience-prune.js";

const SRC = "src/webmind/stale-session-sweep.ts";
const read = () => readFile(resolve(SRC), "utf8");
/** Code only. The file's own header discusses inference at length; the ban is on reaching it. */
const readCode = async () => (await read()).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const row = (over: Partial<Parameters<typeof composeAutoCloseSpine>[0]> = {}) => ({
  id: "s1", companion_id: "drevan", session_type: "companion-work",
  created_at: "2026-08-01T00:00:00.000Z", surface: null, opened_by: null,
  notes: null, key_signature: null, ...over,
});
const NOW = Date.parse("2026-08-03T12:00:00.000Z");

describe("the sweep cannot infer", () => {
  it("reaches no inference module at all -- no model client, no synthesis enqueue", async () => {
    const src = await readCode();
    for (const forbidden of [
      "inference", "generate(", "DEEPSEEK", "deepseek", "enqueueSessionSummary",
      "enqueueDrevanState", "enqueueSomaticSnapshot", "promptWith", "AI.run", "env.AI",
    ]) {
      expect(src, `${SRC} must not reference ${forbidden}: a counter that can call a model is a narrator`).not.toContain(forbidden);
    }
  });

  it("writes no felt-state table", async () => {
    const src = await readCode();
    for (const table of ["feelings", "companion_state", "somatic_snapshot", "limbic_states", "emotional_frequency", "emotional_register"]) {
      expect(src.includes(`INTO ${table}`) || src.includes(`UPDATE ${table}`), `${SRC} must never write ${table}`).toBe(false);
    }
  });

  it("only ever writes motion_state 'floating'", async () => {
    const src = await readCode();
    expect(src, "the sweep writes a motion_state literal").toContain("'floating'");
    for (const claim of ["'in_motion'", "'at_rest'"]) {
      expect(src, `${SRC} must never write ${claim} -- that is a reading of how a thread ended, and an unclosed session only definitionally floated`).not.toContain(claim);
    }
  });

  it("counts with COUNT(*) only -- it never selects the CONTENT of a companion's writes", async () => {
    const src = await read();
    const evidenceBlock = src.slice(src.indexOf("EVIDENCE_COUNTS"), src.indexOf("interface StaleRow"));
    const selects = [...evidenceBlock.matchAll(/SELECT ([^\n]+?) FROM/g)].map(m => m[1]!.trim());
    expect(selects.length).toBeGreaterThan(3);
    for (const sel of selects) {
      expect(sel, `evidence probe selects "${sel}" -- a probe that reads text can quote it, and quoting slides into summarizing`).toBe("count(*) AS n");
    }
  });
});

describe("what the close actually says", () => {
  it("names the count, and says outright that nothing was interpreted", () => {
    const { spine, last_real_thing } = composeAutoCloseSpine(
      row(), [{ label: "journal entries", n: 2 }, { label: "questions asked", n: 1 }], NOW,
    );
    expect(spine).toContain("2 journal entries");
    expect(spine).toContain("1 questions asked");
    expect(spine).toContain("does not summarize, rank, or interpret");
    expect(spine).toContain("no valence");
    expect(spine).toContain("An authored close supersedes this one");
    expect(spine).toContain("60 hours");           // 2026-08-01T00:00 -> 2026-08-03T12:00
    expect(last_real_thing).toContain("Unknown");  // never guessed
  });

  it("says nothing happened when nothing did, without dressing it up", () => {
    const { spine, last_real_thing } = composeAutoCloseSpine(row(), [], NOW);
    expect(spine).toContain("No companion-authored write of any kind falls in its window");
    expect(last_real_thing).toBe("Nothing recorded. The session was opened and nothing was written against it.");
  });

  it("repeats what was stated at open verbatim, and labels it as not interpreted", () => {
    const { spine } = composeAutoCloseSpine(row({ notes: "Praxis house. MCP suite review." }), [], NOW);
    expect(spine).toContain("Stated at open, and not interpreted here: Praxis house. MCP suite review.");
  });

  it("names the caller when provenance exists", () => {
    const withCaller = composeAutoCloseSpine(row({ opened_by: "librarian:session_orient", surface: "claude-ai:x" }), [], NOW).spine;
    expect(withCaller).toContain("opened by librarian:session_orient");
    expect(withCaller).toContain("from claude-ai:x");
    expect(composeAutoCloseSpine(row(), [], NOW).spine).toContain("recorded no provenance");
  });
});

describe("safety rails", () => {
  it("its close_kind is supersedable, so a real close always wins", () => {
    expect(SUPERSEDABLE_CLOSE_KINDS as readonly string[]).toContain(SWEEP_CLOSE_KIND);
  });

  it("a hand-authored reconstruction is NOT supersedable -- it holds content", () => {
    expect(SUPERSEDABLE_CLOSE_KINDS as readonly string[]).not.toContain("reconstructed");
  });

  it("both close writers check precedence, not just a bare handover_id", async () => {
    for (const file of ["src/mcp/tools/session.ts", "src/librarian/backends/halseth.ts"]) {
      const src = await readFile(resolve(file), "utf8");
      expect(src, `${file} must use findExistingClose -- a second writer with the old check reintroduces the discard`).toContain("findExistingClose");
      expect(src).toContain("clearSupersededClose");
    }
  });

  it("its gate key belongs to no other job", () => {
    expect(SWEEP_GATE_KEY).not.toBe(PRUNE_GATE_KEY);
    expect(SWEEP_GATE_COMPANION_ID).toBe("_system");
  });

  it("only touches sessions still open, and backdates instead of stamping now()", async () => {
    const src = await read();
    expect(src).toContain("WHERE NOT EXISTS (SELECT 1 FROM handover_packets WHERE session_id = ?)");
    expect(src).toContain("AND handover_id IS NULL");
    expect(src).not.toMatch(/createdAt = new Date\(\)\.toISOString\(\)/);
  });

  it("waits long enough that a session in progress is never swept", () => {
    expect(SWEEP_IDLE_HOURS).toBeGreaterThanOrEqual(48);
    expect(SWEEP_BATCH).toBeLessThanOrEqual(100);
  });
});
