// src/handlers/companion-questions.ts
//
// Mutuality surface for the autonomy loop:
//   - companion_questions CRUD: companions ask Raziel, not just report
//   - growth valence aggregate: ratification outcomes feed seed generation
//   - soma float read: light state read for the worker pulse scheduler
//
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = ["cypher", "drevan", "gaia"] as const;
type CompanionId = (typeof VALID_COMPANIONS)[number];

const MAX_OPEN_QUESTIONS = 5; // cap prevents question spam from a misbehaving run
const MAX_QUESTION_LENGTH = 600;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isCompanionId(id: string): id is CompanionId {
  return (VALID_COMPANIONS as readonly string[]).includes(id);
}

// POST /mind/questions
// body: { companion_id, question, context?, source? }
export async function postQuestion(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; question?: string; context?: string; source?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const companionId = body.companion_id ?? "";
  if (!isCompanionId(companionId)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }
  const question = typeof body.question === "string" ? body.question.trim().slice(0, MAX_QUESTION_LENGTH) : "";
  if (!question) return json({ error: "question is required" }, 400);
  const context = typeof body.context === "string" ? body.context.slice(0, 1000) : null;
  const source = ["autonomous", "session", "dialectic"].includes(body.source ?? "") ? body.source! : "autonomous";

  try {
    // Dedup: identical open question is a no-op returning the existing id.
    const existing = await env.DB.prepare(
      "SELECT id FROM companion_questions WHERE companion_id = ? AND status = 'open' AND question = ?"
    ).bind(companionId, question).first<{ id: string }>();
    if (existing) return json({ id: existing.id, deduped: true });

    const openCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM companion_questions WHERE companion_id = ? AND status = 'open'"
    ).bind(companionId).first<{ n: number }>();
    if ((openCount?.n ?? 0) >= MAX_OPEN_QUESTIONS) {
      return json({ error: "open question cap reached" }, 409);
    }

    const id = `q_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO companion_questions (id, companion_id, question, context, source) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, companionId, question, context, source).run();

    return json({ id }, 201);
  } catch (err) {
    console.error("[mind/questions] write error", { companion_id: companionId, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/questions/:companion_id?status=open&limit=10
export async function getQuestions(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { companion_id } = params;
  if (!companion_id || !isCompanionId(companion_id)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "open";
  const status = ["open", "answered", "dismissed", "all"].includes(statusParam) ? statusParam : "open";
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1), 50);

  try {
    const stmt = status === "all"
      ? env.DB.prepare(
          "SELECT * FROM companion_questions WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(companion_id, limit)
      : env.DB.prepare(
          "SELECT * FROM companion_questions WHERE companion_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(companion_id, status, limit);
    const rows = await stmt.all();
    return json({ questions: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/questions] read error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/questions/:id
// body: { status: 'answered'|'dismissed', answer? }
export async function patchQuestion(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);

  let body: { status?: string; answer?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const status = body.status ?? "";
  if (!["answered", "dismissed"].includes(status)) {
    return json({ error: "status must be 'answered' or 'dismissed'" }, 400);
  }
  const answer = typeof body.answer === "string" ? body.answer.slice(0, 2000) : null;

  try {
    const result = await env.DB.prepare(
      `UPDATE companion_questions
       SET status = ?, answer = ?, answered_at = CASE WHEN ? = 'answered' THEN datetime('now') ELSE answered_at END
       WHERE id = ?`
    ).bind(status, answer, status, id).run();

    if (!result.meta.changes) return json({ error: "Question not found" }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error("[mind/questions] patch error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/growth/valence/:companion_id?days=60
// Ratification outcomes for the seed feedback loop: what became canon, what was drift.
export async function getGrowthValence(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { companion_id } = params;
  if (!companion_id || !isCompanionId(companion_id)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }

  const url = new URL(request.url);
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "60", 10) || 60, 1), 365);

  try {
    const rows = await env.DB.prepare(
      `SELECT review_status, tags, substr(content, 1, 140) AS excerpt, entry_type
       FROM growth_journal
       WHERE companion_id = ? AND source = 'autonomous'
         AND review_status IN ('accepted','declined')
         AND created_at >= datetime('now', '-' || ? || ' days')
       ORDER BY created_at DESC LIMIT 40`
    ).bind(companion_id, days).all<{ review_status: string; tags: string | null; excerpt: string; entry_type: string }>();

    const accepted: Array<{ tags: string | null; excerpt: string; entry_type: string }> = [];
    const declined: Array<{ tags: string | null; excerpt: string; entry_type: string }> = [];
    for (const r of rows.results ?? []) {
      const item = { tags: r.tags, excerpt: r.excerpt, entry_type: r.entry_type };
      if (r.review_status === "accepted") accepted.push(item);
      else declined.push(item);
    }
    return json({ valence: { accepted, declined } });
  } catch (err) {
    console.error("[mind/growth/valence] error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/soma/:companion_id
// Light state read for the worker pulse scheduler -- floats + labels only.
export async function getSomaFloats(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { companion_id } = params;
  if (!companion_id || !isCompanionId(companion_id)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }

  try {
    const row = await env.DB.prepare(
      `SELECT soma_float_1, soma_float_2, soma_float_3,
              float_1_label, float_2_label, float_3_label, current_mood
       FROM companion_state WHERE companion_id = ?`
    ).bind(companion_id).first<{
      soma_float_1: number | null; soma_float_2: number | null; soma_float_3: number | null;
      float_1_label: string | null; float_2_label: string | null; float_3_label: string | null;
      current_mood: string | null;
    }>();

    if (!row) return json({ error: "No state row for companion" }, 404);
    return json({ soma: row });
  } catch (err) {
    console.error("[mind/soma] error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
