// graph/labels.ts -- human-readable labels for graph nodes that back onto a titled row.
//
// A node id alone renders as "watch_shelf/a1b2c3d4"; the whole point of a graph line is "-> Fargo".
// Scoped to the two title-bearing tables the `mentions` edges (rebuild source e) can point at; every
// other table keeps its id-shortened fallback. Best-effort by contract: any failure degrades to an
// empty map and the renderer falls back to ids -- it never throws and never blocks an orient.
// Shared by the director neighborhood endpoint (handlers/director.ts) and the Claude.ai orient
// (executors/session.ts) so both surfaces name the same node the same way.
import type { Env } from "../types.js";

export interface EdgeEndpoints { src_table: string; src_id: string; dst_table: string; dst_id: string }

/** Human-readable labels for neighborhood nodes that back onto a titled shelf row -- a node id alone
 *  renders as "watch_shelf/a1b2c3d4", the whole point of a graph line is "-> Fargo" instead. Scoped to
 *  the two title-bearing tables the `mentions` edges (graph rebuild) can point at; every other table
 *  keeps the old id-shortened fallback. Best-effort: any failure degrades to an empty map (renderEdgeLines
 *  falls back to the id label), it never throws and never blocks the neighborhood response. */
export async function loadTitleLabels(
  env: Env,
  edges: ReadonlyArray<EdgeEndpoints>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  const idsByTable = new Map<string, Set<string>>([["watch_shelf", new Set()], ["obsession_shelf", new Set()]]);
  for (const e of edges) {
    for (const [t, id] of [[e.src_table, e.src_id], [e.dst_table, e.dst_id]] as const) {
      idsByTable.get(t)?.add(id);
    }
  }
  for (const [table, idSet] of idsByTable) {
    if (idSet.size === 0) continue;
    try {
      const ids = [...idSet];
      const placeholders = ids.map(() => "?").join(",");
      const rows = await env.DB.prepare(
        `SELECT id, title FROM ${table} WHERE id IN (${placeholders})`
      ).bind(...ids).all<{ id: string; title: string }>();
      for (const r of rows.results ?? []) labels.set(`${table}/${r.id}`, r.title);
    } catch (err) {
      console.warn("[graph/labels] title label lookup failed, falling back to id labels", { table, error: String(err) });
    }
  }
  return labels;
}
