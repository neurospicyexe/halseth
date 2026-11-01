// Voice lessons HTTP (mig 0159): POST /mind/voice-lessons (the worker stages one), GET /mind/voice-lessons
// (?status=staged|approved|rejected|expired|all), POST /mind/voice-lessons/:id/decide { decision, reason } (admin).
import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { stageLesson, listLessons, decideLesson } from "../voice-lessons/core.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
async function body(request: Request): Promise<Record<string, unknown> | null> {
  try { const b = await request.json(); return b && typeof b === "object" ? (b as Record<string, unknown>) : null; } catch { return null; }
}

export async function postVoiceLesson(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const b = await body(request);
  if (!b) return json({ error: "invalid JSON body" }, 400);
  const caller = identifyCallerCompanion(request, env);
  if (caller && b.companion_id && caller !== b.companion_id) return json({ error: "forbidden: token does not match companion" }, 403);
  const r = await stageLesson(env, { ...b, companion_id: b.companion_id ?? caller });
  if (!r.ok) return json({ error: r.error }, r.status);
  return json({ ok: true, created: r.created, ...(r.created ? {} : { existing: true }), lesson: r.lesson }, r.created ? 201 : 200);
}

export async function getVoiceLessons(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const r = await listLessons(env, url.searchParams.get("status") ?? "staged", Number(url.searchParams.get("limit") ?? "30") || 30);
  if (!Array.isArray(r)) return json({ error: r.error }, r.status);
  return json({ lessons: r });
}

export async function postVoiceLessonDecide(request: Request, env: Env, params: { id?: string }): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  // A companion token never approves its own lesson: deciding is Raziel's (the admin secret).
  if (identifyCallerCompanion(request, env)) return json({ error: "forbidden: only Raziel decides a voice lesson" }, 403);
  const b = await body(request);
  if (!b) return json({ error: "invalid JSON body" }, 400);
  const r = await decideLesson(env, params.id ?? "", b.decision, b.reason);
  if (!r.ok) return json({ error: r.error }, r.status);
  return json({ ok: true, lesson: r.lesson });
}
