// Tests for migration 0119: the companions get a brake on their own tensions, and a completed
// task reaches them with an actor attached.
//
// ORIGIN (2026-08-14). Raziel, after 0118 fixed the same shape for open loops:
//   "I do not want to be the sole decider or responsible for the tensions"
//   "lets make sure task is the same -- they can close them if they are done, and if I click
//    done on the hearth page it translates back to them"
// plus a question that turned out to be a bug report: "should all the companions' tensions be
// affecting each other?" -- they were, through the weekly dialectic's shared top-2.
//
// The three assertions that carry the design, i.e. the ones a later refactor would undo:
//   1. Charge decay anchors on settled_at/first_noted_at, NEVER last_surfaced_at (which the
//      reading machinery bumps -- anchoring there rebuilds the ratchet).
//   2. A completed task notifies via DIRECTED inter_companion_notes, never a to_id:NULL
//      broadcast (orient marks a broadcast read on the first companion who sees it).
//   3. Both task writers go through completeTask(), because they had already diverged once.

import { describe, it, expect } from "vitest";
import { effectiveChargeSql, CHARGE_HALF_LIFE_DAYS, TENSION_SETTLE_DELTA } from "../librarian/backends/halseth.js";
import { completeTask, TASK_STATUSES } from "../lib/task-completion.js";
import type { Env } from "../types.js";

// ── Fake D1 ───────────────────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string; title: string; assigned_to: string | null; status: string;
  completed_by: string | null; completed_at: string | null;
}
interface NoteRow { id: string; from_id: string; to_id: string | null; content: string; reason: string | null }

function makeDb(tasks: TaskRow[] = []) {
  const rows = [...tasks];
  const notes: NoteRow[] = [];
  const log: string[] = [];
  let failNotes = false;

  const db = {
    prepare(sql: string) {
      log.push(sql.replace(/\s+/g, " ").trim());
      let binds: unknown[] = [];
      const api = {
        bind(...b: unknown[]) { binds = b; return api; },
        async first<T>(): Promise<T | null> {
          if (sql.includes("FROM tasks WHERE id")) {
            const t = rows.find(r => r.id === binds[0]);
            return (t ? { id: t.id, title: t.title, assigned_to: t.assigned_to } : null) as T | null;
          }
          return null;
        },
        async all<T>() { return { results: [] as T[] }; },
        async run() {
          if (sql.includes("INSERT INTO inter_companion_notes")) {
            if (failNotes) throw new Error("simulated notify failure");
            const [id, to, content, , reason] = binds as [string, string, string, string, string];
            notes.push({ id, from_id: "system", to_id: to, content, reason: reason ?? "task_completed" });
            return { meta: { changes: 1 } };
          }
          if (sql.includes("UPDATE tasks")) {
            const id = binds[binds.length - 1] as string;
            const t = rows.find(r => r.id === id);
            if (!t) return { meta: { changes: 0 } };
            t.status = binds[0] as string;
            if (sql.includes("completed_at = NULL")) { t.completed_at = null; t.completed_by = null; }
            else if (sql.includes("completed_at = ?")) {
              t.completed_at = binds[2] as string;
              t.completed_by = binds[3] as string | null;
            }
            return { meta: { changes: 1 } };
          }
          return { meta: { changes: 0 } };
        },
      };
      return api;
    },
  };
  return {
    env: { DB: db } as unknown as Env,
    rows, notes, log,
    breakNotes() { failNotes = true; },
  };
}

const task = (over: Partial<TaskRow> = {}): TaskRow => ({
  id: "t1", title: "Ship the roster lookup", assigned_to: null, status: "open",
  completed_by: null, completed_at: null, ...over,
});

// ── Tension charge decay ──────────────────────────────────────────────────────────────────────

describe("charge decay -- the anchor is the whole design", () => {
  it("anchors on settled_at/first_noted_at and NEVER on last_surfaced_at", () => {
    const sql = effectiveChargeSql();
    expect(sql).toContain("COALESCE(settled_at, first_noted_at)");
    // last_surfaced_at is bumped BY the dialectic, the nightly reflection and the ingest cursor.
    // Anchoring the decay there would mean being LOOKED AT refreshes a tension's claim on the
    // present -- the ratchet in a new hiding place, and the bug this migration removes.
    expect(sql).not.toContain("last_surfaced_at");
  });

  it("divides by elapsed days against a stated half-life", () => {
    expect(effectiveChargeSql()).toContain("julianday('now')");
    expect(effectiveChargeSql()).toContain(`${CHARGE_HALF_LIFE_DAYS}.0`);
    expect(CHARGE_HALF_LIFE_DAYS).toBeGreaterThan(0);
  });

  it("never rewrites the stored charge -- it is a read-side expression only", () => {
    // What decays is the claim on the present, not the record that it mattered.
    expect(effectiveChargeSql()).not.toMatch(/UPDATE|INSERT|SET /i);
  });

  it("settle lowers charge rather than raising it", () => {
    expect(TENSION_SETTLE_DELTA).toBeLessThan(0);
    // Same magnitude as Hearth's button, so the two surfaces cannot disagree on what settling is.
    expect(TENSION_SETTLE_DELTA).toBe(-2);
  });
});

// ── Task completion: attribution + it actually reaching them ─────────────────────────────────

