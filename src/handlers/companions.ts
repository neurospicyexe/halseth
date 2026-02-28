import { Env, Companion, resolveFlags } from "../types";
import { generateId } from "../db/queries";

export async function listCompanions(
  _request: Request,
  env: Env,
): Promise<Response> {
  const flags = resolveFlags(env);
  if (!flags.companionsEnabled) {
    return new Response("Companion mode is disabled", { status: 403 });
  }

  const result = await env.DB.prepare(
    "SELECT id, name, created_at, config_json FROM companions ORDER BY created_at ASC"
  ).all<Companion>();

  return Response.json(result.results);
}

export async function createCompanion(
  request: Request,
  env: Env,
): Promise<Response> {
  const flags = resolveFlags(env);
  if (!flags.companionsEnabled) {
    return new Response("Companion mode is disabled", { status: 403 });
  }

  const existing = await env.DB.prepare(
    "SELECT COUNT(*) AS count FROM companions"
  ).first<{ count: number }>();

  if (!flags.pluralityEnabled && (existing?.count ?? 0) > 0) {
    return new Response(
      "Plurality is disabled — only one companion allowed",
      { status: 409 }
    );
  }

  const body = await request.json<{ name: string; config?: unknown }>();
  if (!body.name) {
    return new Response("name is required", { status: 400 });
  }

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO companions (id, name, created_at, config_json) VALUES (?, ?, ?, ?)"
  ).bind(
    id,
    body.name,
    now,
    body.config ? JSON.stringify(body.config) : null
  ).run();

  return Response.json({ id, name: body.name, created_at: now }, { status: 201 });
}

export async function getCompanion(
  _request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const companion = await env.DB.prepare(
    "SELECT id, name, created_at, config_json FROM companions WHERE id = ?"
  ).bind(params["id"]).first<Companion>();

  if (!companion) return new Response("Not found", { status: 404 });
  return Response.json(companion);
}
