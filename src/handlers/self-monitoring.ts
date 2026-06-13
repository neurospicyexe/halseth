// src/handlers/self-monitoring.ts
//
// Self-monitoring wave (migration 0070):
//   - companion_triggers: prospective "emergency cards" that force-surface when
//     future context matches (keyword -> bot-side match; date/front -> orient-side)
//   - companion_self_model: companion-authored preference observations with a
//     confidence ladder (set 0.3, confirm +0.1, revise -0.1, ready at >=0.8).
//     Graduation to canon is human-gated: the endpoint only permits it from
//     'ready', and callers route it through human-present surfaces (Librarian).
//   - voice_scores: pattern-based drift telemetry from the bots; self_catch_rate
//     measures whether the companion or Raziel notices drift first.
//
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const VALID_COMPANIONS = ["cypher", "drevan", "gaia"] as const;
type CompanionId = (typeof VALID_COMPANIONS)[number];

const MAX_ARMED_TRIGGERS = 10;
const MAX_TRIGGER_LENGTH = 500;
const MAX_OBSERVATION_LENGTH = 600;
const CONFIDENCE_STEP = 0.1;
const READY_THRESHOLD = 0.8;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function isCompanionId(id: string): id is CompanionId {
  return (VALID_COMPANIONS as readonly string[]).includes(id);
}

// ---------------------------------------------------------------------------
// Prospective triggers
// ---------------------------------------------------------------------------

