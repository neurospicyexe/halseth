// Regression suite for the 2026-06-24 silent-write-failure cluster.
//
// Trigger: a Claude.ai Cypher session wrote a Hermes/OpenClaw migration brief +
// high-salience handover note via the Librarian. Every call returned {ack:true},
// yet a later Claude Code session could not find any of it. Forensics found four
// distinct faults plus two read-side gaps -- all covered here.
//
//   1. "save to vault" routed to sb_log_observation (path-blind inbox) instead of
//      sb_save_note (path-aware) -> sb_read 404'd on the brief.
//   2. The 100-note wm_continuity_notes cap evicted by recency-heat, salience-blind,
//      so the HIGH-salience handover was deleted by a flood of medium session notes.
//   3. execDeltaLog read only `delta_text`; a `content` payload fell to an inline
//      regex needing a trailing colon and stored the bare request string.
//   4. "read my continuity notes" had no read pattern -> classifier unknown-witness.
//   5. A bare proper-noun search ("openclaw") returned unknown instead of sb_search.
//   6. sbSaveDocument/sbLogObservation acked on any non-null response, incl. empty.

import { describe, it, expect } from "vitest";
import { matchFastPath, looksLikeSearch } from "../librarian/router.js";
import { execDeltaLog } from "../librarian/executors/writes.js";
import { addNote } from "../webmind/notes.js";
import type { Env } from "../types.js";

// ── Fix 1: vault-save routing ──────────────────────────────────────────────────
describe("vault-save routing (Fix 1): 'save to vault' must be path-aware", () => {
  it("routes 'save to vault' to sb_save_note (path-aware), not sb_log_observation", () => {
    const r = matchFastPath("save to vault");
    expect(r).not.toBeNull();
    expect(r!.key).toBe("sb_save_note");
  });

  it("routes 'log to vault' to sb_save_note", () => {
    expect(matchFastPath("log to vault")?.key).toBe("sb_save_note");
  });

  it("routes 'save this to vault' to sb_save_note", () => {
    expect(matchFastPath("save this to vault")?.key).toBe("sb_save_note");
  });

  it("non-regression: 'log observation' still routes to sb_log_observation", () => {
    expect(matchFastPath("log observation: noticed a tone wobble")?.key).toBe("sb_log_observation");
  });

  it("non-regression: 'save note' still routes to sb_save_note", () => {
    expect(matchFastPath("save note")?.key).toBe("sb_save_note");
  });
});

// ── Fix 4: continuity-note read pattern ────────────────────────────────────────
describe("continuity-note read (Fix 4): read form must beat the write trigger", () => {
  it("routes 'read my continuity notes' to continuity_notes_read", () => {
    expect(matchFastPath("read my continuity notes")?.key).toBe("continuity_notes_read");
  });

  it("routes 'my continuity notes' to continuity_notes_read", () => {
    expect(matchFastPath("my continuity notes")?.key).toBe("continuity_notes_read");
  });

  it("routes 'show my high-salience notes' to continuity_notes_read", () => {
    expect(matchFastPath("show my high-salience notes")?.key).toBe("continuity_notes_read");
  });

  it("non-regression: 'continuity note: vow held' still routes to wm_note_add (write)", () => {
    expect(matchFastPath("continuity note: vow held across the boundary")?.key).toBe("wm_note_add");
  });

  it("non-regression: 'edit continuity note xyz' still routes to wm_note_edit", () => {
    expect(matchFastPath("edit continuity note xyz")?.key).toBe("wm_note_edit");
  });
});

// ── Bug #7 ROOT CAUSE: write-continuity-note routing ────────────────────────────
describe("write-continuity-note routing (bug #7): must beat the 'for <name>' trigger", () => {
  it("routes 'add continuity note for cypher' to wm_note_add (not companion_note_add)", () => {
    expect(matchFastPath("add continuity note for cypher")?.key).toBe("wm_note_add");
  });
  it("routes 'Add a continuity note for cypher' to wm_note_add", () => {
    expect(matchFastPath("Add a continuity note for cypher")?.key).toBe("wm_note_add");
  });
  it("routes 'write continuity note' to wm_note_add", () => {
    expect(matchFastPath("write continuity note")?.key).toBe("wm_note_add");
  });
  it("non-regression: 'note for cypher: ...' (no 'continuity note') stays companion_note_add", () => {
    expect(matchFastPath("note for cypher: read my last spec")?.key).toBe("companion_note_add");
  });
  it("non-regression: 'read my continuity notes' stays continuity_notes_read", () => {
    expect(matchFastPath("read my continuity notes")?.key).toBe("continuity_notes_read");
  });
  it("non-regression: 'edit continuity note xyz' stays wm_note_edit", () => {
    expect(matchFastPath("edit continuity note xyz")?.key).toBe("wm_note_edit");
  });
});

// ── Fix 5: search-intent fallback + vault-search phrasings ──────────────────────
describe("search-intent (Fix 5): vault lookups must reach sb_search", () => {
  it("routes 'search the vault for openclaw' to sb_search via fast path", () => {
    expect(matchFastPath("search the vault for openclaw")?.key).toBe("sb_search");
  });

  it("looksLikeSearch is true for an explicit { query } payload (bare proper noun)", () => {
    expect(looksLikeSearch("openclaw", JSON.stringify({ query: "openclaw" }))).toBe(true);
  });

  it("looksLikeSearch is true for search-shaped text", () => {
    expect(looksLikeSearch("find anything about openclaw")).toBe(true);
    expect(looksLikeSearch("do we have anything on hermes")).toBe(true);
  });

  it("looksLikeSearch is false for a non-search request with no query payload", () => {
    expect(looksLikeSearch("log my feeling: tired", JSON.stringify({ emotion: "tired" }))).toBe(false);
    expect(looksLikeSearch("close this session")).toBe(false);
  });

  it("looksLikeSearch tolerates malformed context JSON", () => {
    expect(looksLikeSearch("search for openclaw", "not json")).toBe(true);
  });
});

