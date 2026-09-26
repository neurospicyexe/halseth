// Raw HTTP for the imp tray (mig 0132, 2026-09-26) -- Hearth and ops. Companions use the Librarian
// verbs ("my tray", "keep draft <id>", "drop draft <id>"); both doors call webmind/tray.ts.
//
//   GET  /admin/tray?agent=<id>&limit=20
//   POST /admin/tray/review { agent, kind: "journal"|"note", id, decision: "kept"|"dropped", content? }

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { isCompanionId } from "../companions.js";
import { listTray, reviewDraft, parseTrayKind, parseTrayDecision } from "../webmind/tray.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function getAdminTray(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent")?.trim() ?? "";
  if (!isCompanionId(agent)) return json({ error: "agent must be cypher, drevan, or gaia" }, 400);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
  const view = await listTray(env, agent, limit);
  return json(view);
}

export async function postAdminTrayReview(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const agent = typeof body["agent"] === "string" ? body["agent"].trim() : "";
  if (!isCompanionId(agent)) return json({ error: "agent must be cypher, drevan, or gaia" }, 400);
  const kind = parseTrayKind(body["kind"]);
  if (!kind) return json({ error: 'kind must be "journal" or "note"' }, 400);
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  if (!id) return json({ error: "id is required" }, 400);
  const decision = parseTrayDecision(body["decision"]);
  if (!decision) return json({ error: 'decision must be "kept" or "dropped"' }, 400);
  const content = typeof body["content"] === "string" ? body["content"] : null;

  const r = await reviewDraft(env, { agent, kind, id, decision, content });
  if (!r.ok) {
    if (r.reason === "not_found") return json({ error: "not found (or not this agent's row)" }, 404);
    if (r.reason === "bad_id") return json({ error: "id must be the full id or a prefix of at least 8 characters (letters, digits, - or _)" }, 400);
    if (r.reason === "ambiguous") return json({ error: "ambiguous id prefix -- nothing changed; use more of the id", matches: r.matches }, 409);
    return json({ error: "content, when given, must be non-empty" }, 400);
  }
  return json(r);
}
