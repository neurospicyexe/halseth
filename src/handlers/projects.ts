// src/handlers/projects.ts -- companion self-directed projects (consequence layer C2, mig 0122).
//
// The first structure where a companion OWNS a multi-week intention. Opened, worked, and ENDED by
// the companion; the worker only ever works an already-open project on a project day. `released`
// is a chosen ending with the same dignity as `done` -- no sweep, no cron, no auto-close ever.
//
// Rails (all in this file, so the whole story is auditable in one place):
//   - max 2 OPEN projects per companion (paused ones do not count against the cap);
//   - logging work always stamps last_worked_at, and working a paused project re-opens it --
//     resuming is done by working, not by ceremony;
//   - a project idle 30+ days is SURFACED as "release or resume?" (computed at read; nothing is
//     ever closed by machine). Rails without decay are ratchets; this rail is a question, not a hand.

import { Env } from "../types";
import { generateId } from "../db/queries";
import { assertWritten } from "../lib/result.js";

export const MAX_OPEN_PROJECTS = 2;
/** Idle this long, the orient block asks "release or resume?" -- the companion's call. */
export const PROJECT_STALE_DAYS = 30;

export interface ProjectRow {
  id: string;
  companion_id: string;
  title: string;
  intention: string;
  status: "open" | "paused" | "done" | "released";
  horizon_note: string | null;
  resolution_note: string | null;
  created_at: string;
  last_worked_at: string | null;
  closed_at: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

// ── Core (owner = the companion; the worker acts AS the companion via its id) ─────────────────

export async function openProject(
  env: Env,
  companion_id: string,
  input: { title: string; intention: string; horizon_note?: string | null },
): Promise<{ id: string; created_at: string } | { error: "limit"; open: Array<{ id: string; title: string }> }> {
  // The cap is a rail, not a quota: two intentions is as many as anyone holds well. Paused
  // projects are shelved by choice and do not block a new one.
  const open = (await env.DB.prepare(
    "SELECT id, title FROM companion_projects WHERE companion_id = ? AND status = 'open' ORDER BY created_at ASC",
  ).bind(companion_id).all<{ id: string; title: string }>()).results ?? [];
  if (open.length >= MAX_OPEN_PROJECTS) return { error: "limit", open };

  const id = generateId();
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO companion_projects (id, companion_id, title, intention, status, horizon_note, created_at) " +
      "VALUES (?, ?, ?, ?, 'open', ?, ?)",
  ).bind(id, companion_id, input.title, input.intention, input.horizon_note ?? null, now).run();
  assertWritten(res, { op: "project_open", companion_id });
  return { id, created_at: now };
}

/** Append a work entry. Stamps last_worked_at; working a PAUSED project re-opens it (resuming is
 *  done by working). Closed projects refuse -- an ended thing stays ended unless re-opened by a
 *  human decision, which does not exist as a verb on purpose. */
export async function logProject(
  env: Env,
  companion_id: string,
  project_id: string,
  entry: string,
  source: "worker" | "session" | "discord" = "session",
): Promise<{ ok: true; id: string; reopened: boolean } | { ok: false; reason: string }> {
  const row = await env.DB.prepare(
    "SELECT companion_id, status FROM companion_projects WHERE id = ?",
  ).bind(project_id).first<{ companion_id: string; status: ProjectRow["status"] }>();
  if (!row) return { ok: false, reason: "project not found" };
  if (row.companion_id !== companion_id) return { ok: false, reason: `that project belongs to ${row.companion_id}` };
  if (row.status === "done" || row.status === "released") {
    return { ok: false, reason: `project is ${row.status} -- an ended thing stays ended` };
  }

  const id = generateId();
  const now = new Date().toISOString();
  const reopened = row.status === "paused";
  // One batch: the schema promises "last_worked_at is stamped by every project_log write", and
  // only an atomic write keeps that promise -- a crash between two statements would leave a log
  // row whose project still reads as untouched (migration-reviewer advisory, 0122).
  const [logRes] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO project_log (id, project_id, companion_id, entry, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, project_id, companion_id, entry, source, now),
    env.DB.prepare(
      "UPDATE companion_projects SET last_worked_at = ?, status = 'open' WHERE id = ?",
    ).bind(now, project_id),
  ]);
  assertWritten(logRes, { op: "project_log", companion_id });
  return { ok: true, id, reopened };
}

/** End a project: done (it became what it was for) or released (a chosen ending -- same dignity,
 *  different shape). The note is the companion's words; machine text has no business here. */