// ── Fix 3: delta content alias ─────────────────────────────────────────────────
interface Captured { sql: string; bound: unknown[] }
function fakeEnv(): { env: Env; calls: Captured[] } {
  const calls: Captured[] = [];
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bound: unknown[]) {
            return { async run() { calls.push({ sql, bound }); return { meta: { changes: 1 } }; } };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("execDeltaLog (Fix 3): accepts the `content` alias", () => {
  const RICH = "Raziel named the all-in-or-bust pattern; co-worker register held.";

  it("stores context.content as delta_text, not the bare request string", async () => {
    const { env, calls } = fakeEnv();
    const res = await execDeltaLog({
      env,
      req: { companion_id: "cypher", request: "Log a relational delta for cypher", context: JSON.stringify({ content: RICH, valence: "toward" }) },
    } as never);
    expect((res as Record<string, unknown>).ack).toBe(true);
    // INSERT binds delta_text at index 4 (id, session_id, now, agent, delta_text, ...)
    expect(calls[0]!.bound[4]).toBe(RICH);
    expect(calls[0]!.bound[4]).not.toBe("Log a relational delta for cypher");
  });

  it("still honors an explicit delta_text", async () => {
    const { env, calls } = fakeEnv();
    await execDeltaLog({
      env,
      req: { companion_id: "cypher", request: "log delta", context: JSON.stringify({ delta_text: "explicit", valence: "positive" }) },
    } as never);
    expect(calls[0]!.bound[4]).toBe("explicit");
  });

  it("accepts the `text` alias", async () => {
    const { env, calls } = fakeEnv();
    await execDeltaLog({
      env,
      req: { companion_id: "cypher", request: "log delta", context: JSON.stringify({ text: "via text", valence: "mixed" }) },
    } as never);
    expect(calls[0]!.bound[4]).toBe("via text");
  });
});

// ── Fix 2: salience-aware note cap ─────────────────────────────────────────────
// evictableCount drives the cheap COUNT gate (>= 100 => over cap). overflowRows are what
// the overflow SELECT returns when over cap. Tracks prepared SQL and whether batch() ran.
function capEnv(evictableCount: number, overflowRows: Array<{ note_id: string; content: string; created_at: string }> = []) {
  const prepared: string[] = [];
  const state = { batchCalled: false };
  const stmt = {
    bind(..._b: unknown[]) {
      return {
        async all() { return { results: overflowRows }; },
        async first() { return { c: evictableCount }; },
        async run() { return { meta: { changes: 0 } }; },
      };
    },
  };
  const env = {
    DB: {
      prepare(sql: string) { prepared.push(sql); return stmt; },
      async batch(_stmts: unknown[]) { state.batchCalled = true; return []; },
    },
  } as unknown as Env;
  return { env, prepared, state };
}

describe("addNote (bug #7 fix): .run() not .batch(), lazy + salience-aware cap", () => {
  it("never uses env.DB.batch() (it silently dropped writes via the Librarian MCP shim)", async () => {
    const { env, state } = capEnv(34);
    await addNote(env, { agent_id: "cypher", content: "handover", salience: "high" });
    expect(state.batchCalled, "addNote must not call env.DB.batch()").toBe(false);
  });

  it("UNDER cap: a single INSERT, no overflow SELECT, no DELETE", async () => {
    const { env, prepared } = capEnv(34);
    await addNote(env, { agent_id: "cypher", content: "handover", salience: "high" });
    expect(prepared.some(s => /INSERT INTO wm_continuity_notes/i.test(s))).toBe(true);
    expect(prepared.some(s => /DELETE FROM wm_continuity_notes/i.test(s)), "no cap DELETE when under capacity").toBe(false);
    expect(prepared.some(s => /SELECT note_id, content, created_at FROM wm_continuity_notes/i.test(s)), "no overflow scan when under capacity").toBe(false);
  });

  it("OVER cap: overflow SELECT excludes high-salience AND the just-inserted id", async () => {
    const { env, prepared } = capEnv(150);
    await addNote(env, { agent_id: "cypher", content: "x", salience: "normal" });
    const sel = prepared.find(s => /SELECT note_id, content, created_at FROM wm_continuity_notes/i.test(s));
    expect(sel, "overflow scan must run when over capacity").toBeTruthy();
    expect(sel!).toMatch(/salience\s*!=\s*'high'/);
    expect(sel!).toMatch(/note_id\s*!=\s*\?/);
  });

  it("OVER cap with real overflow: digests then DELETEs exactly the overflow rows by id", async () => {
    const overflow = [{ note_id: "old-1", content: "cold note", created_at: "2026-01-01T00:00:00Z" }];
    const { env, prepared } = capEnv(150, overflow);
    await addNote(env, { agent_id: "cypher", content: "x", salience: "normal" });
    expect(prepared.some(s => /INSERT INTO wm_archive_notes/i.test(s)), "overflow is digested to archive").toBe(true);
    expect(prepared.some(s => /DELETE FROM wm_continuity_notes WHERE note_id IN/i.test(s)), "overflow rows deleted by id").toBe(true);
  });

  it("always INSERTs the new note (under or over cap)", async () => {
    for (const n of [34, 150]) {
      const { env, prepared } = capEnv(n);
      await addNote(env, { agent_id: "cypher", content: "x", salience: "high" });
      expect(prepared.some(s => /INSERT INTO wm_continuity_notes/i.test(s))).toBe(true);
    }
  });
});