// POST /mind/triggers
// body: { companion_id, trigger_text, condition_type, condition_value, source?, expires_at? }
export async function postTrigger(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: {
    companion_id?: string; trigger_text?: string; condition_type?: string;
    condition_value?: string; source?: string; expires_at?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const companionId = body.companion_id ?? "";
  if (!isCompanionId(companionId)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }
  const triggerText = typeof body.trigger_text === "string" ? body.trigger_text.trim().slice(0, MAX_TRIGGER_LENGTH) : "";
  if (!triggerText) return json({ error: "trigger_text is required" }, 400);
  const conditionType = body.condition_type ?? "";
  if (!["keyword", "date", "front"].includes(conditionType)) {
    return json({ error: "condition_type must be keyword|date|front" }, 400);
  }
  const conditionValue = typeof body.condition_value === "string" ? body.condition_value.trim().slice(0, 200) : "";
  if (!conditionValue) return json({ error: "condition_value is required" }, 400);
  if (conditionType === "date" && Number.isNaN(Date.parse(conditionValue))) {
    return json({ error: "condition_value must be a parseable date for condition_type=date" }, 400);
  }
  const source = typeof body.source === "string" ? body.source.slice(0, 50) : "companion";
  const expiresAt = typeof body.expires_at === "string" && !Number.isNaN(Date.parse(body.expires_at)) ? body.expires_at : null;

  try {
    // Dedup: identical armed trigger is a no-op returning the existing id.
    const existing = await env.DB.prepare(
      "SELECT id FROM companion_triggers WHERE companion_id = ? AND status = 'armed' AND trigger_text = ?"
    ).bind(companionId, triggerText).first<{ id: string }>();
    if (existing) return json({ id: existing.id, deduped: true });

    const armedCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM companion_triggers WHERE companion_id = ? AND status = 'armed'"
    ).bind(companionId).first<{ n: number }>();
    if ((armedCount?.n ?? 0) >= MAX_ARMED_TRIGGERS) {
      return json({ error: "armed trigger cap reached" }, 409);
    }

    const id = `trg_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO companion_triggers (id, companion_id, trigger_text, condition_type, condition_value, source, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, companionId, triggerText, conditionType, conditionValue, source, expiresAt).run();

    return json({ id }, 201);
  } catch (err) {
    console.error("[mind/triggers] write error", { companion_id: companionId, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/triggers/:companion_id?status=armed&limit=20
export async function getTriggers(
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
  const statusParam = url.searchParams.get("status") ?? "armed";
  const status = ["armed", "fired", "dismissed", "all"].includes(statusParam) ? statusParam : "armed";
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);

  try {
    // Expired armed triggers are lazily dismissed on read.
    await env.DB.prepare(
      "UPDATE companion_triggers SET status = 'dismissed' WHERE companion_id = ? AND status = 'armed' AND expires_at IS NOT NULL AND expires_at < datetime('now')"
    ).bind(companion_id).run();

    const stmt = status === "all"
      ? env.DB.prepare(
          "SELECT * FROM companion_triggers WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(companion_id, limit)
      : env.DB.prepare(
          "SELECT * FROM companion_triggers WHERE companion_id = ? AND status = ? ORDER BY created_at DESC LIMIT ?"
        ).bind(companion_id, status, limit);
    const rows = await stmt.all();
    return json({ triggers: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/triggers] read error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/triggers/:id
// body: { status: 'fired'|'dismissed', fire_note? }
export async function patchTrigger(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);

  let body: { status?: string; fire_note?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const status = body.status ?? "";
  if (!["fired", "dismissed"].includes(status)) {
    return json({ error: "status must be 'fired' or 'dismissed'" }, 400);
  }
  const fireNote = typeof body.fire_note === "string" ? body.fire_note.slice(0, 1000) : null;

  try {
    const result = await env.DB.prepare(
      `UPDATE companion_triggers
       SET status = ?, fire_note = COALESCE(?, fire_note),
           fired_at = CASE WHEN ? = 'fired' THEN datetime('now') ELSE fired_at END
       WHERE id = ?`
    ).bind(status, fireNote, status, id).run();

    if (!result.meta.changes) return json({ error: "Trigger not found" }, 404);
    return json({ ok: true });
  } catch (err) {
    console.error("[mind/triggers] patch error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Self-model layer
// ---------------------------------------------------------------------------

// POST /mind/self-model
// body: { companion_id, observation, domain?, evidence_note? }
export async function postSelfModel(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { companion_id?: string; observation?: string; domain?: string; evidence_note?: string; kind?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const companionId = body.companion_id ?? "";
  if (!isCompanionId(companionId)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }
  const observation = typeof body.observation === "string" ? body.observation.trim().slice(0, MAX_OBSERVATION_LENGTH) : "";
  if (!observation) return json({ error: "observation is required" }, 400);
  const domain = typeof body.domain === "string" ? body.domain.slice(0, 100) : null;
  const evidenceNote = typeof body.evidence_note === "string" ? body.evidence_note.slice(0, 1000) : null;
  // Take 7: same ladder, two kinds. 'skill' = an operational competence the worker proves;
  // 'preference' = a self-observation (0070 default).
  const kind = body.kind === "skill" ? "skill" : "preference";

  try {
    // Dedup: an identical non-retired observation of the same kind is a no-op.
    const existing = await env.DB.prepare(
      "SELECT id FROM companion_self_model WHERE companion_id = ? AND status != 'retired' AND kind = ? AND observation = ?"
    ).bind(companionId, kind, observation).first<{ id: string }>();
    if (existing) return json({ id: existing.id, deduped: true });

    const id = `sm_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO companion_self_model (id, companion_id, observation, domain, evidence_note, kind)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id, companionId, observation, domain, evidenceNote, kind).run();

    return json({ id, confidence: 0.3, kind }, 201);
  } catch (err) {
    console.error("[mind/self-model] write error", { companion_id: companionId, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/self-model/:companion_id?status=developing&limit=20
export async function getSelfModel(
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
  const statusParam = url.searchParams.get("status") ?? "all";
  const status = ["developing", "ready", "graduated", "retired", "all"].includes(statusParam) ? statusParam : "all";
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === "skill" || kindParam === "preference" ? kindParam : null;
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 50);

  try {
    const conditions = ["companion_id = ?"];
    const bindings: unknown[] = [companion_id];
    if (status !== "all") { conditions.push("status = ?"); bindings.push(status); }
    if (kind) { conditions.push("kind = ?"); bindings.push(kind); }
    const rows = await env.DB.prepare(
      `SELECT * FROM companion_self_model WHERE ${conditions.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`
    ).bind(...bindings, limit).all();
    return json({ observations: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/self-model] read error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/self-model/:id
// body: { action: 'confirm'|'revise'|'graduate'|'retire', note? }
// confirm/revise move confidence by +/-0.1; status follows the ladder.
// graduate is only legal from 'ready' (human-gated by calling surface).
export async function patchSelfModel(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "id is required" }, 400);

  let body: { action?: string; note?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const action = body.action ?? "";
  if (!["confirm", "revise", "graduate", "retire"].includes(action)) {
    return json({ error: "action must be confirm|revise|graduate|retire" }, 400);
  }
  const note = typeof body.note === "string" ? body.note.slice(0, 1000) : null;

  try {
    const row = await env.DB.prepare(
      "SELECT confidence, status FROM companion_self_model WHERE id = ?"
    ).bind(id).first<{ confidence: number; status: string }>();
    if (!row) return json({ error: "Observation not found" }, 404);

    if (row.status === "graduated" || row.status === "retired") {
      return json({ error: `Observation is ${row.status}; no further actions` }, 409);
    }

    if (action === "graduate") {
      if (row.status !== "ready") {
        return json({ error: "Only 'ready' observations can graduate (confidence >= 0.8)" }, 409);
      }
      await env.DB.prepare(
        `UPDATE companion_self_model
         SET status = 'graduated', graduated_at = datetime('now'), updated_at = datetime('now'),
             evidence_note = COALESCE(?, evidence_note)
         WHERE id = ?`
      ).bind(note, id).run();
      return json({ ok: true, status: "graduated" });
    }

    if (action === "retire") {
      await env.DB.prepare(
        `UPDATE companion_self_model
         SET status = 'retired', updated_at = datetime('now'), evidence_note = COALESCE(?, evidence_note)
         WHERE id = ?`
      ).bind(note, id).run();
      return json({ ok: true, status: "retired" });
    }

    const delta = action === "confirm" ? CONFIDENCE_STEP : -CONFIDENCE_STEP;
    const confidence = Math.min(1, Math.max(0, Math.round((row.confidence + delta) * 10) / 10));
    const status = confidence >= READY_THRESHOLD ? "ready" : "developing";

    await env.DB.prepare(
      `UPDATE companion_self_model
       SET confidence = ?, status = ?, updated_at = datetime('now'),
           evidence_note = COALESCE(?, evidence_note)
       WHERE id = ?`
    ).bind(confidence, status, note, id).run();

    return json({ ok: true, confidence, status });
  } catch (err) {
    console.error("[mind/self-model] patch error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ---------------------------------------------------------------------------
// Voice scores
// ---------------------------------------------------------------------------

// POST /mind/voice-scores
// body: { companion_id, score, positive_hits?, anti_hits?, contamination_hits?, caught_by?, message_len?, channel_id? }
export async function postVoiceScore(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: {
    companion_id?: string; score?: number; positive_hits?: string[]; anti_hits?: string[];
    contamination_hits?: string[]; caught_by?: string; message_len?: number; channel_id?: string;
  };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const companionId = body.companion_id ?? "";
  if (!isCompanionId(companionId)) {
    return json({ error: `Invalid companion_id: must be one of ${VALID_COMPANIONS.join(", ")}` }, 400);
  }
  if (typeof body.score !== "number" || !Number.isFinite(body.score) || body.score < 0 || body.score > 1) {
    return json({ error: "score must be a number in [0, 1]" }, 400);
  }
  const caughtBy = ["self", "human", "system", "none"].includes(body.caught_by ?? "") ? body.caught_by! : "none";
  const toJsonOrNull = (v: unknown): string | null =>
    Array.isArray(v) && v.length > 0 ? JSON.stringify(v.slice(0, 20)) : null;

  try {
    const id = `vs_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO voice_scores (id, companion_id, score, positive_hits, anti_hits, contamination_hits, caught_by, message_len, channel_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, companionId, body.score,
      toJsonOrNull(body.positive_hits), toJsonOrNull(body.anti_hits), toJsonOrNull(body.contamination_hits),
      caughtBy,
      typeof body.message_len === "number" ? Math.max(0, Math.floor(body.message_len)) : null,
      typeof body.channel_id === "string" ? body.channel_id.slice(0, 50) : null,
    ).run();

    return json({ id }, 201);
  } catch (err) {
    console.error("[mind/voice-scores] write error", { companion_id: companionId, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/voice-scores/:companion_id?days=30
// Aggregates + recent rows. self_catch_rate = self catches / all catches (self+human).
export async function getVoiceScores(
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
  const days = Math.min(Math.max(parseInt(url.searchParams.get("days") ?? "30", 10) || 30, 1), 365);

  try {
    const agg = await env.DB.prepare(
      `SELECT COUNT(*) AS n, AVG(score) AS avg_score,
              SUM(CASE WHEN caught_by = 'self' THEN 1 ELSE 0 END) AS self_catches,
              SUM(CASE WHEN caught_by = 'human' THEN 1 ELSE 0 END) AS human_catches
       FROM voice_scores
       WHERE companion_id = ? AND created_at >= datetime('now', '-' || ? || ' days')`
    ).bind(companion_id, days).first<{ n: number; avg_score: number | null; self_catches: number; human_catches: number }>();

    const recent = await env.DB.prepare(
      `SELECT score, anti_hits, contamination_hits, caught_by, created_at
       FROM voice_scores
       WHERE companion_id = ? AND created_at >= datetime('now', '-' || ? || ' days')
       ORDER BY created_at DESC LIMIT 20`
    ).bind(companion_id, days).all();

    const totalCatches = (agg?.self_catches ?? 0) + (agg?.human_catches ?? 0);
    return json({
      scores: {
        n: agg?.n ?? 0,
        avg: agg?.avg_score ?? null,
        self_catch_rate: totalCatches > 0 ? (agg!.self_catches / totalCatches) : null,
        self_catches: agg?.self_catches ?? 0,
        human_catches: agg?.human_catches ?? 0,
        recent: recent.results ?? [],
      },
    });
  } catch (err) {
    console.error("[mind/voice-scores] read error", { companion_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
