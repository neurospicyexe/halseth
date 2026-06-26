// src/handlers/shelf.ts
//
// The obsession shelf (migration 0094, Phase 3): "what Raziel's into" -- his current
// fixations (show/movie/actor/book/...), separate from the voted club rounds. The triad
// reacts via the write layer (commons_posts, context='shelf:<id>'); this handler owns only
// the shelf items themselves. Hearth fetches each item's reactions from /mind/commons.
//
//   POST  /mind/shelf            -- add an item   { title, kind?, note? }
//   GET   /mind/shelf?status=    -- list items (default active)
//   PATCH /mind/shelf/:id        -- { status?: 'active'|'archived', note?, title? }

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_KINDS = new Set<string>(["show", "movie", "actor", "person", "book", "music", "game", "article", "other"]);

// POST /mind/shelf
export async function postObsession(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: { title?: string; kind?: string; note?: string };
  try { b = await request.json() as typeof b; } catch { return json({ error: "invalid JSON body" }, 400); }

  const title = typeof b.title === "string" ? b.title.trim() : "";
  if (!title) return json({ error: "title is required" }, 400);
  const kind = typeof b.kind === "string" && VALID_KINDS.has(b.kind) ? b.kind : "other";
  const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 2000) : null;

  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(
      "INSERT INTO obsession_shelf (id, title, kind, note) VALUES (?, ?, ?, ?)"
    ).bind(id, title.slice(0, 300), kind, note).run();
  } catch (err) {
    console.error("[mind/shelf] insert error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
  return json({ id, item: { id, title, kind, note, status: "active" } }, 201);
}

// GET /mind/shelf?status=active
export async function getObsessions(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const statusParam = url.searchParams.get("status") ?? "active";
  const status = statusParam === "archived" ? "archived" : statusParam === "all" ? null : "active";

  try {
    const rows = status === null
      ? await env.DB.prepare("SELECT * FROM obsession_shelf ORDER BY updated_at DESC LIMIT 100").all()
      : await env.DB.prepare("SELECT * FROM obsession_shelf WHERE status = ? ORDER BY updated_at DESC LIMIT 100").bind(status).all();
    return json({ items: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/shelf] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/shelf/:id
export async function patchObsession(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let b: { status?: string; note?: string; title?: string };
  try { b = await request.json() as typeof b; } catch { return json({ error: "invalid JSON body" }, 400); }

  const sets: string[] = [];
  const binds: unknown[] = [];
  if (b.status === "active" || b.status === "archived") { sets.push("status = ?"); binds.push(b.status); }
  if (typeof b.title === "string" && b.title.trim()) { sets.push("title = ?"); binds.push(b.title.trim().slice(0, 300)); }
  if (typeof b.note === "string") { sets.push("note = ?"); binds.push(b.note.trim().slice(0, 2000) || null); }
  if (sets.length === 0) return json({ error: "nothing to update" }, 400);
  sets.push("updated_at = datetime('now')");

  try {
    const res = await env.DB.prepare(
      `UPDATE obsession_shelf SET ${sets.join(", ")} WHERE id = ?`
    ).bind(...binds, id).run();
    if ((res.meta?.changes ?? 0) === 0) return json({ error: "item not found" }, 404);
    return json({ id, updated: true });
  } catch (err) {
    console.error("[mind/shelf] patch error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
