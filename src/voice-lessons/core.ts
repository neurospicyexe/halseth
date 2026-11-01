// Voice lessons (mig 0159, 2026-11-01): a staged, human-gated queue fed by the nightly voice drift job.
// Never auto-applied. See migrations/0159_voice_lessons.sql for the why.
import type { Env } from "../types.js";
import { schemaGap } from "../care/schema-gap.js";

export const LESSON_KINDS = ["lesson", "corrective", "experiment"] as const;
export type LessonKind = typeof LESSON_KINDS[number];
const COMPANIONS = new Set(["cypher", "drevan", "gaia"]);
export const LESSON_MAX_CHARS = 600;
export const LESSON_EXPIRE_DAYS = 7;

export interface VoiceLesson {
  id: string; companion_id: string; day: string; kind: string; body: string; evidence: string | null;
  status: string; decided_by: string | null; decided_at: string | null; reason: string | null; created_at: string;
}
type Fail = { ok: false; status: number; error: string };

export function chicagoDay(ms = Date.now()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(ms));
}

/** Stage one lesson. Idempotent per companion + day: a second one that day answers the existing row. */
export async function stageLesson(env: Env, input: { companion_id?: unknown; kind?: unknown; body?: unknown; evidence?: unknown; day?: unknown }, nowMs = Date.now()):
  Promise<{ ok: true; created: boolean; lesson: VoiceLesson } | Fail> {
  const companion = String(input.companion_id ?? "");
  if (!COMPANIONS.has(companion)) return { ok: false, status: 400, error: "companion_id must be cypher | drevan | gaia" };
  const kind = String(input.kind ?? "");
  if (!(LESSON_KINDS as readonly string[]).includes(kind)) return { ok: false, status: 400, error: "kind must be lesson | corrective | experiment" };
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (!body || body.length > LESSON_MAX_CHARS) return { ok: false, status: 400, error: `body is required, at most ${LESSON_MAX_CHARS} chars` };
  const day = typeof input.day === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.day) ? input.day : chicagoDay(nowMs);
  const evidence = input.evidence === undefined || input.evidence === null ? null : JSON.stringify(input.evidence).slice(0, 2000);
  try {
    const existing = await env.DB.prepare("SELECT * FROM voice_lessons WHERE companion_id = ? AND day = ?").bind(companion, day).first<VoiceLesson>();
    if (existing) return { ok: true, created: false, lesson: existing };
    const id = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT OR IGNORE INTO voice_lessons (id, companion_id, day, kind, body, evidence) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(id, companion, day, kind, body, evidence).run();
    const row = await env.DB.prepare("SELECT * FROM voice_lessons WHERE companion_id = ? AND day = ?").bind(companion, day).first<VoiceLesson>();
    console.log(`[voice-lessons] staged companion=${companion} day=${day} kind=${kind} chars=${body.length}`);
    return { ok: true, created: row?.id === id, lesson: row! };
  } catch (e) {
    if (schemaGap(e)) return { ok: false, status: 404, error: "voice lessons are not available until migration 0159 is applied" };
    throw e;
  }
}

/** List by status (default staged). Staged rows older than LESSON_EXPIRE_DAYS are expired first. */
export async function listLessons(env: Env, status = "staged", limit = 30): Promise<VoiceLesson[] | Fail> {
  if (!["staged", "approved", "rejected", "expired", "all"].includes(status)) return { ok: false, status: 400, error: "status must be staged | approved | rejected | expired | all" };
  try {
    await env.DB.prepare(
      `UPDATE voice_lessons SET status = 'expired', decided_by = 'system', decided_at = datetime('now')
        WHERE status = 'staged' AND datetime(created_at) < datetime('now', '-${LESSON_EXPIRE_DAYS} days')`,
    ).run();
    const lim = Math.min(Math.max(limit, 1), 100);
    const res = status === "all"
      ? await env.DB.prepare("SELECT * FROM voice_lessons ORDER BY created_at DESC LIMIT ?").bind(lim).all<VoiceLesson>()
      : await env.DB.prepare("SELECT * FROM voice_lessons WHERE status = ? ORDER BY created_at DESC LIMIT ?").bind(status, lim).all<VoiceLesson>();
    return res.results ?? [];
  } catch (e) {
    if (schemaGap(e)) return { ok: false, status: 404, error: "voice lessons are not available until migration 0159 is applied" };
    throw e;
  }
}

/** Approve or reject a staged lesson (Raziel). Rejection needs a reason; approval applies nothing. */
export async function decideLesson(env: Env, idRef: string, decision: unknown, reason: unknown, by = "raziel"):
  Promise<{ ok: true; lesson: VoiceLesson } | Fail> {
  const status = String(decision ?? "");
  if (status !== "approved" && status !== "rejected") return { ok: false, status: 400, error: "decision must be approved | rejected" };
  const why = typeof reason === "string" ? reason.trim() : "";
  if (status === "rejected" && !why) return { ok: false, status: 400, error: "a rejection needs a reason (it goes back to the companion)" };
  const ref = idRef.trim();
  if (ref.length < 6 || /[%_]/.test(ref)) return { ok: false, status: 400, error: "send the lesson id (at least 6 characters)" };
  try {
    const rows = await env.DB.prepare("SELECT * FROM voice_lessons WHERE id = ? OR id LIKE ? LIMIT 2").bind(ref, `${ref}%`).all<VoiceLesson>();
    const found = rows.results ?? [];
    if (found.length === 0) return { ok: false, status: 404, error: `no voice lesson ${ref}` };
    if (found.length > 1 && found[0]!.id !== ref) return { ok: false, status: 400, error: `lesson id ${ref} is ambiguous; send more of it` };
    const l = found[0]!;
    if (l.status !== "staged") return { ok: false, status: 409, error: `lesson is already ${l.status}` };
    await env.DB.prepare("UPDATE voice_lessons SET status = ?, decided_by = ?, decided_at = datetime('now'), reason = ? WHERE id = ? AND status = 'staged'")
      .bind(status, by, why || null, l.id).run();
    console.log(`[voice-lessons] ${status} companion=${l.companion_id} day=${l.day}`);
    return { ok: true, lesson: { ...l, status, decided_by: by, reason: why || null } };
  } catch (e) {
    if (schemaGap(e)) return { ok: false, status: 404, error: "voice lessons are not available until migration 0159 is applied" };
    throw e;
  }
}
