// Task 15 (2026-07-20): inter-companion notes become "moves" on shared objects.
// Migration 0104 added nullable ref_type/ref_id/reason to inter_companion_notes.
// This suite covers the write-layer threading: addCompanionNote's INSERT, the
// buildNoteRef validation helper (all-or-nothing + enum), the executor's context-only
// extraction (never the command string), and the existence guard (ref_id must exist
// in the table implied by ref_type before the note is written).

import { describe, it, expect } from "vitest";
import { addCompanionNote, buildNoteRef, NOTE_REF_TYPES } from "../librarian/backends/halseth.js";
import { execCompanionNoteAdd } from "../librarian/executors/writes.js";
import { getInterCompanionNoteMoves } from "../handlers/inter_companion_notes.js";
import type { Env } from "../types.js";

// ── fakeEnv: supports both .run() (INSERT) and .first() (existence-check SELECT) ──
interface Captured { sql: string; bound: unknown[] }
function fakeEnv(opts: { refFound?: boolean } = {}): { env: Env; calls: Captured[] } {
  const calls: Captured[] = [];
  const refFound = opts.refFound ?? true;
  const env = {
    DB: {
      prepare(sql: string) {
        return {
          bind(...bound: unknown[]) {
            return {
              async run() { calls.push({ sql, bound }); return { meta: { changes: 1 } }; },
              async first() {
                calls.push({ sql, bound });
                // Existence-check SELECT: return a truthy row iff the caller wants one.
                if (/^SELECT 1 FROM/i.test(sql)) return refFound ? { 1: 1 } : null;
                return null;
              },
            };
          },
        };
      },
    },
  } as unknown as Env;
  return { env, calls };
}

describe("buildNoteRef: all-or-nothing + enum validation from a parsed object only", () => {
  it("returns {} (plain note) when both ref_type and ref_id are absent", () => {
    expect(buildNoteRef(undefined, undefined, undefined)).toEqual({});
  });

  it("returns a valid ref when ref_type + ref_id are both present", () => {
    const r = buildNoteRef("tension", "t1", "this moves it");
    expect(r.error).toBeUndefined();
    expect(r.ref).toEqual({ ref_type: "tension", ref_id: "t1", reason: "this moves it" });
  });

  it("reason is optional", () => {
    const r = buildNoteRef("question", "q1", undefined);
    expect(r.error).toBeUndefined();
    expect(r.ref).toEqual({ ref_type: "question", ref_id: "q1", reason: undefined });
  });

  it("errors when ref_type is present without ref_id", () => {
    const r = buildNoteRef("tension", undefined, undefined);
    expect(r.error).toMatch(/must both be provided/i);
    expect(r.ref).toBeUndefined();
  });

  it("errors when ref_id is present without ref_type", () => {
    const r = buildNoteRef(undefined, "t1", undefined);
    expect(r.error).toMatch(/must both be provided/i);
  });

  it("errors on a bogus ref_type", () => {
    const r = buildNoteRef("bogus", "t1", undefined);
    expect(r.error).toMatch(/question\|tension\|council/);
  });

  it("NOTE_REF_TYPES matches the migration 0104 CHECK constraint", () => {
    expect(NOTE_REF_TYPES).toEqual(["question", "tension", "council"]);
  });
});

describe("addCompanionNote: INSERT binds ref_type/ref_id/reason", () => {
  it("plain note (no ref): INSERT binds NULLs for the three new columns (backward compatible)", async () => {
    const { env, calls } = fakeEnv();
    const res = await addCompanionNote(env, "cypher", "drevan", "hold the thread");
    expect(res.error).toBeUndefined();
    expect(calls).toHaveLength(1); // no existence-check call when there's no ref
    expect(calls[0]!.sql).toMatch(/INSERT INTO inter_companion_notes/i);
    expect(calls[0]!.sql).toMatch(/ref_type/);
    // bind order: id, from_id, to_id, content, ref_type, ref_id, reason
    expect(calls[0]!.bound[1]).toBe("cypher");
    expect(calls[0]!.bound[2]).toBe("drevan");
    expect(calls[0]!.bound[3]).toBe("hold the thread");
    expect(calls[0]!.bound[4]).toBeNull();
    expect(calls[0]!.bound[5]).toBeNull();
    expect(calls[0]!.bound[6]).toBeNull();
  });

  it("note with a valid ref: existence-check SELECT runs, then INSERT binds all three columns", async () => {
    const { env, calls } = fakeEnv({ refFound: true });
    const res = await addCompanionNote(env, "cypher", "drevan", "moving this along", {
      ref_type: "tension", ref_id: "t1", reason: "this moves it",
    });
    expect(res.error).toBeUndefined();
    expect(res.id).toBeTruthy();
    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toMatch(/SELECT 1 FROM companion_tensions WHERE id = \?/i);
    expect(calls[0]!.bound[0]).toBe("t1");
    expect(calls[1]!.sql).toMatch(/INSERT INTO inter_companion_notes/i);
    expect(calls[1]!.bound[4]).toBe("tension");
    expect(calls[1]!.bound[5]).toBe("t1");
    expect(calls[1]!.bound[6]).toBe("this moves it");
  });

  it("existence guard: ref_id not found -> error result, NO insert executed", async () => {
    const { env, calls } = fakeEnv({ refFound: false });
    const res = await addCompanionNote(env, "cypher", "drevan", "moving this along", {
      ref_type: "tension", ref_id: "does-not-exist",
    });
    expect(res.error).toMatch(/not found in companion_tensions/i);
    expect(calls).toHaveLength(1); // only the existence check, no INSERT
    expect(calls.some(c => /INSERT INTO/i.test(c.sql))).toBe(false);
  });

  it("routes ref_type=question to companion_questions and ref_type=council to council_questions", async () => {
    const q = fakeEnv({ refFound: true });
    await addCompanionNote(q.env, "gaia", "cypher", "x", { ref_type: "question", ref_id: "q1" });
    expect(q.calls[0]!.sql).toMatch(/companion_questions/i);

    const c = fakeEnv({ refFound: true });
    await addCompanionNote(c.env, "gaia", "cypher", "x", { ref_type: "council", ref_id: "c1" });
    expect(c.calls[0]!.sql).toMatch(/council_questions/i);
  });
});

