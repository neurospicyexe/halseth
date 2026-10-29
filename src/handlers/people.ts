// src/handlers/people.ts  (mig 0149, memory map M5)
//
//   GET  /mind/people               the list, each with how many kept rows the graph links to them
//   POST /mind/people               { label, match_names?: string[], kind?, pk_member_id?, note? }
//   POST /mind/people/:id/archive   take someone off the list (their links drop at the next rebuild)
//
// Raziel's door (Hearth): added_by = 'raziel'. Links appear at the next nightly rebuild, or at once
// with POST /admin/graph/rebuild.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { addPerson, archivePerson, frontsOf, listPeople } from "../graph/people.js";
import { KEPT_SQL } from "../webmind/review-state.js";

// Counted the way the map shows them: only links whose source row is visible (kept, not archived,
// not superseded, an active fact). The rebuild derives from every row, drafts included, so a raw
// edge count would promise links the map then hides when Raziel taps through. Returned per edge
// (dst + provenance) so a system name can be credited with the fronts it rode in on.
const VISIBLE_MENTIONS_SQL = `
  SELECT g.dst_id, g.provenance FROM graph_edges g
   WHERE g.dst_table = 'graph_people' AND (
     g.src_table = 'companion_relational_state'
  OR (g.src_table = 'architect_facts' AND EXISTS (SELECT 1 FROM architect_facts f WHERE f.id = g.src_id AND f.status = 'active'))
  OR
     (g.src_table = 'companion_journal' AND EXISTS (SELECT 1 FROM companion_journal j WHERE j.id = g.src_id AND j.archived = 0 AND j.${KEPT_SQL}))
  OR (g.src_table = 'wm_continuity_notes' AND EXISTS (SELECT 1 FROM wm_continuity_notes n WHERE n.note_id = g.src_id AND n.archived = 0 AND n.${KEPT_SQL}))
  OR (g.src_table = 'companion_conclusions' AND EXISTS (SELECT 1 FROM companion_conclusions c WHERE c.id = g.src_id AND c.archived = 0 AND c.superseded_by IS NULL)))`;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function getMindPeople(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const [people, rows] = await Promise.all([
    listPeople(env),
    env.DB.prepare(VISIBLE_MENTIONS_SQL).all<{ dst_id: string; provenance: string }>().then((r) => r.results ?? []),
  ]);
  // A node's count is its links; a system name's count is the links that carry it as the front
  // (they all point at the centre, which counts every one of them as its own).
  const byNode = new Map<string, number>();
  const byFront = new Map<string, number>();
  for (const r of rows) {
    byNode.set(r.dst_id, (byNode.get(r.dst_id) ?? 0) + 1);
    for (const f of frontsOf(r.provenance)) byFront.set(f, (byFront.get(f) ?? 0) + 1);
  }
  return json({ people: people.map((p) => ({ ...p, mentions: p.kind === "self" ? (byFront.get(p.label) ?? 0) : (byNode.get(p.id) ?? 0) })) });
}

export async function postMindPeople(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: { label?: unknown; match_names?: unknown; kind?: unknown; pk_member_id?: unknown; note?: unknown };
  try { body = await request.json(); } catch { return json({ error: "invalid JSON" }, 400); }
  if (typeof body.label !== "string") return json({ error: "label is required" }, 400);
  const r = await addPerson(env, {
    label: body.label,
    match_names: Array.isArray(body.match_names) ? body.match_names.filter((x): x is string => typeof x === "string") : [],
    kind: typeof body.kind === "string" ? body.kind : undefined,
    pk_member_id: typeof body.pk_member_id === "string" ? body.pk_member_id : null,
    note: typeof body.note === "string" ? body.note : null,
    added_by: "raziel",
  });
  return r.ok ? json({ ok: true, person: r.person }) : json({ ok: false, error: r.reason }, 409);
}

export async function postMindPersonArchive(request: Request, env: Env, params: { id?: string }): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params.id ?? "";
  if (!id) return json({ error: "id required" }, 400);
  return (await archivePerson(env, id)) ? json({ ok: true }) : json({ ok: false, error: "not found" }, 404);
}
