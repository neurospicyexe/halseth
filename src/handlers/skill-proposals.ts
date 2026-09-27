// src/handlers/skill-proposals.ts
//
// HTTP route handlers for the Hermes skill-proposal mirror (migration 0107,
// docs/skill-proposal-mirror.md).
//   POST  /mind/skill-proposals               -- watcher mirrors a staged skill record
//   GET   /mind/skill-proposals               -- list proposals (?status=&companion_id=&limit=)
//   PATCH /mind/skill-proposals/:id/decision  -- watcher mirrors the approve/decline
//
// The VPS stage is the source of truth for the skill files; this table is the
// off-VPS review surface and the durable decision trail. Ingest is idempotent on
// external_id -- the watcher may re-post a stage record after a restart.
//
// Auth: authGuard (ADMIN_SECRET / per-companion tokens), enforced at the handler
// level, matching the pattern used by handlers/forage.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);
const VALID_ACTIONS = new Set<string>(["create", "update"]);
const VALID_STATUSES = new Set<string>(["staged", "approved", "declined"]);

interface ProposalPostBody {
  external_id?: string | null;
  companion_id?: string;
  hermes_home?: string | null;
  skill_name?: string;
  action?: string;
  summary?: string | null;
  content?: string | null;
}

// POST /mind/skill-proposals
export async function postSkillProposal(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: ProposalPostBody;
  try {
    body = await request.json() as ProposalPostBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const companionId = body.companion_id?.trim() ?? "";
  const skillName = body.skill_name?.trim();
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  if (!skillName) {
    return json({ error: "skill_name is required" }, 400);
  }
  const action = body.action?.trim() || "create";
  if (!VALID_ACTIONS.has(action)) {
    return json({ error: "action must be create or update" }, 400);
  }
  const externalId = body.external_id?.trim() || null;
  const hermesHome = body.hermes_home?.trim() || null;
  const summary = body.summary?.trim() || null;
  const content = body.content ?? null;

  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(
      "INSERT INTO skill_proposals (id, external_id, companion_id, hermes_home, skill_name, action, summary, content, staged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"
    ).bind(
      id, externalId, companionId, hermesHome,
      skillName.slice(0, 200), action,
      summary?.slice(0, 2000) ?? null, content,
    ).run();
  } catch (err) {
    // external_id UNIQUE: a watcher re-post after restart is normal, not an error.
    if (String(err).includes("UNIQUE constraint failed")) {
      const existing = await env.DB.prepare(
        "SELECT id, status FROM skill_proposals WHERE external_id = ?"
      ).bind(externalId).first<{ id: string; status: string }>();
      return json({ deduped: true, id: existing?.id ?? null, status: existing?.status ?? null }, 200);
    }
    console.error("[mind/skill-proposals] insert error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }

  return json({ proposal: { id, external_id: externalId, companion_id: companionId, skill_name: skillName, action, status: "staged" } }, 201);
}

// GET /mind/skill-proposals?status=staged&companion_id=cypher&limit=20
export async function listSkillProposals(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? "staged";
  if (status !== "all" && !VALID_STATUSES.has(status)) {
    return json({ error: "status must be staged, approved, declined, or all" }, 400);
  }
  const companionId = url.searchParams.get("companion_id");
  if (companionId !== null && !VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);

  // Covenant: conditions array contains only hardcoded literal strings.
  const conditions: string[] = [];
  const bindings: unknown[] = [];
  if (status !== "all") {
    conditions.push("status = ?");
    bindings.push(status);
  }
  if (companionId !== null) {
    conditions.push("companion_id = ?");
    bindings.push(companionId);
  }
  const where = conditions.length > 0 ? ` WHERE ${conditions.join(" AND ")}` : "";
  bindings.push(limit);

  try {
    const rows = await env.DB.prepare(
      `SELECT * FROM skill_proposals${where} ORDER BY staged_at DESC LIMIT ?`
    ).bind(...bindings).all();
    return json({ proposals: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/skill-proposals] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/skill-proposals/:id/decision
export async function decideSkillProposal(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { status?: string; decided_by?: string; note?: string };
  try {
    body = await request.json() as { status?: string; decided_by?: string; note?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const status = body.status?.trim() ?? "";
  if (status !== "approved" && status !== "declined") {
    return json({ error: "status must be approved or declined" }, 400);
  }
  const decidedBy = body.decided_by?.trim().slice(0, 100) || "raziel";
  const note = body.note?.trim().slice(0, 1000) || null;

  try {
    // Accept id OR external_id so the watcher can decide by its own stage-record id.
    const result = await env.DB.prepare(
      "UPDATE skill_proposals SET status = ?, decided_by = ?, decision_note = ?, decided_at = datetime('now') WHERE (id = ? OR external_id = ?) AND status = 'staged'"
    ).bind(status, decidedBy, note, id, id).run();
    if ((result.meta?.changes ?? 0) === 0) {
      const row = await env.DB.prepare(
        "SELECT id, status, decided_by, decided_at FROM skill_proposals WHERE id = ? OR external_id = ?"
      ).bind(id, id).first<{ id: string; status: string; decided_by: string | null; decided_at: string | null }>();
      if (!row) return json({ error: "proposal not found" }, 404);
      return json({ error: "proposal already decided", status: row.status, decided_by: row.decided_by, decided_at: row.decided_at }, 409);
    }
    return json({ decided: true, id, status });
  } catch (err) {
    console.error("[mind/skill-proposals] decision error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
