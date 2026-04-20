// src/handlers/conclusions.ts
//
// HTTP route handlers for companion conclusions (thesis surface).
// POST /companion-conclusions           — add a conclusion (optionally supersedes a prior one)
// GET  /companion-conclusions/:agent_id — read active (non-superseded) conclusions
// POST /companion-conclusions/:id/supersede — mark a conclusion superseded by a later one

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import type { WmAgentId } from "../webmind/types.js";

const VALID_AGENT_IDS: WmAgentId[] = ["cypher", "drevan", "gaia"];
const MAX_TEXT_LENGTH = 8000;

function isValidAgentId(id: string): id is WmAgentId {
  return (VALID_AGENT_IDS as string[]).includes(id);
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// POST /companion-conclusions
// Body: { companion_id, conclusion_text, source_sessions?: string[], supersedes?: string }
// If `supersedes` is provided, marks that conclusion as superseded_by the new one.
export async function postConclusion(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { companion_id, conclusion_text, source_sessions, supersedes } = body;

  if (typeof companion_id !== "string" || !isValidAgentId(companion_id)) {
    return json({ error: "companion_id must be one of: cypher, drevan, gaia" }, 400);
  }
  if (typeof conclusion_text !== "string" || !conclusion_text.trim()) {
    return json({ error: "conclusion_text is required" }, 400);
  }
  if (conclusion_text.length > MAX_TEXT_LENGTH) {
    return json({ error: `conclusion_text exceeds ${MAX_TEXT_LENGTH} character limit` }, 400);
  }

  const VALID_BELIEF_TYPES = ["self", "observational", "relational", "systemic"] as const;

  const rawBeliefType = body.belief_type;
  if (rawBeliefType !== undefined && rawBeliefType !== null) {
    if (typeof rawBeliefType !== "string" || !(VALID_BELIEF_TYPES as readonly string[]).includes(rawBeliefType)) {
      return json({ error: "belief_type must be one of: self, observational, relational, systemic" }, 400);
    }
  }

  const rawConfidence = body.confidence;
  if (rawConfidence !== undefined && rawConfidence !== null) {
    if (typeof rawConfidence !== "number" || rawConfidence < 0.0 || rawConfidence > 1.0) {
      return json({ error: "confidence must be between 0.0 and 1.0" }, 400);
    }
  }

  const sourceSessions = Array.isArray(source_sessions)
    ? JSON.stringify(source_sessions.map(String).slice(0, 20))
    : null;
  const supersedesId = typeof supersedes === "string" ? supersedes : null;

  const confidence = (typeof rawConfidence === "number") ? rawConfidence : 0.7;
  const belief_type = (typeof rawBeliefType === "string") ? rawBeliefType : "self";
  const subject = (typeof body.subject === "string") ? body.subject : null;
  const provenance = (typeof body.provenance === "string") ? body.provenance : null;
  const contradiction_flagged = (typeof body.contradiction_flagged === "number") ? body.contradiction_flagged : 0;

  // Atomic: insert new conclusion, then supersede old one if requested.
  const newId = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();

  const stmts = [
    env.DB.prepare(
      "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, source_sessions, created_at, confidence, belief_type, subject, provenance, contradiction_flagged) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(newId, companion_id, conclusion_text.trim(), sourceSessions, now, confidence, belief_type, subject, provenance, contradiction_flagged),
  ];

  if (supersedesId) {
    stmts.push(
      env.DB.prepare(
        "UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL"
      ).bind(newId, supersedesId, companion_id)
    );
  }

  await env.DB.batch(stmts);

  return json({ id: newId, created_at: now, superseded: supersedesId ?? null });
}

// GET /companion-conclusions/:agent_id
// Query params: include_superseded=true to include superseded conclusions.
export async function getConclusions(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const agentId = params.agent_id;
  if (!agentId || !isValidAgentId(agentId)) {
    return json({ error: "agent_id must be one of: cypher, drevan, gaia" }, 400);
  }

  const url = new URL(request.url);
  const includeSuperseded = url.searchParams.get("include_superseded") === "true";

  const query = includeSuperseded
    ? "SELECT id, companion_id, conclusion_text, source_sessions, superseded_by, created_at, confidence, belief_type, subject, provenance, contradiction_flagged FROM companion_conclusions WHERE companion_id = ? ORDER BY created_at DESC LIMIT 20"
    : "SELECT id, companion_id, conclusion_text, source_sessions, superseded_by, created_at, confidence, belief_type, subject, provenance, contradiction_flagged FROM companion_conclusions WHERE companion_id = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 10";

  const rows = await env.DB.prepare(query).bind(agentId).all();
  return json({ conclusions: rows.results ?? [] });
}

// POST /companion-conclusions/:id/supersede
// Body: { companion_id, superseded_by: string (ID of the newer conclusion) }
export async function supersedeConclusionById(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id) return json({ error: "conclusion id is required" }, 400);

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const { companion_id, superseded_by } = body;
  if (typeof companion_id !== "string" || !isValidAgentId(companion_id)) {
    return json({ error: "companion_id is required" }, 400);
  }
  if (typeof superseded_by !== "string" || !superseded_by.trim()) {
    return json({ error: "superseded_by (id of the newer conclusion) is required" }, 400);
  }

  const result = await env.DB.prepare(
    "UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL"
  ).bind(superseded_by.trim(), id, companion_id).run();

  return json({ ok: (result.meta.changes ?? 0) > 0 });
}