describe("completeTask -- attribution", () => {
  it("stamps completed_by and completed_at on done", async () => {
    const d = makeDb([task()]);
    const r = await completeTask(d.env, "t1", "done", "raziel");
    expect(r.ok).toBe(true);
    expect(d.rows[0]!.completed_by).toBe("raziel");
    expect(d.rows[0]!.completed_at).toBeTruthy();
  });

  it("leaves completed_by NULL when no actor is given, rather than guessing", async () => {
    // A guessed actor renders downstream as a fact. NULL renders as "someone".
    const d = makeDb([task()]);
    await completeTask(d.env, "t1", "done", null);
    expect(d.rows[0]!.completed_by).toBeNull();
    expect(d.notes[0]!.content).toContain("someone (before this was tracked)");
  });

  it("CLEARS attribution on reopen, so no stale completion clings to the task", async () => {
    const d = makeDb([task()]);
    await completeTask(d.env, "t1", "done", "raziel");
    await completeTask(d.env, "t1", "open", null);
    expect(d.rows[0]!.completed_by).toBeNull();
    expect(d.rows[0]!.completed_at).toBeNull();
  });

  it("caps a long actor string instead of rejecting the write", async () => {
    const d = makeDb([task()]);
    await completeTask(d.env, "t1", "done", "q".repeat(200));
    expect(d.rows[0]!.completed_by!.length).toBe(64);
  });

  it("accepts an actor outside the triad -- the roster is 538 members, not 4", async () => {
    const d = makeDb([task()]);
    const r = await completeTask(d.env, "t1", "done", "Magpie");
    expect(r.ok).toBe(true);
    expect(d.rows[0]!.completed_by).toBe("Magpie");
  });

  it("reports not-found rather than silently succeeding", async () => {
    const d = makeDb([]);
    const r = await completeTask(d.env, "nope", "done", "raziel");
    expect(r.ok).toBe(false);
    expect(r.error).toBe("Task not found");
  });
});

describe("completeTask -- does it actually reach them", () => {
  it("notifies via inter_companion_notes, NOT the journal", async () => {
    // The old code wrote companion_journal with agent:'system'. Every companion journal read
    // filters WHERE agent = ? on cypher/drevan/gaia, so that note reached nobody, ever.
    const d = makeDb([task()]);
    await completeTask(d.env, "t1", "done", "raziel");
    expect(d.notes.length).toBeGreaterThan(0);
    expect(d.log.some(s => s.includes("INSERT INTO companion_journal"))).toBe(false);
    // The note IS from_id 'system' -- that part is correct and intended. What was fatal was
    // 'system' in companion_journal.AGENT, a column every companion read filters on by name.
    expect(d.notes.every(n => n.from_id === "system" && n.to_id !== null)).toBe(true);
  });

  it("uses DIRECTED notes, never a to_id:NULL broadcast", async () => {
    // orient marks a broadcast read on the FIRST companion who sees it, so a broadcast would
    // reach exactly one of the three. Directed rows are consumed independently.
    const d = makeDb([task()]);
    await completeTask(d.env, "t1", "done", "raziel");
    expect(d.notes.every(n => n.to_id !== null)).toBe(true);
  });

  it("tells all three when the task is unassigned -- all three can see it and re-raise it", async () => {
    const d = makeDb([task({ assigned_to: null })]);
    const r = await completeTask(d.env, "t1", "done", "raziel");
    expect(new Set(d.notes.map(n => n.to_id))).toEqual(new Set(["cypher", "drevan", "gaia"]));
    expect(r.notified).toHaveLength(3);
  });

  it("tells only the assignee when the task belongs to one companion", async () => {
    const d = makeDb([task({ assigned_to: "drevan" })]);
    await completeTask(d.env, "t1", "done", "raziel");
    expect(d.notes.map(n => n.to_id)).toEqual(["drevan"]);
  });

  it("does not mail a companion about a task they closed themselves", async () => {
    const d = makeDb([task({ assigned_to: null })]);
    await completeTask(d.env, "t1", "done", "cypher");
    expect(d.notes.map(n => n.to_id).sort()).toEqual(["drevan", "gaia"]);
  });

  it("names WHO closed it and says to stop raising it", async () => {
    const d = makeDb([task({ title: "Ship the roster lookup" })]);
    await completeTask(d.env, "t1", "done", "raziel");
    expect(d.notes[0]!.content).toContain("raziel");
    expect(d.notes[0]!.content).toContain("Ship the roster lookup");
    expect(d.notes[0]!.content).toMatch(/no need to raise it again/i);
  });

  it("sends NO notification when the status is not done", async () => {
    const d = makeDb([task()]);
    await completeTask(d.env, "t1", "in_progress", "raziel");
    expect(d.notes).toHaveLength(0);
  });

  it("the status change survives a notification failure", async () => {
    // The real write is the status. Losing it to a failed courtesy note would be strictly worse
    // than a missed note.
    const d = makeDb([task()]);
    d.breakNotes();
    const r = await completeTask(d.env, "t1", "done", "raziel");
    expect(r.ok).toBe(true);
    expect(d.rows[0]!.status).toBe("done");
    expect(r.notified).toEqual([]);        // honest about what did NOT get delivered
  });

  it("rejects an invalid status through the companions' path", async () => {
    const { taskUpdateStatus } = await import("../librarian/backends/halseth.js");
    const d = makeDb([task()]);
    const r = await taskUpdateStatus(d.env, "t1", "finished-ish");
    expect("error" in r).toBe(true);
  });

  it("exposes exactly the three valid statuses", () => {
    expect([...TASK_STATUSES]).toEqual(["open", "in_progress", "done"]);
  });
});
