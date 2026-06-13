// src/handlers/council.ts
//
// Council mode (migration 0080, take 8). Raziel convenes a hard question; the worker
// (autonomous-worker/council.ts) runs the answer + blind cross-rank + Gaia-chairman
// synthesis, writing through these endpoints. The Borda tally is canonical HERE (at
// finalize) so the winner is computed from stored de-anonymized rankings, not trusted
// from the orchestrator.
//
//   POST /mind/council/convene          { question, asked_by? }
//   GET  /mind/council/current          -- newest non-closed question + answers + rankings
//   GET  /mind/council/rounds?limit     -- recent closed questions (synthesis + winner)
//   GET  /mind/council/next-open        -- oldest open question (worker picks this up)
//   POST /mind/council/answer           { question_id, companion_id, answer }
//   POST /mind/council/ranking          { question_id, ranker_id, ranking: string[] }
//   POST /mind/council/:id/finalize     { synthesis }  -> tally + close
//
// Auth: authGuard.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  tallyRankings, insertQuestionSql, insertAnswerSql, insertRankingSql, closeQuestionSql,
} from "../webmind/council.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);

// POST /mind/council/convene
export async function convene(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { question?: string; asked_by?: string };
  try { body = await request.json() as { question?: string; asked_by?: string }; }
  catch { return json({ error: "invalid JSON body" }, 400); }
  const question = body.question?.trim();
  if (!question) return json({ error: "question is required" }, 400);
  const askedBy = (body.asked_by?.trim() || "raziel").slice(0, 60);
  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(insertQuestionSql()).bind(id, question.slice(0, 2000), askedBy).run();
    return json({ question: { id, question, asked_by: askedBy, status: "open" } }, 201);
  } catch (err) {
    console.error("[mind/council] convene error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/council/current
export async function getCurrent(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const round = await env.DB.prepare(
      "SELECT id, question, asked_by, status, winning_companion_id, synthesis, created_at FROM council_questions WHERE status != 'closed' ORDER BY created_at DESC LIMIT 1",
    ).first<{ id: string }>();
    if (!round) return json({ round: null, answers: [], rankings: [] });
    const [answers, rankings] = await Promise.all([
      env.DB.prepare("SELECT companion_id, answer, created_at FROM council_answers WHERE question_id = ?").bind((round as { id: string }).id).all(),
      env.DB.prepare("SELECT ranker_id, ranking_json FROM council_rankings WHERE question_id = ?").bind((round as { id: string }).id).all(),
    ]);
    return json({ round, answers: answers.results ?? [], rankings: rankings.results ?? [] });
  } catch (err) {
    console.error("[mind/council] current error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/council/rounds?limit=10
export async function getRounds(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "10", 10) || 10, 1), 50);
  try {
    const rows = await env.DB.prepare(
      "SELECT id, question, asked_by, status, winning_companion_id, synthesis, created_at, closed_at FROM council_questions WHERE status = 'closed' ORDER BY closed_at DESC LIMIT ?",
    ).bind(limit).all();
    return json({ rounds: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/council] rounds error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/council/next-open
export async function getNextOpen(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const row = await env.DB.prepare(
      "SELECT id, question, asked_by FROM council_questions WHERE status = 'open' ORDER BY created_at ASC LIMIT 1",
    ).first();
    return json({ question: row ?? null });
  } catch (err) {
    console.error("[mind/council] next-open error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/council/answer
export async function postAnswer(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { question_id?: string; companion_id?: string; answer?: string };
  try { body = await request.json() as typeof body; } catch { return json({ error: "invalid JSON body" }, 400); }
  const questionId = body.question_id?.trim();
  const companionId = body.companion_id?.trim() ?? "";
  const answer = body.answer?.trim();
  if (!questionId || !answer) return json({ error: "question_id and answer are required" }, 400);
  if (!VALID_COMPANIONS.has(companionId)) return json({ error: "companion_id must be cypher, drevan, gaia" }, 400);
  try {
    await env.DB.prepare(insertAnswerSql()).bind(crypto.randomUUID().replace(/-/g, ""), questionId, companionId, answer.slice(0, 6000)).run();
    return json({ ok: true }, 201);
  } catch (err) {
    if (String(err).includes("UNIQUE")) return json({ deduped: true });
    console.error("[mind/council] answer error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/council/ranking   { question_id, ranker_id, ranking: string[] (companion_ids best->worst) }
export async function postRanking(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { question_id?: string; ranker_id?: string; ranking?: unknown };
  try { body = await request.json() as typeof body; } catch { return json({ error: "invalid JSON body" }, 400); }
  const questionId = body.question_id?.trim();
  const rankerId = body.ranker_id?.trim() ?? "";
  if (!questionId) return json({ error: "question_id is required" }, 400);
  if (!VALID_COMPANIONS.has(rankerId)) return json({ error: "ranker_id must be cypher, drevan, gaia" }, 400);
  const ranking = Array.isArray(body.ranking) ? body.ranking.filter((x): x is string => typeof x === "string" && VALID_COMPANIONS.has(x)) : [];
  if (ranking.length === 0) return json({ error: "ranking must be a non-empty array of companion_ids" }, 400);
  try {
    await env.DB.prepare(insertRankingSql()).bind(crypto.randomUUID().replace(/-/g, ""), questionId, rankerId, JSON.stringify(ranking)).run();
    return json({ ok: true }, 201);
  } catch (err) {
    if (String(err).includes("UNIQUE")) return json({ deduped: true });
    console.error("[mind/council] ranking error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/council/:id/finalize   { synthesis }
export async function finalize(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { synthesis?: string };
  try { body = await request.json() as { synthesis?: string }; } catch { return json({ error: "invalid JSON body" }, 400); }
  const synthesis = body.synthesis?.trim();
  if (!synthesis) return json({ error: "synthesis is required" }, 400);
  try {
    const [answers, rankings] = await Promise.all([
      env.DB.prepare("SELECT companion_id FROM council_answers WHERE question_id = ?").bind(id).all<{ companion_id: string }>(),
      env.DB.prepare("SELECT ranking_json FROM council_rankings WHERE question_id = ?").bind(id).all<{ ranking_json: string }>(),
    ]);
    const candidates = (answers.results ?? []).map(r => r.companion_id);
    if (candidates.length === 0) return json({ error: "no answers to tally" }, 409);
    const parsedRankings = (rankings.results ?? []).map(r => {
      try { return { ranking: JSON.parse(r.ranking_json) as string[] }; } catch { return { ranking: [] as string[] }; }
    });
    const { winner, scores } = tallyRankings(parsedRankings, candidates);
    await env.DB.prepare(closeQuestionSql()).bind(winner, synthesis.slice(0, 6000), id).run();
    return json({ ok: true, winning_companion_id: winner, scores });
  } catch (err) {
    console.error("[mind/council] finalize error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
