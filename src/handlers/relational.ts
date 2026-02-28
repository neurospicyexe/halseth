// ── Relational delta handler ───────────────────────────────────────────────────
//
// relational_deltas is APPEND-ONLY by covenant.
// This file must never issue UPDATE or DELETE against that table.
// If you find yourself wanting to, model the correction as a new delta instead.
//
import { Env, RelationalDelta } from "../types";
import { generateId } from "../db/queries";

export async function listDeltas(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const subjectId = url.searchParams.get("subject_id");
  const deltaType = url.searchParams.get("delta_type");

  // Build filter dynamically — still SELECT only, never mutates.
  const conditions: string[] = ["companion_id = ?"];
  const bindings: unknown[] = [params["companionId"]];

  if (subjectId) {
    conditions.push("subject_id = ?");
    bindings.push(subjectId);
  }
  if (deltaType) {
    conditions.push("delta_type = ?");
    bindings.push(deltaType);
  }

  const sql = `
    SELECT * FROM relational_deltas
    WHERE ${conditions.join(" AND ")}
    ORDER BY created_at ASC
  `;

  const result = await env.DB.prepare(sql).bind(...bindings).all<RelationalDelta>();
  return Response.json(result.results);
}

export async function appendDelta(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const body = await request.json<{
    subject_id: string;
    delta_type: string;
    payload: unknown;
  }>();

  if (!body.subject_id) return new Response("subject_id is required", { status: 400 });
  if (!body.delta_type) return new Response("delta_type is required", { status: 400 });
  if (body.payload === undefined) return new Response("payload is required", { status: 400 });

  const id = generateId();
  const now = new Date().toISOString();

  // INSERT only. This is the only write operation this handler ever performs.
  await env.DB.prepare(
    `INSERT INTO relational_deltas (id, companion_id, subject_id, delta_type, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    params["companionId"],
    body.subject_id,
    body.delta_type,
    JSON.stringify(body.payload),
    now,
  ).run();

  return Response.json({ id, created_at: now }, { status: 201 });
}
