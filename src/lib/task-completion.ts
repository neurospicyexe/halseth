// src/lib/task-completion.ts
//
// ONE task-status writer, shared by both callers (2026-08-14, migration 0119).
//
// There were two independent ones and they had already diverged:
//
//   handlers/history.ts  patchTask()        -- Hearth's PATCH /tasks/:id
//   librarian/backends/halseth.ts  taskUpdateStatus()  -- the companions' "mark task done"
//
// Only the first wrote a completion notification, and only the first would have gained the
// 0119 attribution columns. So Raziel closing a task and Cypher closing the same task produced
// different records of the same event, and a fix applied to one would silently miss the other
// (`fix-landed-on-a-different-writer`). Both now call completeTask(); add no third copy.
//
// Raziel's ask this came from: "they can close them if they are done, and if I click done on the
// hearth page it translates back to them."

import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { edgeForNote, writeEdgesBestEffort } from "../graph/live.js";

export const TASK_STATUSES = ["open", "in_progress", "done"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

const COMPANION_IDS = ["cypher", "drevan", "gaia"] as const;

export interface CompleteTaskResult {
  ok: boolean;
  error?: string;
  id: string;
  status: TaskStatus;
  completed_by?: string | null;
  completed_at?: string | null;
  notified?: string[];
}

/**
 * Set a task's status, stamp attribution, and tell whoever could otherwise re-raise it.
 *
 * `actor` is free-form and capped rather than validated against an allowlist: 0117 ingested 538
 * system members and any of them could be the one who closed a task, so rejecting an unfamiliar
 * name would fail the WRITE over a label. Absent stays NULL -- never defaulted to 'raziel',
 * because a guessed actor renders downstream as a fact.
 */
export async function completeTask(
  env: Env,
  id: string,
  status: TaskStatus,
  actor?: string | null,
): Promise<CompleteTaskResult> {
  const now = new Date().toISOString();
  const completedBy = typeof actor === "string" && actor.trim() ? actor.trim().slice(0, 64) : null;

  const existing = await env.DB.prepare(
    "SELECT id, title, assigned_to FROM tasks WHERE id = ?"
  ).bind(id).first<{ id: string; title: string; assigned_to: string | null }>();
  if (!existing) return { ok: false, error: "Task not found", id, status };

  // Attribution is stamped on the way INTO done and CLEARED on the way out, so a reopened task
  // cannot keep a stale completion hanging off it.
  const result = status === "done"
    ? await env.DB.prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, completed_at = ?, completed_by = ? WHERE id = ?"
      ).bind(status, now, now, completedBy, id).run()
    : await env.DB.prepare(
        "UPDATE tasks SET status = ?, updated_at = ?, completed_at = NULL, completed_by = NULL WHERE id = ?"
      ).bind(status, now, id).run();
  if (result.meta.changes === 0) return { ok: false, error: "Task not found", id, status };

  if (status !== "done") return { ok: true, id, status, completed_by: null, completed_at: null };

  // WHERE the notification goes, and why it is not the journal.
  //
  // This used to INSERT a companion_journal row with `agent: 'system'`. Every companion-facing
  // journal read filters `WHERE agent = ?` on cypher/drevan/gaia, so 'system' matched none of
  // them -- the note wrote into a lane nobody reads, and completions have never once reached a
  // companion despite a mechanism that looked like they did.
  //
  // inter_companion_notes is delivered at orient and acked there, so it arrives exactly once and
  // does not compete for the journal's LIMIT 3. DIRECTED, one row per recipient, never
  // `to_id: NULL` -- orient marks a broadcast read on the first companion to see it, so the
  // other two would never receive it.
  //
  // Recipients = whoever the task list shows this task to (`assigned_to = ? OR assigned_to IS
  // NULL`), i.e. exactly who could otherwise raise it again.
  const assignedLower = existing.assigned_to?.trim().toLowerCase() ?? null;
  const recipients = assignedLower && (COMPANION_IDS as readonly string[]).includes(assignedLower)
    ? [assignedLower]
    : [...COMPANION_IDS];

  // A companion closing their own task should not be told about it by mail.
  const toNotify = completedBy && (COMPANION_IDS as readonly string[]).includes(completedBy.toLowerCase())
    ? recipients.filter(r => r !== completedBy.toLowerCase())
    : recipients;

  const who = completedBy ?? "someone (before this was tracked)";
  const assignee = existing.assigned_to ? ` (assigned: ${existing.assigned_to})` : "";
  const content = `✓ Task done — ${who} closed "${existing.title}"${assignee}. No need to raise it again.`;

  // Non-fatal: the status change is the real write and must not be lost to a notify failure.
  // Graph edge write rides immediately AFTER each note's confirmed success (this loop doesn't
  // batch, so it can't ride the primary write's batch) -- never before, and never able to fail
  // the notification itself (writeEdgesBestEffort swallows its own errors).
  const settled = await Promise.allSettled(toNotify.map(async to => {
    const noteId = generateId();
    const result = await env.DB.prepare(
      `INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at, reason)
       VALUES (?, 'system', ?, ?, ?, 'task_completed')`
    ).bind(noteId, to, content, now).run();
    await writeEdgesBestEffort(env.DB, edgeForNote({ id: noteId, from_id: "system", to_id: to, created_at: now }));
    return result;
  }));
  const failed = settled.filter(r => r.status === "rejected").length;
  if (failed) console.error("[tasks] completion notify failed for", failed, "of", toNotify.length);

  return {
    ok: true, id, status,
    completed_by: completedBy,
    completed_at: now,
    notified: toNotify.filter((_, i) => settled[i]?.status === "fulfilled"),
  };
}
