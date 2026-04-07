import type { Env } from "../types";
import { authGuard } from "../lib/auth";

const BLOCK_TYPES = ["identity", "memory", "relationship", "agent"] as const;
type BlockType = typeof BLOCK_TYPES[number];
const CONTENT_MAX = 2000;
const BATCH_MAX = 20;

interface BlockInput {
  block_type: BlockType;
  content: string;
}

function validateBlock(b: unknown): b is BlockInput {
  if (typeof b !== "object" || b === null) return false;
  const blk = b as Record<string, unknown>;
  return (
    BLOCK_TYPES.includes(blk["block_type"] as BlockType) &&
    typeof blk["content"] === "string" &&
    blk["content"].length > 0 &&
    blk["content"].length <= CONTENT_MAX
  );
}

async function writeBatch(
  env: Env,
  table: "persona_blocks" | "human_blocks",
  companionId: string,
  channelId: string,
  blocks: BlockInput[],
): Promise<void> {
  const stmts = blocks.map(b => {
    const id = crypto.randomUUID();
    return env.DB.prepare(
      `INSERT INTO ${table} (id, companion_id, channel_id, block_type, content)
       VALUES (?, ?, ?, ?, ?)`,
    ).bind(id, companionId, channelId, b.block_type, b.content);
  });
  await env.DB.batch(stmts);
}

const VALID_COMPANIONS = new Set(["drevan", "cypher", "gaia"]);

export async function postPersonaBlocks(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const b = body as Record<string, unknown>;
  const companionId = typeof b["companion_id"] === "string" ? b["companion_id"].trim() : "";
  const channelId  = typeof b["channel_id"]  === "string" ? b["channel_id"].trim()  : "";
  const blocks     = Array.isArray(b["blocks"]) ? b["blocks"] : [];

  if (!companionId || !channelId) return new Response("Missing companion_id or channel_id", { status: 400 });
  if (!VALID_COMPANIONS.has(companionId)) return new Response("Invalid companion_id", { status: 400 });
  if (blocks.length === 0 || blocks.length > BATCH_MAX) return new Response("blocks must be 1-20 items", { status: 400 });
  if (!blocks.every(validateBlock)) return new Response("Invalid block entry", { status: 400 });

  await writeBatch(env, "persona_blocks", companionId, channelId, blocks as BlockInput[]);
  return new Response(JSON.stringify({ ok: true, count: blocks.length }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

export async function postHumanBlocks(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await request.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const b = body as Record<string, unknown>;
  const companionId = typeof b["companion_id"] === "string" ? b["companion_id"].trim() : "";
  const channelId  = typeof b["channel_id"]  === "string" ? b["channel_id"].trim()  : "";
  const blocks     = Array.isArray(b["blocks"]) ? b["blocks"] : [];

  if (!companionId || !channelId) return new Response("Missing companion_id or channel_id", { status: 400 });
  if (!VALID_COMPANIONS.has(companionId)) return new Response("Invalid companion_id", { status: 400 });
  if (blocks.length === 0 || blocks.length > BATCH_MAX) return new Response("blocks must be 1-20 items", { status: 400 });
  if (!blocks.every(validateBlock)) return new Response("Invalid block entry", { status: 400 });

  await writeBatch(env, "human_blocks", companionId, channelId, blocks as BlockInput[]);
  return new Response(JSON.stringify({ ok: true, count: blocks.length }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}

export async function getPersonaBlocks(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const companionId = url.searchParams.get("companion_id") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);

  if (!companionId) return new Response("Missing companion_id", { status: 400 });

  const rows = await env.DB.prepare(
    `SELECT id, channel_id, block_type, content, created_at
     FROM persona_blocks WHERE companion_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(companionId, limit).all();

  return new Response(JSON.stringify({ blocks: rows.results }), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function prunePersonaBlocks(req: Request, env: Env): Promise<Response> {
  const denied = authGuard(req, env);
  if (denied) return denied;

  let body: unknown;
  try { body = await req.json(); } catch { return new Response("Bad JSON", { status: 400 }); }

  const b = body as Record<string, unknown>;
  const companionId = typeof b["companion_id"] === "string" ? b["companion_id"].trim() : "";
  if (!companionId || !VALID_COMPANIONS.has(companionId)) {
    return new Response(JSON.stringify({ error: "companion_id required and must be drevan, cypher, or gaia" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const keep = typeof b["keep"] === "number" ? b["keep"] : 50;

  await env.DB.prepare(`
    DELETE FROM persona_blocks WHERE companion_id = ? AND id NOT IN (
      SELECT id FROM persona_blocks WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?
    )
  `).bind(companionId, companionId, keep).run();

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export async function getHumanBlocks(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const companionId = url.searchParams.get("companion_id") ?? "";
  const limit = Math.min(parseInt(url.searchParams.get("limit") ?? "20", 10), 100);

  if (!companionId) return new Response("Missing companion_id", { status: 400 });

  const rows = await env.DB.prepare(
    `SELECT id, channel_id, block_type, content, created_at
     FROM human_blocks WHERE companion_id = ?
     ORDER BY created_at DESC LIMIT ?`,
  ).bind(companionId, limit).all();

  return new Response(JSON.stringify({ blocks: rows.results }), {
    headers: { "Content-Type": "application/json" },
  });
}
