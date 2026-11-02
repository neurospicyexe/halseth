// src/handlers/keep-off.ts  (mig 0152, Drevan's FERPA point)
//
//   GET  /mind/keep-off               the live list
//   POST /mind/keep-off               { term, note? }   add (idempotent per live term)
//   POST /mind/keep-off/:id/archive   take a term off the list (rows it held back reappear at once)
//
// Raziel's list, so every route takes ADMIN_SECRET exactly (lib/auth.ts isAdminToken): a companion
// token or the static MCP secret can neither read which names are held back nor change the list.
// Rules: src/graph/keep-off.ts.

import type { Env } from "../types.js";
import { isAdminToken } from "../lib/auth.js";
import { addKeepOff, archiveKeepOff, listKeepOff } from "../graph/keep-off.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const DENIED = () => json({ error: "Raziel's list: admin token only" }, 403);

export async function getMindKeepOff(request: Request, env: Env): Promise<Response> {
  if (!isAdminToken(request, env)) return DENIED();
  return json({ terms: await listKeepOff(env) });
}

export async function postMindKeepOff(request: Request, env: Env): Promise<Response> {
  if (!isAdminToken(request, env)) return DENIED();
  let body: { term?: unknown; note?: unknown };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (typeof body.term !== "string") return json({ error: "term is required" }, 400);
  const r = await addKeepOff(env, { term: body.term, note: typeof body.note === "string" ? body.note : null, by: "raziel" });
  if (!r.ok) return json({ ok: false, reason: r.reason }, 422);
  return json({ ok: true, changed: r.changed, term: r.row });
}

export async function postMindKeepOffArchive(request: Request, env: Env, params: { id?: string }): Promise<Response> {
  if (!isAdminToken(request, env)) return DENIED();
  const id = (params.id ?? "").trim();
  if (!id) return json({ error: "id is required" }, 400);
  return json({ ok: true, changed: await archiveKeepOff(env, id) });
}
