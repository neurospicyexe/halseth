// Basins that move (mig 0172).
//   GET  /mind/basins/:companion_id         live rows + history (superseded / declined / awaiting) with causes,
//                                           descriptions included (the companion's own words, read by Hearth). Same auth as other /mind reads.
//   POST /mind/basins/:id/witness           { decision: "witness" | "decline", note? }  RAZIEL ONLY (ADMIN_SECRET exactly).
// A companion token is refused on the witness route; a companion never witnesses their own revision, and
// Raziel never authors one: the only writer is the Librarian revise verb (caller = the request companion). The one other
// HTTP basin write, POST /companion-growth/basins, is seed-only and refuses once a companion has any basin.

import type { Env } from "../types.js";
import { authGuard, isAdminToken } from "../lib/auth.js";
import { BASIN_COMPANIONS, readBasinsFull, decideWitness, type BasinCompanion } from "../webmind/basins.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function getMindBasins(request: Request, env: Env, params: { companion_id?: string }): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params.companion_id ?? "";
  if (!(BASIN_COMPANIONS as readonly string[]).includes(id)) return json({ error: "companion_id must be cypher, drevan, or gaia" }, 400);
  try {
    return json(await readBasinsFull(env, id as BasinCompanion));
  } catch (err) {
    console.error("[basins] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function postBasinWitness(request: Request, env: Env, params: { id?: string }): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  if (!isAdminToken(request, env)) return json({ error: "forbidden: only Raziel witnesses a basin move" }, 403);
  let body: { decision?: unknown; note?: unknown };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (body.decision !== "witness" && body.decision !== "decline") return json({ error: 'decision must be "witness" or "decline"' }, 400);
  const note = typeof body.note === "string" ? body.note : null;
  try {
    const r = await decideWitness(env, { id: params.id ?? "", decision: body.decision, note });
    if (!r.ok) {
      const status = r.code === "not_found" ? 404 : r.code === "needs_migration" ? 409 : 409;
      return json({ ok: false, code: r.code, error: r.message }, status);
    }
    return json({ ok: true, decision: body.decision, id: r.id, superseded: r.superseded, message: r.message });
  } catch (err) {
    console.error("[basins] witness error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