describe("execCompanionNoteAdd: ref fields read ONLY from parsed context, never the command string", () => {
  it("context {to:drevan, content, ref_type:tension, ref_id:t1, reason} -> INSERT binds all three ref columns", async () => {
    const { env, calls } = fakeEnv({ refFound: true });
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "cypher",
        request: "note to drevan",
        context: JSON.stringify({ content: "moving this along", ref_type: "tension", ref_id: "t1", reason: "this moves it" }),
      },
    } as never);
    expect((res as Record<string, unknown>).ack).toBe(true);
    expect((res as Record<string, unknown>).delivered_to).toBe("drevan");
    const insert = calls.find(c => /INSERT INTO inter_companion_notes/i.test(c.sql))!;
    expect(insert.bound[2]).toBe("drevan");
    expect(insert.bound[3]).toBe("moving this along");
    expect(insert.bound[4]).toBe("tension");
    expect(insert.bound[5]).toBe("t1");
    expect(insert.bound[6]).toBe("this moves it");
  });

  it("plain note (no ref fields in context): INSERT binds NULLs -- byte-identical to pre-Task-15 behavior", async () => {
    const { env, calls } = fakeEnv();
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "cypher",
        request: "note to drevan",
        context: JSON.stringify({ content: "hold the thread" }),
      },
    } as never);
    expect((res as Record<string, unknown>).delivered_to).toBe("drevan");
    const insert = calls.find(c => /INSERT INTO inter_companion_notes/i.test(c.sql))!;
    expect(insert.bound[4]).toBeNull();
    expect(insert.bound[5]).toBeNull();
    expect(insert.bound[6]).toBeNull();
  });

  it("ref_type 'bogus' in context -> error result, no DB write at all", async () => {
    const { env, calls } = fakeEnv();
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "cypher",
        request: "note to drevan",
        context: JSON.stringify({ content: "x", ref_type: "bogus", ref_id: "t1" }),
      },
    } as never);
    expect((res as Record<string, unknown>).error).toBe("companion_note_add_failed");
    expect((res as Record<string, unknown>).reason).toMatch(/question\|tension\|council/);
    expect(calls).toHaveLength(0);
  });

  it("ref_type present without ref_id -> error result (all-or-nothing), no DB write", async () => {
    const { env, calls } = fakeEnv();
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "cypher",
        request: "note to drevan",
        context: JSON.stringify({ content: "x", ref_type: "tension" }),
      },
    } as never);
    expect((res as Record<string, unknown>).error).toBe("companion_note_add_failed");
    expect((res as Record<string, unknown>).reason).toMatch(/must both be provided/i);
    expect(calls).toHaveLength(0);
  });

  it("a ref_type mentioned only in the request STRING (not context) is never picked up", async () => {
    const { env, calls } = fakeEnv();
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "cypher",
        // The word "tension" appears in the request text, not in context -- must not
        // be interpreted as ref_type. (command-string-is-not-the-content)
        request: "note to drevan about the tension t1",
        context: JSON.stringify({ content: "moving this along" }),
      },
    } as never);
    expect((res as Record<string, unknown>).delivered_to).toBe("drevan");
    const insert = calls.find(c => /INSERT INTO inter_companion_notes/i.test(c.sql))!;
    expect(insert.bound[4]).toBeNull();
    expect(insert.bound[5]).toBeNull();
  });

  it("broadcast note with a valid ref: existence check runs, ref threaded through to_id=NULL insert", async () => {
    const { env, calls } = fakeEnv({ refFound: true });
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "gaia",
        request: "tell the triad",
        context: JSON.stringify({ content: "council item resolved", ref_type: "council", ref_id: "c1", reason: "closing the loop" }),
      },
    } as never);
    expect((res as Record<string, unknown>).delivered_to).toBe("triad");
    const insert = calls.find(c => /INSERT INTO inter_companion_notes/i.test(c.sql))!;
    expect(insert.bound[2]).toBeNull(); // to_id NULL = broadcast
    expect(insert.bound[4]).toBe("council");
    expect(insert.bound[5]).toBe("c1");
  });

  it("existence guard bubbles up through the executor as an error result, not a silent plain-note downgrade", async () => {
    const { env, calls } = fakeEnv({ refFound: false });
    const res = await execCompanionNoteAdd({
      env,
      req: {
        companion_id: "cypher",
        request: "note to drevan",
        context: JSON.stringify({ content: "moving this along", ref_type: "tension", ref_id: "does-not-exist" }),
      },
    } as never);
    expect((res as Record<string, unknown>).error).toBe("companion_note_add_failed");
    expect((res as Record<string, unknown>).reason).toMatch(/not found in companion_tensions/i);
    expect(calls.some(c => /INSERT INTO/i.test(c.sql))).toBe(false);
  });
});

