// src/handlers/links.ts  (M4, mig 0151)
//
//   POST /mind/link   { src: { table | kind, id | quote }, dst: { ... }, why? }       -> link
//                     { unlink: true, link_id }  or  { unlink: true, src, dst }        -> unlink
//   GET  /mind/links/:writer   (raziel | cypher | drevan | gaia)
//
// Raziel's door (Hearth's map panel). writer is ALWAYS 'raziel' here: this route can neither make
// nor remove a companion's link -- theirs are theirs (Drevan, 10-28: "his graph is his"; the same
// holds the other way). POST takes ADMIN_SECRET ONLY -- the token Hearth holds as HALSETH_SECRET --
// never a companion token and never MCP_AUTH_SECRET (static MCP callers hold that one): authGuard
// passes both, and a bot holding its own token could otherwise make links as raziel or unlink
// Raziel's with nobody present. Holding the admin token is the presence that lets unlink run here
// (via 'hearth'). Not quite "only Hearth holds it": the VPS bot process also holds it as clerkSecret
// for writeLedger (STATUS B41), so the boundary is that bot CODE sends it only on the ledger path --
// a model-driven bot turn cannot reach this door. Companions link through the librarian verb
// (executors/links.ts).

import type { Env } from "../types.js";
import { authGuard, isAdminToken } from "../lib/auth.js";
import { LINK_WRITERS, listLinks, makeLink, removeLink, type LinkEnd, type LinkWriter } from "../graph/links.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function end(v: unknown): LinkEnd | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  const s = (k: string) => (typeof o[k] === "string" && (o[k] as string).trim() ? (o[k] as string).trim() : undefined);
  const e: LinkEnd = { table: s("table"), kind: s("kind"), id: s("id"), quote: s("quote"), owner: s("owner") };
  return (e.table || e.kind) && (e.id || e.quote) ? e : null;
}

export async function postMindLink(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  if (!isAdminToken(request, env)) return json({ error: "this door writes as Raziel; companions link through the librarian verb" }, 403);
  let body: Record<string, unknown>;
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const surface = typeof body.surface === "string" ? body.surface : "hearth";

  if (body.unlink === true) {
    const linkId = typeof body.link_id === "string" ? body.link_id.trim() : undefined;
    const src = end(body.src), dst = end(body.dst);
    if (!linkId && !(src && dst)) return json({ error: "need link_id, or src and dst" }, 400);
    const r = await removeLink(env, { writer: "raziel", via: "hearth", surface, linkId, src: src ?? undefined, dst: dst ?? undefined });
    if (!r.ok) return json({ ok: false, reason: r.reason }, 400);
    return json({ ok: true, changed: r.changed, link: r.link ?? null });
  }

  const src = end(body.src), dst = end(body.dst);
  if (!src || !dst) return json({ error: "need src and dst, each { table | kind, id | quote }" }, 400);
  const why = typeof body.why === "string" ? body.why : null;
  const r = await makeLink(env, { writer: "raziel", src, dst, why, via: "hearth", surface });
  // A refusal (no match, several matches, same row twice, why too long) changes nothing and says why.
  if (!r.ok) return json({ ok: false, reason: r.reason }, 422);
  return json({ ok: true, changed: r.changed, link: r.link, src: r.src, dst: r.dst });
}

export async function getMindLinks(request: Request, env: Env, params: { writer?: string }): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const w = params.writer ?? "";
  if (!(LINK_WRITERS as readonly string[]).includes(w)) return json({ error: "writer must be raziel, cypher, drevan, or gaia" }, 400);
  return json({ links: await listLinks(env, w as LinkWriter) });
}
