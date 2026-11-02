// Task field edits (2026-10-19). Until this file a task could only change STATUS: the Librarian's
// task_update_status acked and dropped due_at, Hearth's PATCH /tasks/:id validated status alone, and a
// free-form "update the task" fell through to task_add. Found 10-14: Vireth and the evac deck still
// showed 9/30 and the exit doc 10/15 after Raziel moved them in a Claude.ai conversation.
//
// One writer for field edits, shared by both callers (the Librarian executor and the HTTP PATCH), so
// they cannot diverge the way the status writers once did. Status still goes through completeTask().

import type { Env } from "../types.js";

export const TASK_PRIORITIES = ["low", "normal", "high", "urgent"] as const;

/** The fields a task edit may change. `null` clears an optional field; `undefined` leaves it alone. */
export interface TaskFieldEdits {
  title?: string;
  description?: string | null;
  priority?: string;
  due_at?: string | null;
  assigned_to?: string | null;
}

type Normalized = { sets: string[]; binds: unknown[]; changed: string[] };

/**
 * Validate and normalize an edit into SET clauses. Column names are literals here, never input.
 * Returns an error string for an invalid value rather than silently dropping it: a dropped field
 * that still answers ack is the exact bug this replaces. Pure -- exported for tests.
 */
export function normalizeTaskEdits(e: TaskFieldEdits): Normalized | { error: string } {
  const sets: string[] = [];
  const binds: unknown[] = [];
  const changed: string[] = [];

  if (e.title !== undefined) {
    const t = typeof e.title === "string" ? e.title.trim() : "";
    if (!t) return { error: "title cannot be empty" };
    sets.push("title = ?"); binds.push(t.slice(0, 500)); changed.push("title");
  }
  if (e.description !== undefined) {
    const d = e.description === null ? null : String(e.description).trim() || null;
    sets.push("description = ?"); binds.push(d); changed.push("description");
  }
  if (e.priority !== undefined) {
    const p = String(e.priority).trim().toLowerCase();
    if (!(TASK_PRIORITIES as readonly string[]).includes(p)) {
      return { error: `priority must be one of ${TASK_PRIORITIES.join(", ")}` };
    }
    sets.push("priority = ?"); binds.push(p); changed.push("priority");
  }
  if (e.due_at !== undefined) {
    let due: string | null = null;
    if (e.due_at !== null && String(e.due_at).trim() !== "") {
      const raw = String(e.due_at).trim();
      // A bare date (YYYY-MM-DD) is kept as written: it means a day, not an instant, and converting it
      // to UTC midnight would show as the day before in Central time.
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) due = raw;
      else {
        const ms = Date.parse(raw);
        if (!Number.isFinite(ms)) return { error: `due_at is not a date: ${raw.slice(0, 40)}` };
        due = new Date(ms).toISOString();
      }
    }
    sets.push("due_at = ?"); binds.push(due); changed.push("due_at");
  }
  if (e.assigned_to !== undefined) {
    const a = e.assigned_to === null ? null : String(e.assigned_to).trim() || null;
    sets.push("assigned_to = ?"); binds.push(a); changed.push("assigned_to");
  }
  return { sets, binds, changed };
}

/** Pick the edit fields out of a loose payload (context JSON or a PATCH body). Pure. */
export function pickTaskEdits(src: Record<string, unknown>): TaskFieldEdits {
  const out: TaskFieldEdits = {};
  if ("title" in src) out.title = src.title as string;
  if ("description" in src) out.description = src.description as string | null;
  if ("priority" in src) out.priority = src.priority as string;
  if ("due_at" in src) out.due_at = src.due_at as string | null;
  else if ("due" in src) out.due_at = src.due as string | null;
  if ("assigned_to" in src) out.assigned_to = src.assigned_to as string | null;
  return out;
}

/** Apply field edits to one task. `changed` lists what was written (empty = nothing asked). */
export async function applyTaskEdits(
  env: Env, id: string, edits: TaskFieldEdits,
): Promise<{ ok: true; changed: string[] } | { ok: false; error: string; notFound?: boolean }> {
  const n = normalizeTaskEdits(edits);
  if ("error" in n) return { ok: false, error: n.error };
  if (n.sets.length === 0) return { ok: true, changed: [] };
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    `UPDATE tasks SET ${n.sets.join(", ")}, updated_at = ? WHERE id = ?`,
  ).bind(...n.binds, now, id).run();
  if (!r.meta?.changes) return { ok: false, error: "Task not found", notFound: true };
  return { ok: true, changed: n.changed };
}
