import { Env, MemoryEntry } from "../types";
import { generateId } from "../db/queries";

export async function listMemories(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const url = new URL(request.url);
  const tier = url.searchParams.get("tier");

  let stmt: D1PreparedStatement;
  if (tier !== null) {
    stmt = env.DB.prepare(
      "SELECT * FROM memories WHERE companion_id = ? AND tier = ? ORDER BY created_at DESC"
    ).bind(params["companionId"], Number(tier));
  } else {
    stmt = env.DB.prepare(
      "SELECT * FROM memories WHERE companion_id = ? ORDER BY created_at DESC"
    ).bind(params["companionId"]);
  }

  const result = await stmt.all<MemoryEntry>();
  return Response.json(result.results);
}

export async function createMemory(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const body = await request.json<{
    content: string;
    tier?: number;
    session_id?: string;
    tags?: string[];
  }>();

  if (!body.content) return new Response("content is required", { status: 400 });

  const id = generateId();
  const now = new Date().toISOString();
  const tier = body.tier ?? 1;

  await env.DB.prepare(
    `INSERT INTO memories (id, companion_id, session_id, tier, content, tags_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    id,
    params["companionId"],
    body.session_id ?? null,
    tier,
    body.content,
    body.tags ? JSON.stringify(body.tags) : null,
    now,
  ).run();

  return Response.json({ id, tier, created_at: now }, { status: 201 });
}

export async function getMemory(
  _request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const entry = await env.DB.prepare(
    "SELECT * FROM memories WHERE id = ? AND companion_id = ?"
  ).bind(params["memoryId"], params["companionId"]).first<MemoryEntry>();

  if (!entry) return new Response("Not found", { status: 404 });
  return Response.json(entry);
}