// ── Task 16: GET /inter-companion-notes/moves ────────────────────────────────
// Measurability endpoint. A "move" is a note with ref_type set. moved% asks
// whether the ref'd object's state changed AFTER the move (note.created_at).
describe("getInterCompanionNoteMoves", () => {
  const ADMIN = "test-admin-secret";

  interface MoveRow {
    id: string; from_id: string; to_id: string | null;
    ref_type: string | null; ref_id: string | null; reason: string | null; created_at: string;
  }

  function fakeMovesEnv(opts: {
    totalNotes: number;
    movesRows: MoveRow[];
    questionRows?: Array<{ id: string; status: string; answered_at: string | null }>;
    tensionRows?: Array<{ id: string; status: string; last_surfaced_at: string | null }>;
    councilRows?: Array<{ id: string; status: string; closed_at: string | null }>;
  }): Env {
    return {
      ADMIN_SECRET: ADMIN,
      DB: {
        prepare(sql: string) {
          return {
            bind(..._bound: unknown[]) {
              return {
                async first() {
                  if (/SELECT COUNT\(\*\) AS n FROM inter_companion_notes/i.test(sql)) {
                    return { n: opts.totalNotes };
                  }
                  return null;
                },
                async all() {
                  if (/FROM inter_companion_notes\s+WHERE ref_type IS NOT NULL/i.test(sql)) {
                    return { results: opts.movesRows };
                  }
                  if (/FROM companion_questions WHERE id IN/i.test(sql)) {
                    return { results: opts.questionRows ?? [] };
                  }
                  if (/FROM companion_tensions WHERE id IN/i.test(sql)) {
                    return { results: opts.tensionRows ?? [] };
                  }
                  if (/FROM council_questions WHERE id IN/i.test(sql)) {
                    return { results: opts.councilRows ?? [] };
                  }
                  return { results: [] };
                },
              };
            },
          };
        },
      },
    } as unknown as Env;
  }

  function authedRequest(days?: number): Request {
    const url = days != null
      ? `https://x/inter-companion-notes/moves?days=${days}`
      : "https://x/inter-companion-notes/moves";
    return new Request(url, { headers: { Authorization: `Bearer ${ADMIN}` } });
  }

  it("denies unauthenticated requests", async () => {
    const env = fakeMovesEnv({ totalNotes: 0, movesRows: [] });
    const res = await getInterCompanionNoteMoves(new Request("https://x/inter-companion-notes/moves"), env);
    expect(res.status).toBe(401);
  });

  it("one moved question-move, one unmoved tension-move, one plain note: moves=2, moved=1, plain note excluded from items", async () => {
    const noteCreatedAt = "2026-07-01T00:00:00.000Z";
    const env = fakeMovesEnv({
      totalNotes: 3, // 2 moves + 1 plain note in the window
      movesRows: [
        { id: "n1", from_id: "cypher", to_id: "drevan", ref_type: "question", ref_id: "q1", reason: "asked", created_at: noteCreatedAt },
        { id: "n2", from_id: "gaia", to_id: "cypher", ref_type: "tension", ref_id: "t1", reason: "flagged", created_at: noteCreatedAt },
      ],
      questionRows: [{ id: "q1", status: "answered", answered_at: "2026-07-02T00:00:00.000Z" }], // after note -> moved
      tensionRows: [{ id: "t1", status: "simmering", last_surfaced_at: null }], // unchanged -> not moved
    });

    const res = await getInterCompanionNoteMoves(authedRequest(30), env);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.window_days).toBe(30);
    expect(body.total_notes).toBe(3);
    expect(body.moves).toBe(2);
    expect(body.moved).toBe(1);
    expect(body.moved_pct).toBe(50);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items).toHaveLength(2); // plain note never entered movesRows -> excluded
    const q = items.find(i => i.ref_id === "q1")!;
    expect(q.state_changed_after_note).toBe(true);
    expect(q.object_state).toBe("answered");
    const t = items.find(i => i.ref_id === "t1")!;
    expect(t.state_changed_after_note).toBe(false);
    expect(t.object_state).toBe("simmering");
  });

  it("zero moves in the window: moved_pct is 0, not NaN/Infinity (no div-by-zero)", async () => {
    const env = fakeMovesEnv({ totalNotes: 0, movesRows: [] });
    const res = await getInterCompanionNoteMoves(authedRequest(), env);
    const body = await res.json() as Record<string, unknown>;
    expect(body.moves).toBe(0);
    expect(body.moved).toBe(0);
    expect(body.moved_pct).toBe(0);
    expect(body.items).toEqual([]);
  });

  it("tension moved via last_surfaced_at bump alone (status unchanged) -- the documented approximation", async () => {
    const noteCreatedAt = "2026-07-01T00:00:00.000Z";
    const env = fakeMovesEnv({
      totalNotes: 1,
      movesRows: [
        { id: "n1", from_id: "cypher", to_id: "drevan", ref_type: "tension", ref_id: "t2", reason: null, created_at: noteCreatedAt },
      ],
      tensionRows: [{ id: "t2", status: "simmering", last_surfaced_at: "2026-07-05T00:00:00.000Z" }],
    });
    const res = await getInterCompanionNoteMoves(authedRequest(), env);
    const body = await res.json() as Record<string, unknown>;
    expect(body.moved).toBe(1);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]!.state_changed_after_note).toBe(true);
  });

  it("council move: status='closed' AND closed_at > note.created_at required", async () => {
    const noteCreatedAt = "2026-07-01T00:00:00.000Z";
    const env = fakeMovesEnv({
      totalNotes: 1,
      movesRows: [
        { id: "n1", from_id: "cypher", to_id: null, ref_type: "council", ref_id: "c1", reason: null, created_at: noteCreatedAt },
      ],
      councilRows: [{ id: "c1", status: "closed", closed_at: "2026-06-30T00:00:00.000Z" }], // closed BEFORE note -> not moved
    });
    const res = await getInterCompanionNoteMoves(authedRequest(), env);
    const body = await res.json() as Record<string, unknown>;
    expect(body.moved).toBe(0);
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]!.state_changed_after_note).toBe(false);
    expect(items[0]!.object_state).toBe("closed");
  });

  it("days param defaults to 30 and clamps out-of-range values", async () => {
    const env = fakeMovesEnv({ totalNotes: 0, movesRows: [] });
    const resDefault = await getInterCompanionNoteMoves(authedRequest(), env);
    expect((await resDefault.json() as Record<string, unknown>).window_days).toBe(30);

    const resTooHigh = await getInterCompanionNoteMoves(authedRequest(99999), env);
    expect((await resTooHigh.json() as Record<string, unknown>).window_days).toBe(365);

    // 0 (and any non-positive value) falls back to the default, matching the
    // `parseInt(...) || default` convention used by the sibling days-windowed
    // handlers in this file (self-monitoring.ts, sessions.ts) -- not clamped to 1.
    const resZero = await getInterCompanionNoteMoves(authedRequest(0), env);
    expect((await resZero.json() as Record<string, unknown>).window_days).toBe(30);

    const resGarbage = await getInterCompanionNoteMoves(
      new Request("https://x/inter-companion-notes/moves?days=abc", { headers: { Authorization: `Bearer ${ADMIN}` } }),
      env,
    );
    expect((await resGarbage.json() as Record<string, unknown>).window_days).toBe(30);
  });

  it("ref'd object not found (deleted after the note referenced it): object_state null, not moved", async () => {
    const noteCreatedAt = "2026-07-01T00:00:00.000Z";
    const env = fakeMovesEnv({
      totalNotes: 1,
      movesRows: [
        { id: "n1", from_id: "cypher", to_id: "drevan", ref_type: "question", ref_id: "gone", reason: null, created_at: noteCreatedAt },
      ],
      questionRows: [], // ref_id not found
    });
    const res = await getInterCompanionNoteMoves(authedRequest(), env);
    const body = await res.json() as Record<string, unknown>;
    const items = body.items as Array<Record<string, unknown>>;
    expect(items[0]!.object_state).toBeNull();
    expect(items[0]!.state_changed_after_note).toBe(false);
  });
});
