// src/graph/map.ts -- the memory MAP read (docs/PLAN-memory-map-2026-10-28.md, slice M1).
//
// Raziel, 10-28: graph memory was meant to be a map you can LOOK at, Obsidian-style, "showing the
// connections instead of telling". graph_edges held 60k edges and nothing drew them; every node but
// two shelf tables rendered as an id. This module is the read behind Hearth /map: a bounded
// neighborhood with a NAME on every node and the WRITER on every edge (whose connection it is).
//
// Rules, each one load-bearing:
//   - VISIBLE ROWS ONLY. A node is returned only if its row is one a reader may see: kept (never a
//     tray draft -- rebuild reads companion_journal without a review filter, so graph_edges DOES point
//     at drafts), not archived/released, not superseded. A node that fails is DROPPED with its edges,
//     never rendered as a bare id.
//   - SEALED LANE. The 0126 sealed table never enters (same guard as traverse.ts, spelled the same way).
//   - BOUNDED. Per-node edge cap, node cap, hop cap. Never the hairball.
//   - READS WARM NOTHING (hard law 1). No UPDATE anywhere in this file.
//   - `follows` (the float-move chain, 23k edges that draw as one long string) is left out unless the
//     center itself is a float move.
//
// Labels are short (<= LABEL_CHARS); `text` (up to TEXT_CHARS) is the body for the tap panel, only for
// the same visible rows.

import type { Env } from "../types.js";
import { KEPT_SQL } from "../webmind/review-state.js";
import { FLOAT_LABELS } from "../webmind/fermentation.js";
import { keepOffMatcher, rowNamesKeptOff } from "./keep-off.js";

const SEALED_TABLE = ["sibling", "notes"].join("_");
const LABEL_CHARS = 72;
const TEXT_CHARS = 700;
export const MAP_MAX_NODES = 250;
const PER_NODE_EDGES = 12;
const ID_CHUNK = 40;

export type MapReader = "cypher" | "drevan" | "gaia" | "raziel";

export interface MapNode {
  key: string;            // "<table>/<id>"
  table: string;
  id: string;
  kind: string;           // human kind: conclusion, note, journal, session, ...
  label: string;
  text: string | null;
  owner: string | null;   // companion id, 'raziel', or null (shared)
  created_at: string | null;
  pinned: boolean;
  seed: boolean;
}

/** `why` is the writer's own words on a mind's link (M4, provenance 'asserted'); null on derived edges. */
export interface MapEdge { src: string; dst: string; type: string; writer: string; provenance: string; created_at: string; why: string | null }

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const day = (s: unknown) => String(s ?? "").slice(0, 10);
const num = (v: unknown) => (typeof v === "number" ? v.toFixed(2) : "?");

interface Spec {
  kind: string;
  /** SELECT list; must yield `id`; may yield owner/created_at/pinned_at plus fields `label` reads. */
  select: string;
  from: string;
  /** Visibility predicate (rows failing it are dropped). Columns unqualified, `t.` prefixed when joined. */
  where?: string;
  /** SQL for the node id when it is not `t.id` (wm_continuity_notes' note_id, wm_mind_threads' composite). */
  idCol?: string;
  label: (r: Record<string, unknown>) => string;
  text?: (r: Record<string, unknown>) => string | null;
}

function floatName(companion: unknown, key: unknown): string {
  const labels: readonly string[] | undefined = FLOAT_LABELS[companion as keyof typeof FLOAT_LABELS];
  const i = key === "soma_float_1" ? 0 : key === "soma_float_2" ? 1 : key === "soma_float_3" ? 2 : -1;
  return labels && i >= 0 ? labels[i]! : String(key ?? "float");
}

