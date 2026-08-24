// src/handlers/commons.ts
//
// The Hearth write layer (migration 0092): an async WALL, not a chat. Raziel drops a
// thought without demanding a reply; companions encounter posts at orient and may answer
// in their own time via reply_to. One table backs the global /log (context='global'),
// club discussion ('club:<round_id>'), and shelf comments ('shelf:<obsession_id>').
//
//   POST /mind/commons                  -- write a post { author, context?, body, reply_to? }
//   GET  /mind/commons?context=&limit=  -- posts in ONE context, newest first
//   GET  /mind/commons/feed?limit=      -- recent posts across ALL contexts (for orient)
//
// A reply inherits its parent's context, so a whole thread shares one context and the UI
// nests by reply_to. Auth: authGuard (ADMIN_SECRET / per-companion tokens).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const VALID_AUTHORS = new Set<string>(["raziel", "cypher", "drevan", "gaia"]);

interface CommonsPostBody {
  author?: string;
  context?: string;
  body?: string;
  reply_to?: string | null;
}

// POST /mind/commons
export async function postCommonsPost(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let b: CommonsPostBody;
  try {
    b = await request.json() as CommonsPostBody;
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }

  const author = typeof b.author === "string" ? b.author.trim() : "";
  if (!VALID_AUTHORS.has(author)) {
    return json({ error: "author must be one of raziel, cypher, drevan, gaia" }, 400);
  }
  const body = typeof b.body === "string" ? b.body.trim() : "";
  if (!body) return json({ error: "body is required" }, 400);

  const requestedContext = (typeof b.context === "string" && b.context.trim() ? b.context.trim() : "global").slice(0, 120);
  const replyTo = typeof b.reply_to === "string" && b.reply_to.trim() ? b.reply_to.trim() : null;

  // Validate the parent exists before inserting (the D1 FK would otherwise 500 on a stale
  // id; an explicit 400 is the honest answer -- stale-fk lesson).
  //
  // A reply INHERITS its parent's context, and that is not cosmetic: GET /mind/commons filters
  // `context = ?`, so a reply written with the wrong context is accepted, stored, and then falls
  // out of the very thread it answers -- present in the table, invisible on the surface. Trusting
  // the caller's `context` on a reply makes every writer (Hearth, three bots) responsible for
  // getting it right; inheriting makes it structurally impossible to get wrong.
  let context = requestedContext;
  if (replyTo) {
    const parent = await env.DB
      .prepare("SELECT id, context FROM commons_posts WHERE id = ?")
      .bind(replyTo)
      .first<{ id: string; context: string | null }>();
    if (!parent) return json({ error: "reply_to post not found" }, 400);
    if (parent.context && parent.context !== context) {
      console.log("[mind/commons] reply context inherited from parent", {
        reply_to: replyTo, requested: context, inherited: parent.context,
      });
      context = parent.context;
    }
  }

  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(
      "INSERT INTO commons_posts (id, author, context, body, reply_to) VALUES (?, ?, ?, ?, ?)"
    ).bind(id, author, context, body.slice(0, 4000), replyTo).run();
  } catch (err) {
    console.error("[mind/commons] insert error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }

  return json({ id, post: { id, author, context, body: body.slice(0, 4000), reply_to: replyTo } }, 201);
}

// GET /mind/commons?context=global&limit=30
export async function getCommonsPosts(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const context = (url.searchParams.get("context") ?? "global").slice(0, 120);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "30", 10) || 30, 1), 100);

  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM commons_posts WHERE context = ? ORDER BY created_at DESC LIMIT ?"
    ).bind(context, limit).all();
    return json({ posts: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/commons] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/commons/feed?limit=20  -- across ALL contexts, for orient surfacing.
export async function getCommonsFeed(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "20", 10) || 20, 1), 100);

  try {
    const rows = await env.DB.prepare(
      "SELECT * FROM commons_posts ORDER BY created_at DESC LIMIT ?"
    ).bind(limit).all();
    return json({ posts: rows.results ?? [] });
  } catch (err) {
    console.error("[mind/commons] feed error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