export async function closeProject(
  env: Env,
  companion_id: string,
  project_id: string,
  kind: "done" | "released",
  resolution_note: string | null,
): Promise<boolean> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "UPDATE companion_projects SET status = ?, resolution_note = ?, closed_at = ? " +
      "WHERE id = ? AND companion_id = ? AND status IN ('open', 'paused')",
  ).bind(kind, resolution_note, now, project_id, companion_id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Shelve without ending. Doesn't count against the open cap; any logged work re-opens it. */
export async function pauseProject(env: Env, companion_id: string, project_id: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_projects SET status = 'paused' WHERE id = ? AND companion_id = ? AND status = 'open'",
  ).bind(project_id, companion_id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** Ceremony-free resume for when the companion wants the project open again without logging work
 *  yet. Respects the open cap -- resuming a third project is opening a third project. */
export async function resumeProject(
  env: Env, companion_id: string, project_id: string,
): Promise<{ ok: boolean; reason?: string }> {
  const open = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM companion_projects WHERE companion_id = ? AND status = 'open'",
  ).bind(companion_id).first<{ n: number }>();
  if ((open?.n ?? 0) >= MAX_OPEN_PROJECTS) return { ok: false, reason: "two projects are already open -- close or pause one first" };
  const r = await env.DB.prepare(
    "UPDATE companion_projects SET status = 'open' WHERE id = ? AND companion_id = ? AND status = 'paused'",
  ).bind(project_id, companion_id).run();
  return { ok: (r.meta?.changes ?? 0) > 0, ...(r.meta?.changes ? {} : { reason: "not found, not yours, or not paused" }) };
}

export async function readProjects(
  env: Env, companion_id: string, status?: string, limit = 20,
): Promise<ProjectRow[]> {
  const capped = Math.min(Math.max(1, limit), 100);
  const stmt = status
    ? env.DB.prepare(
        "SELECT * FROM companion_projects WHERE companion_id = ? AND status = ? " +
          "ORDER BY COALESCE(last_worked_at, created_at) ASC LIMIT ?",
      ).bind(companion_id, status, capped)
    : env.DB.prepare(
        "SELECT * FROM companion_projects WHERE companion_id = ? " +
          "ORDER BY (status IN ('open','paused')) DESC, COALESCE(last_worked_at, created_at) ASC LIMIT ?",
      ).bind(companion_id, capped);
  return (await stmt.all<ProjectRow>()).results ?? [];
}

export async function readProjectLog(
  env: Env, project_id: string, limit = 20,
): Promise<Array<{ id: string; entry: string; source: string; created_at: string }>> {
  const capped = Math.min(Math.max(1, limit), 100);
  return (await env.DB.prepare(
    "SELECT id, entry, source, created_at FROM project_log WHERE project_id = ? ORDER BY created_at DESC LIMIT ?",
  ).bind(project_id, capped).all<{ id: string; entry: string; source: string; created_at: string }>()).results ?? [];
}

// ── HTTP surface (the worker's lane + Hearth/Raziel reads) ────────────────────────────────────

/** GET /mind/projects/:companion_id?status=open -- the worker's project-day read and Hearth's list. */
export async function getProjects(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companionId = params.companion_id;
  if (!companionId) return json({ error: "missing companion_id" }, 400);
  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const rows = await readProjects(env, companionId, status);
  return json({ projects: rows });
}

/** GET /mind/projects/:id/log -- the work trail, newest first. Raziel's read. */
export async function getProjectLog(_request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  const rows = await readProjectLog(env, id);
  return json({ log: rows });
}

/** POST /mind/projects/:id/log { companion_id, entry, source? } -- the worker's write after a
 *  project-day run. Same rails as the verb: ownership checked, ended projects refuse. */
export async function postProjectLog(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const id = params.id;
  if (!id) return json({ error: "missing id" }, 400);
  let body: { companion_id?: string; entry?: string; source?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const companionId = String(body.companion_id ?? "");
  const entry = String(body.entry ?? "").trim();
  if (!companionId || !entry) return json({ error: "need { companion_id, entry }" }, 400);
  const source = body.source === "worker" || body.source === "discord" ? body.source : "session";
  const out = await logProject(env, companionId, id, entry.slice(0, 4000), source);
  if (!out.ok) return json({ error: "project_log_failed", reason: out.reason }, 409);
  return json({ ok: true, id: out.id, reopened: out.reopened });
}