const SPECS: Record<string, Spec> = {
  companion_conclusions: {
    kind: "conclusion", from: "companion_conclusions t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.pinned_at, t.conclusion_text AS body",
    where: "t.superseded_by IS NULL AND t.archived = 0",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  wm_continuity_notes: {
    kind: "note", from: "wm_continuity_notes t",
    select: "t.note_id AS id, t.agent_id AS owner, t.created_at, t.pinned_at, t.content AS body",
    where: `t.archived = 0 AND t.${KEPT_SQL}`,
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  companion_journal: {
    kind: "journal", from: "companion_journal t",
    select: "t.id, t.agent AS owner, t.created_at, t.note_text AS body",
    where: `t.archived = 0 AND t.${KEPT_SQL}`,
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  sessions: {
    kind: "session", from: "sessions t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.session_type",
    label: (r) => `session ${day(r.created_at)}${r.session_type ? ` (${r.session_type})` : ""}`,
  },
  handover_packets: {
    kind: "handover", from: "handover_packets t LEFT JOIN sessions s ON s.id = t.session_id",
    select: "t.id, s.companion_id AS owner, t.created_at, t.last_real_thing, t.spine",
    where: "COALESCE(t.spine, '') NOT LIKE '[auto]%'",
    label: (r) => `close ${day(r.created_at)}: ${clip(r.last_real_thing || r.spine, LABEL_CHARS - 17)}`,
    text: (r) => clip([r.spine, r.last_real_thing].filter(Boolean).join(" -- "), TEXT_CHARS),
  },
  companion_soma_events: {
    kind: "felt move", from: "companion_soma_events t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.float_key, t.before_value, t.after_value, t.kind AS move_kind, t.detail",
    label: (r) => `${floatName(r.owner, r.float_key)} ${num(r.before_value)} -> ${num(r.after_value)} (${String(r.move_kind ?? "").replace("_", " ")})`,
    text: (r) => (r.detail ? clip(r.detail, TEXT_CHARS) : null),
  },
  companion_ferment_events: {
    kind: "ferment", from: "companion_ferment_events t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.kind AS fkind, t.stimulus",
    label: (r) => (r.stimulus ? `stimulus: ${clip(r.stimulus, LABEL_CHARS - 10)}` : `settling (${r.fkind ?? "tick"})`),
  },
  companion_soma_shifts: {
    kind: "drift shift", from: "companion_soma_shifts t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.label AS shift_label, t.reason",
    label: (r) => `drift: ${clip(r.shift_label || r.reason, LABEL_CHARS - 7)}`, text: (r) => clip(r.reason, TEXT_CHARS),
  },
  inter_companion_notes: {
    kind: "letter", from: "inter_companion_notes t",
    select: "t.id, t.from_id AS owner, t.created_at, t.to_id, t.content AS body",
    label: (r) => `${r.owner} -> ${r.to_id ?? "triad"}: ${clip(r.body, LABEL_CHARS - 18)}`, text: (r) => clip(r.body, TEXT_CHARS),
  },
  companions: {
    kind: "companion", from: "companions t",
    select: "t.id, t.id AS owner, t.created_at, t.name",
    label: (r) => String(r.name ?? r.id),
  },
  companion_tensions: {
    kind: "tension", from: "companion_tensions t",
    select: "t.id, t.companion_id AS owner, t.first_noted_at AS created_at, t.tension_text AS body, t.status",
    label: (r) => `${r.status === "released" ? "(released) " : ""}${clip(r.body, LABEL_CHARS)}`, text: (r) => clip(r.body, TEXT_CHARS),
  },
  companion_questions: {
    kind: "question", from: "companion_questions t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.question AS body",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  watch_shelf: {
    kind: "watching", from: "watch_shelf t",
    select: "t.id, 'raziel' AS owner, t.created_at, t.title, t.status",
    label: (r) => `${r.title}${r.status && r.status !== "watching" ? ` (${r.status})` : ""}`,
  },
  obsession_shelf: {
    kind: "obsession", from: "obsession_shelf t",
    select: "t.id, 'raziel' AS owner, t.created_at, t.title, t.note",
    label: (r) => String(r.title ?? ""), text: (r) => (r.note ? clip(r.note, TEXT_CHARS) : null),
  },
  commons_posts: {
    kind: "commons", from: "commons_posts t",
    select: "t.id, t.author AS owner, t.created_at, t.body",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  autonomy_reflections: {
    kind: "reflection", from: "autonomy_reflections t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.reflection_text AS body",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  forage_finds: {
    kind: "find", from: "forage_finds t",
    select: "t.id, t.companion_id AS owner, t.gathered_at AS created_at, t.title, t.summary",
    label: (r) => clip(r.title, LABEL_CHARS), text: (r) => (r.summary ? clip(r.summary, TEXT_CHARS) : null),
  },
  autonomy_runs: {
    kind: "own time", from: "autonomy_runs t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.run_type",
    label: (r) => `${String(r.run_type ?? "run").replace(/_/g, " ")} ${day(r.created_at)}`,
  },
  // M5 (2026-10-28): the companions' own projects, their log, and the mind threads notes belong to.
  companion_projects: {
    kind: "project", from: "companion_projects t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.title, t.status, t.intention",
    label: (r) => `${r.title}${r.status && r.status !== "open" ? ` (${r.status})` : ""}`,
    text: (r) => (r.intention ? clip(r.intention, TEXT_CHARS) : null),
  },
  project_log: {
    kind: "project log", from: "project_log t",
    select: "t.id, t.companion_id AS owner, t.created_at, t.entry AS body",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  wm_mind_threads: {
    kind: "thread", from: "wm_mind_threads t", idCol: "(t.agent_id || ':' || t.thread_key)",
    select: "(t.agent_id || ':' || t.thread_key) AS id, t.agent_id AS owner, t.created_at, t.title, t.status",
    label: (r) => `${r.title}${r.status && r.status !== "open" ? ` (${r.status})` : ""}`,
  },
  // mig 0150: what the centre's links come from (rebuild lane m).
  architect_facts: {
    kind: "fact", from: "architect_facts t",
    select: "t.id, COALESCE(t.companion_id, 'house') AS owner, t.created_at, t.fact AS body",
    where: "t.status = 'active'",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  companion_relational_state: {
    kind: "how I stand", from: "companion_relational_state t",
    select: "t.id, t.companion_id AS owner, t.noted_at AS created_at, t.state_text AS body",
    label: (r) => clip(r.body, LABEL_CHARS), text: (r) => clip(r.body, TEXT_CHARS),
  },
  graph_people: {
    kind: "person", from: "graph_people t",
    select: "t.id, 'raziel' AS owner, t.created_at, t.label, t.kind AS person_kind, t.note",
    where: "t.archived = 0",
    label: (r) => String(r.label ?? ""), text: (r) => (r.note ? clip(r.note, TEXT_CHARS) : null),
  },
  relational_deltas: {
    kind: "moment", from: "relational_deltas t",
    select: "t.id, COALESCE(NULLIF(t.companion_id, ''), t.agent) AS owner, t.created_at, t.delta_text AS body, t.delta_type",
    label: (r) => clip(r.body || r.delta_type, LABEL_CHARS), text: (r) => (r.body ? clip(r.body, TEXT_CHARS) : null),
  },
};

export const MAP_TABLES = Object.keys(SPECS);

const key = (table: string, id: string) => `${table}/${id}`;

/** Names and visibility for a set of nodes. Unknown tables and rows that fail visibility are absent,
 *  and so is any row naming a term on Raziel's keep-off list (mig 0152, graph/keep-off.ts). This is
 *  the one labeler behind the map, links and the [Linked] boot block, so all three lose it at once. */
export async function loadMapNodes(env: Env, refs: Array<{ table: string; id: string }>): Promise<Map<string, MapNode>> {
  const out = new Map<string, MapNode>();
  let keepOff: RegExp | null;
  try {
    keepOff = await keepOffMatcher(env);
  } catch (err) {
    // Fail closed: a list we cannot read might be holding a child's name back. Draw nothing.
    console.warn("[graph/map] keep-off list unreadable; returning no nodes", { error: String(err) });
    return out;
  }
  const byTable = new Map<string, Set<string>>();
  for (const r of refs) {
    if (r.table === SEALED_TABLE || !SPECS[r.table]) continue;
    (byTable.get(r.table) ?? byTable.set(r.table, new Set()).get(r.table)!).add(r.id);
  }
  for (const [table, idSet] of byTable) {
    const spec = SPECS[table]!;
    const ids = [...idSet];
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const idCol = spec.idCol ?? (table === "wm_continuity_notes" ? "t.note_id" : "t.id");
      const sql = `SELECT ${spec.select} FROM ${spec.from} WHERE ${idCol} IN (${chunk.map(() => "?").join(",")})${spec.where ? ` AND ${spec.where}` : ""}`;
      try {
        const rows = (await env.DB.prepare(sql).bind(...chunk).all<Record<string, unknown>>()).results ?? [];
        for (const r of rows) {
          const id = String(r.id);
          if (keepOff) {
            const { id: _id, owner: _o, created_at: _c, pinned_at: _p, ...words } = r;
            if (rowNamesKeptOff(words, keepOff)) continue;
          }
          out.set(key(table, id), {
            key: key(table, id), table, id, kind: spec.kind,
            label: spec.label(r) || spec.kind,
            text: spec.text ? spec.text(r) : null,
            owner: r.owner == null ? null : String(r.owner),
            created_at: r.created_at == null ? null : String(r.created_at),
            pinned: !!r.pinned_at, seed: false,
          });
        }
      } catch (err) {
        console.warn("[graph/map] node load failed (dropped, not guessed)", { table, error: String(err) });
      }
    }
  }
  return out;
}

interface EdgeRow { src_table: string; src_id: string; dst_table: string; dst_id: string; edge_type: string; writer: string; provenance: string; created_at: string; why: string | null }

/** Edges touching any of the refs, newest first, at most PER_NODE_EDGES per ref per direction. */
async function edgesAround(env: Env, refs: Array<{ table: string; id: string }>, withFollows: boolean): Promise<EdgeRow[]> {
  const byTable = new Map<string, string[]>();
  for (const r of refs) if (r.table !== SEALED_TABLE) (byTable.get(r.table) ?? byTable.set(r.table, []).get(r.table)!).push(r.id);
  const follows = withFollows ? "" : "AND edge_type != 'follows'";
  const out: EdgeRow[] = [];
  for (const [table, ids] of byTable) {
    for (let i = 0; i < ids.length; i += ID_CHUNK) {
      const chunk = ids.slice(i, i + ID_CHUNK);
      const ph = chunk.map(() => "?").join(",");
      for (const side of ["src", "dst"] as const) {
        const rows = (await env.DB.prepare(
          `SELECT src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at,
                  CASE WHEN provenance = 'asserted' THEN (SELECT l.why FROM graph_links l WHERE l.edge_id = x.id AND l.unlinked_at IS NULL) END AS why
             FROM (
             SELECT g.*, ROW_NUMBER() OVER (PARTITION BY g.${side}_id ORDER BY g.created_at DESC, g.id) AS rn
               FROM graph_edges g
              WHERE g.${side}_table = ? AND g.${side}_id IN (${ph})
                AND g.src_table != ? AND g.dst_table != ? ${follows}
           ) x WHERE rn <= ?`,
        ).bind(table, ...chunk, SEALED_TABLE, SEALED_TABLE, PER_NODE_EDGES).all<EdgeRow>()).results ?? [];
        out.push(...rows);
      }
    }
  }
  return out;
}

/** The default view: the reader's own things (or everyone's, for Raziel). */
async function defaultSeeds(env: Env, reader: MapReader): Promise<Array<{ table: string; id: string }>> {
  const who = reader === "raziel" ? ["cypher", "drevan", "gaia"] : [reader];
  const per = reader === "raziel" ? 12 : 30;
  const seeds: Array<{ table: string; id: string }> = [];
  for (const c of who) {
    const q = async (table: string, sql: string, n: number) =>
      ((await env.DB.prepare(sql).bind(c, n).all<{ id: string }>()).results ?? []).forEach((r) => seeds.push({ table, id: r.id }));
    await q("companion_conclusions", "SELECT id FROM companion_conclusions WHERE companion_id = ? AND superseded_by IS NULL AND archived = 0 ORDER BY (pinned_at IS NULL), heat DESC LIMIT ?", per);
    await q("wm_continuity_notes", `SELECT note_id AS id FROM wm_continuity_notes WHERE agent_id = ? AND archived = 0 AND ${KEPT_SQL} ORDER BY (pinned_at IS NULL), created_at DESC LIMIT ?`, Math.ceil(per / 3));
    await q("companion_journal", `SELECT id FROM companion_journal WHERE agent = ? AND archived = 0 AND ${KEPT_SQL} ORDER BY created_at DESC LIMIT ?`, Math.ceil(per / 2));
    await q("companion_tensions", "SELECT id FROM companion_tensions WHERE companion_id = ? AND status != 'released' ORDER BY first_noted_at DESC LIMIT ?", 6);
  }
  ((await env.DB.prepare("SELECT id FROM watch_shelf WHERE status IN ('watching','paused') ORDER BY last_watched_at DESC LIMIT 10").all<{ id: string }>()).results ?? [])
    .forEach((r) => seeds.push({ table: "watch_shelf", id: r.id }));
  ((await env.DB.prepare("SELECT id FROM obsession_shelf WHERE status = 'active' ORDER BY updated_at DESC LIMIT 10").all<{ id: string }>()).results ?? [])
    .forEach((r) => seeds.push({ table: "obsession_shelf", id: r.id }));
  return seeds;
}

export interface MapResult { nodes: MapNode[]; edges: MapEdge[]; truncated: boolean; center: string | null }

export async function buildMap(env: Env, opts: { reader: MapReader; center?: { table: string; id: string } | null; hops?: 1 | 2; max?: number }): Promise<MapResult> {
  const max = Math.min(opts.max ?? MAP_MAX_NODES, MAP_MAX_NODES);
  const hops = opts.hops === 2 ? 2 : 1;
  const center = opts.center && opts.center.table !== SEALED_TABLE ? opts.center : null;
  const seeds = center ? [center] : await defaultSeeds(env, opts.reader);
  const withFollows = center?.table === "companion_soma_events";

  const edgeRows: EdgeRow[] = [];
  let frontier = seeds;
  const seen = new Set(seeds.map((s) => key(s.table, s.id)));
  for (let h = 0; h < hops; h++) {
    const found = await edgesAround(env, frontier, withFollows);
    edgeRows.push(...found);
    const next: Array<{ table: string; id: string }> = [];
    for (const e of found) {
      for (const [t, id] of [[e.src_table, e.src_id], [e.dst_table, e.dst_id]] as const) {
        const k = key(t, id);
        if (!seen.has(k)) { seen.add(k); next.push({ table: t, id }); }
      }
    }
    frontier = next;
    if (seen.size >= max * 2) break;
  }

  const refs = [...seen].map((k) => { const i = k.indexOf("/"); return { table: k.slice(0, i), id: k.slice(i + 1) }; });
  const nodes = await loadMapNodes(env, refs);
  for (const s of seeds) { const n = nodes.get(key(s.table, s.id)); if (n) n.seed = true; }

  // Keep only edges whose BOTH ends are visible; dedupe (an edge is found from both its ends).
  const edgeKey = new Set<string>();
  let edges: MapEdge[] = [];
  for (const e of edgeRows) {
    const src = key(e.src_table, e.src_id), dst = key(e.dst_table, e.dst_id);
    if (!nodes.has(src) || !nodes.has(dst)) continue;
    const k = `${src}|${dst}|${e.edge_type}`;
    if (edgeKey.has(k)) continue;
    edgeKey.add(k);
    edges.push({ src, dst, type: e.edge_type, writer: e.writer, provenance: e.provenance, created_at: e.created_at, why: e.why ?? null });
  }

  // Node cap: seeds first, then by degree. Isolated non-seed nodes never survive (nothing links them).
  const degree = new Map<string, number>();
  for (const e of edges) { degree.set(e.src, (degree.get(e.src) ?? 0) + 1); degree.set(e.dst, (degree.get(e.dst) ?? 0) + 1); }
  const ranked = [...nodes.values()]
    .filter((n) => n.seed || (degree.get(n.key) ?? 0) > 0)
    .sort((a, b) => Number(b.seed) - Number(a.seed) || (degree.get(b.key) ?? 0) - (degree.get(a.key) ?? 0) || a.key.localeCompare(b.key));
  const kept = ranked.slice(0, max);
  const keep = new Set(kept.map((n) => n.key));
  const truncated = ranked.length > kept.length;
  edges = edges.filter((e) => keep.has(e.src) && keep.has(e.dst));
  return { nodes: kept, edges, truncated, center: center ? key(center.table, center.id) : null };
}
