// src/handlers/pins.ts  (mig 0148, Memory Kit gap 4)
//
//   POST /mind/pin   { companion_id, kind: "conclusion" | "note", id, pinned: true | false }
//   GET  /mind/pins/:companion_id
//
// Raziel's door (Hearth, scripts): pinned_by = 'raziel'. Companions pin through the librarian verb
// (executors/pinning.ts), which records their own id. Same rules for both (webmind/pins.ts): only a
// kept, live row; a cap refusal returns the current pins instead of evicting one.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import type { WmAgentId } from "../webmind/types.js";
import { listPins, parsePinKind, pinRow, unpinRow, PIN_CAP } from "../webmind/pins.js";

const VALID_AGENT_IDS: WmAgentId[] = ["cypher", "drevan", "gaia"];

function isValidAgentId(id: string): id is WmAgentId {
  return (VALID_AGENT_IDS as string[]).includes(id);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function postMindPin(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { companion_id?: unknown; kind?: unknown; id?: unknown; pinned?: unknown };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  const owner = typeof body.companion_id === "string" ? body.companion_id : "";
  const kind = parsePinKind(body.kind);
  const id = typeof body.id === "string" ? body.id.trim() : "";
  if (!isValidAgentId(owner)) return json({ error: "companion_id must be cypher, drevan, or gaia" }, 400);
  if (!kind || !id) return json({ error: 'need kind ("conclusion" | "note") and id' }, 400);
  if (typeof body.pinned !== "boolean") return json({ error: "pinned must be true or false" }, 400);

  if (!body.pinned) {
    const r = await unpinRow(env, { kind, id, owner });
    return json({ ok: true, changed: r.changed, pins: r.pins, cap: PIN_CAP[kind] });
  }
  const r = await pinRow(env, { kind, id, owner, by: "raziel" });
  if (!r.ok) return json({ ok: false, reason: r.reason, pins: r.pins, cap: PIN_CAP[kind] }, r.reason === "not_found" ? 404 : 409);
  return json({ ok: true, changed: r.changed, pins: r.pins, cap: PIN_CAP[kind] });
}

export async function getMindPins(request: Request, env: Env, params: { companion_id?: string }): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const owner = params.companion_id ?? "";
  if (!isValidAgentId(owner)) return json({ error: "companion_id must be cypher, drevan, or gaia" }, 400);
  const [conclusions, notes] = await Promise.all([listPins(env, "conclusion", owner), listPins(env, "note", owner)]);
  return json({ conclusions, notes, caps: PIN_CAP });
}
