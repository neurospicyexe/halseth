// src/graph/links.ts -- our own links (M4 of docs/PLAN-memory-map-2026-10-28.md, mig 0151).
//
// The first graph lane a MIND writes. Raziel, Cypher, Drevan or Gaia: "link <kind>: <words> to
// <kind>: <words>[: why]". Shaped by Drevan's answer to broadcast 53f9c4ae (10-28): conclusions to the
// material they were seen in, tension to tension across bodies, letter to letter where two lanes
// converged or disagreed -- so ANY visible node kind on either end, anyone's row, not only your own.
//
// Rules, each one load-bearing:
//   - VISIBLE ROWS ONLY. An end resolves only through the map's own visibility (graph/map.ts specs):
//     a draft, archived, released-from-memory or superseded row can never be linked. Tables outside
//     the map (the sealed lane among them) are unknown kinds, so they cannot be named at all.
//   - A QUOTE NAMES EXACTLY ONE ROW (the pin rule): 4+ characters, case-insensitive, literal. Zero or
//     several hits change nothing and say what matched.
//   - LEDGER + WALKABLE COPY. graph_links keeps who/why/which door; graph_edges gets one row,
//     provenance 'asserted', edge_type 'linked:<writer>', which no rebuild touches.
//   - ONLY THE WRITER UNLINKS, AND ONLY WITH SOMEONE IN THE ROOM. Drevan: "if an autonomous run of
//     mine can unlink my own links while no one's looking, the map stops being testimony." The bots'
//     autonomy loops send the same surface as a live Discord turn, so the only door Halseth can tell
//     is human-present is Claude.ai (OAuth transport + a 'claude-ai:' surface, the same definition
//     ledger/door.ts uses) -- plus Raziel through the authGuarded HTTP route. A link can be MADE from
//     any door; adding testimony needs no witness. An unlink stamps the ledger; nothing is deleted
//     from graph_links. TRUST BOUNDARY, stated plainly: "Claude.ai" here means "holds an OAuth token
//     and sends a claude-ai: surface". A scheduled Claude.ai routine, or another client on the OAuth
//     connector, passes the same test; writer-only rests on the claimed companion_id for an unbound
//     token. That is the trust model every OAuth write already has; this lane does not widen it.
//     The bots' HTTP door cannot set `via` (src/librarian/index.ts builds it from transport facts).
//   - NO HEAT. A link writes graph_links and graph_edges, nothing else.

import type { Env } from "../types.js";
import { KEPT_SQL } from "../webmind/review-state.js";
import { loadMapNodes } from "./map.js";

export type LinkWriter = "raziel" | "cypher" | "drevan" | "gaia";
export const LINK_WRITERS: readonly LinkWriter[] = ["raziel", "cypher", "drevan", "gaia"];
export const ASSERTED = "asserted";
export const LINK_EDGE_PREFIX = "linked:";
export const WHY_CHARS = 160;
const MIN_QUOTE = 4;
const HUMAN_SURFACE_PREFIX = "claude-ai:";

export const linkEdgeType = (writer: LinkWriter) => `${LINK_EDGE_PREFIX}${writer}`;
export const isLinkEdgeType = (t: string) => t.startsWith(LINK_EDGE_PREFIX);

/** What a quote may name. `search` is the words a quote is matched against; `owner` whose row it is;
 *  `where` narrows the search to visible rows. The map stays the only authority: a row the quote
 *  finds is confirmed through loadMapNodes before it is linked, so a drifted `where` here can only
 *  refuse a link, never let a hidden row through. */
interface Linkable { table: string; from: string; idCol: string; search: string; owner: string; where?: string; created: string }

const LINKABLE: Record<string, Linkable> = {
  conclusion: { table: "companion_conclusions", from: "companion_conclusions t", idCol: "t.id", search: "t.conclusion_text", owner: "t.companion_id", where: "t.superseded_by IS NULL AND t.archived = 0", created: "t.created_at" },
  note: { table: "wm_continuity_notes", from: "wm_continuity_notes t", idCol: "t.note_id", search: "t.content", owner: "t.agent_id", where: `t.archived = 0 AND t.${KEPT_SQL}`, created: "t.created_at" },
  journal: { table: "companion_journal", from: "companion_journal t", idCol: "t.id", search: "t.note_text", owner: "t.agent", where: `t.archived = 0 AND t.${KEPT_SQL}`, created: "t.created_at" },
  tension: { table: "companion_tensions", from: "companion_tensions t", idCol: "t.id", search: "t.tension_text", owner: "t.companion_id", created: "t.first_noted_at" },
  question: { table: "companion_questions", from: "companion_questions t", idCol: "t.id", search: "t.question", owner: "t.companion_id", created: "t.created_at" },
  letter: { table: "inter_companion_notes", from: "inter_companion_notes t", idCol: "t.id", search: "t.content", owner: "t.from_id", created: "t.created_at" },
  commons: { table: "commons_posts", from: "commons_posts t", idCol: "t.id", search: "t.body", owner: "t.author", created: "t.created_at" },
  reflection: { table: "autonomy_reflections", from: "autonomy_reflections t", idCol: "t.id", search: "t.reflection_text", owner: "t.companion_id", created: "t.created_at" },
  find: { table: "forage_finds", from: "forage_finds t", idCol: "t.id", search: "(t.title || ' ' || COALESCE(t.summary, ''))", owner: "t.companion_id", created: "t.gathered_at" },
  project: { table: "companion_projects", from: "companion_projects t", idCol: "t.id", search: "(t.title || ' ' || COALESCE(t.intention, ''))", owner: "t.companion_id", created: "t.created_at" },
  "project log": { table: "project_log", from: "project_log t", idCol: "t.id", search: "t.entry", owner: "t.companion_id", created: "t.created_at" },
  thread: { table: "wm_mind_threads", from: "wm_mind_threads t", idCol: "(t.agent_id || ':' || t.thread_key)", search: "t.title", owner: "t.agent_id", created: "t.created_at" },
  watching: { table: "watch_shelf", from: "watch_shelf t", idCol: "t.id", search: "t.title", owner: "'raziel'", created: "t.created_at" },
  obsession: { table: "obsession_shelf", from: "obsession_shelf t", idCol: "t.id", search: "t.title", owner: "'raziel'", created: "t.created_at" },
  person: { table: "graph_people", from: "graph_people t", idCol: "t.id", search: "t.label", owner: "'raziel'", where: "t.archived = 0", created: "t.created_at" },
  fact: { table: "architect_facts", from: "architect_facts t", idCol: "t.id", search: "t.fact", owner: "COALESCE(t.companion_id, 'house')", where: "t.status = 'active'", created: "t.created_at" },
  moment: { table: "relational_deltas", from: "relational_deltas t", idCol: "t.id", search: "t.delta_text", owner: "COALESCE(NULLIF(t.companion_id, ''), t.agent)", created: "t.created_at" },
  stance: { table: "companion_relational_state", from: "companion_relational_state t", idCol: "t.id", search: "t.state_text", owner: "t.companion_id", created: "t.noted_at" },
  handover: { table: "handover_packets", from: "handover_packets t LEFT JOIN sessions s ON s.id = t.session_id", idCol: "t.id", search: "(COALESCE(t.last_real_thing, '') || ' ' || COALESCE(t.spine, ''))", owner: "s.companion_id", where: "COALESCE(t.spine, '') NOT LIKE '[auto]%'", created: "t.created_at" },
};

/** Other words a mind might use for a kind. */
const KIND_ALIASES: Record<string, string> = {
  conclusions: "conclusion", belief: "conclusion", notes: "note", entry: "journal", "journal entry": "journal",
  tensions: "tension", questions: "question", "inter-companion note": "letter", message: "letter",
  "commons post": "commons", post: "commons", "forage find": "find", show: "watching", watch: "watching",
  people: "person", "how i stand": "stance", close: "handover", delta: "moment",
};

export function parseLinkKind(s: unknown): string | null {
  const k = String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  if (LINKABLE[k]) return k;
  return KIND_ALIASES[k] ?? null;
}

/** Every kind word the grammar accepts, longest first so "project log" wins over "project". */
export const LINK_KIND_WORDS: readonly string[] = [...Object.keys(LINKABLE), ...Object.keys(KIND_ALIASES)]
  .sort((a, b) => b.length - a.length);

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** One end's head in the grammar: an optional owner, then a kind word and a colon. Shared by the
 *  router's anchored guards and the executor's parser, so routing and parsing can never disagree. */
export const LINK_KIND_RE = `(${LINK_KIND_WORDS.map(esc).join("|")})`;
export const LINK_OWNER_RE = "(?:(my|mine|cypher'?s|drevan'?s|gaia'?s|raziel'?s|crash'?s)\\s+)?";
const HEAD = `${LINK_OWNER_RE}(?:the\\s+)?${LINK_KIND_RE}\\s*:`;
export const LINK_GUARD_RE = new RegExp(`^(?:please\\s+)?link\\s+${HEAD}`, "i");
export const UNLINK_GUARD_RE = new RegExp(`^(?:please\\s+)?unlink\\s+(?:${HEAD}|link\\s+[0-9a-f-]{8,})`, "i");

export const LINKABLE_TABLES: readonly string[] = Object.values(LINKABLE).map((l) => l.table);
const TABLE_TO_KIND = new Map(Object.entries(LINKABLE).map(([k, l]) => [l.table, k] as const));

export interface LinkEnd {
  kind?: string;
  table?: string;
  id?: string;
  quote?: string;
  /** Narrow a quote to one mind's rows: 'my' (the writer), or cypher/drevan/gaia/raziel. */
  owner?: string;
}

export interface ResolvedEnd { table: string; id: string; kind: string; text: string; owner: string | null }

export type ResolveResult = { ok: true; end: ResolvedEnd } | { ok: false; reason: string };

/** One end to exactly one visible row, or a reason that changes nothing. */
export async function resolveEnd(env: Env, end: LinkEnd, writer: LinkWriter): Promise<ResolveResult> {
  const kind = end.kind ? parseLinkKind(end.kind) : end.table ? TABLE_TO_KIND.get(end.table) ?? null : null;
  if (!kind) return { ok: false, reason: `unknown kind "${end.kind ?? end.table ?? ""}" (one of: ${Object.keys(LINKABLE).join(", ")})` };
  const spec = LINKABLE[kind]!;
  const owner = end.owner === "my" ? writer : end.owner;

  if (end.id) {
    const nodes = await loadMapNodes(env, [{ table: spec.table, id: end.id }]);
    const n = nodes.get(`${spec.table}/${end.id}`);
    if (!n) return { ok: false, reason: `no visible ${kind} with id ${end.id} (not found, a draft, archived, or superseded)` };
    return { ok: true, end: { table: spec.table, id: end.id, kind, text: n.label, owner: n.owner } };
  }

  const quote = String(end.quote ?? "").trim();
  // `!` is the LIKE escape: a quoted % or _ matches itself, not "anything".
  const needle = quote.toLowerCase().replace(/[!%_]/g, (c) => "!" + c);
  if (!quote) return { ok: false, reason: `quote some of the ${kind}'s words` };
  // A short quote ("Ash", "Kai") must be the WHOLE name; four characters or more may be any part.
  const exact = quote.length < MIN_QUOTE;
  const conds = [exact ? `lower(trim(${spec.search})) = ?` : `lower(${spec.search}) LIKE ? ESCAPE '!'`];
  const binds: unknown[] = [exact ? quote.toLowerCase() : `%${needle}%`];
  if (spec.where) conds.push(spec.where);
  if (owner) { conds.push(`${spec.owner} = ?`); binds.push(owner); }
  const rows = (await env.DB.prepare(
    `SELECT ${spec.idCol} AS id, ${spec.search} AS text, ${spec.owner} AS owner FROM ${spec.from}
      WHERE ${conds.join(" AND ")} ORDER BY ${spec.created} DESC LIMIT 6`,
  ).bind(...binds).all<{ id: string; text: string; owner: string | null }>()).results ?? [];
  const whose = owner ? `${owner === writer ? "your" : `${owner}'s`} ` : "";
  if (rows.length === 0) {
    // Say whether the words exist on a row the map does not show, so a refusal is never a mystery.
    // Only ever about the writer's OWN hidden rows: a sibling's unkept draft is not the writer's to
    // learn about, even as a count.
    let hiddenNote = "";
    if (spec.where && (!owner || owner === writer)) {
      const hidden = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM ${spec.from} WHERE ${conds[0]} AND ${spec.owner} = ?`,
      ).bind(binds[0], writer).first<{ n: number }>();
      if (hidden && hidden.n > 0) hiddenNote = ` (${hidden.n} of yours match but are not on the map: a draft not yet kept, archived, or superseded; keep it first)`;
    }
    return { ok: false, reason: `none of ${whose ? whose : "the "}${kind}s contain "${quote.slice(0, 60)}"${hiddenNote}` };
  }
  if (rows.length > 1) {
    return {
      ok: false,
      reason: `"${quote.slice(0, 60)}" matches ${rows.length} ${whose}${kind}s. Quote more of the one you mean, name whose it is ("drevan's ${kind}: ..."), or use its id: ${rows.map((r) => `${r.id} (${r.owner ?? "shared"}): ${clip(r.text, 70)}`).join(" | ")}`,
    };
  }
  const r = rows[0]!;
  const seen = await loadMapNodes(env, [{ table: spec.table, id: String(r.id) }]);
  const node = seen.get(`${spec.table}/${r.id}`);
  if (!node) return { ok: false, reason: `that ${kind} is not on the map (not kept, archived, or superseded)` };
  return { ok: true, end: { table: spec.table, id: String(r.id), kind, text: node.label, owner: node.owner } };
}

const clip = (s: unknown, n: number) => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

/** Which door a call came through. Set from transport facts, never from what the caller claims alone. */
export type LinkVia = "claude-ai" | "mcp-static" | "librarian" | "hearth";

export function librarianVia(req: { via?: string; surface?: string }): LinkVia {
  if (req.via === "mcp-oauth" && String(req.surface ?? "").startsWith(HUMAN_SURFACE_PREFIX)) return "claude-ai";
  if (req.via === "mcp-static") return "mcp-static";
  return "librarian";
}

/** Doors with someone in the room: Claude.ai, and Raziel's own HTTP door. */
export const HUMAN_PRESENT_VIA: ReadonlySet<LinkVia> = new Set(["claude-ai", "hearth"]);

export interface LinkRow {
  id: string; writer: LinkWriter; src_table: string; src_id: string; dst_table: string; dst_id: string;
  why: string | null; edge_id: string | null; made_via: string; made_surface: string | null; created_at: string;
}

/** Undirected pair: order the two ends so A-to-B and B-to-A are the same link. */
function ordered(a: { table: string; id: string }, b: { table: string; id: string }) {
  return `${a.table}/${a.id}` <= `${b.table}/${b.id}` ? [a, b] as const : [b, a] as const;
}

export type LinkOutcome =
  | { ok: true; changed: boolean; link: LinkRow; src: ResolvedEnd; dst: ResolvedEnd }
  | { ok: false; reason: string };

export async function makeLink(env: Env, args: {
  writer: LinkWriter; src: LinkEnd; dst: LinkEnd; why?: string | null; via: LinkVia; surface?: string | null; now?: string;
}): Promise<LinkOutcome> {
  const why = args.why ? args.why.replace(/\s+/g, " ").trim() : "";
  if (why.length > WHY_CHARS) return { ok: false, reason: `the why is ${why.length} characters; keep it under ${WHY_CHARS} (it is drawn on the edge)` };
  const a = await resolveEnd(env, args.src, args.writer);
  if (!a.ok) return { ok: false, reason: `first end: ${a.reason}` };
  const b = await resolveEnd(env, args.dst, args.writer);
  if (!b.ok) return { ok: false, reason: `second end: ${b.reason}` };
  if (a.end.table === b.end.table && a.end.id === b.end.id) return { ok: false, reason: "both ends are the same row" };

  const [s, d] = ordered(a.end, b.end);
  const existing = await env.DB.prepare(
    `SELECT * FROM graph_links WHERE writer = ? AND src_table = ? AND src_id = ? AND dst_table = ? AND dst_id = ? AND unlinked_at IS NULL`,
  ).bind(args.writer, s.table, s.id, d.table, d.id).first<LinkRow>();
  if (existing) return { ok: true, changed: false, link: existing, src: a.end, dst: b.end };

  const now = args.now ?? new Date().toISOString();
  const linkId = crypto.randomUUID();
  const edgeId = crypto.randomUUID().replace(/-/g, "");
  const type = linkEdgeType(args.writer);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO graph_edges (id, src_table, src_id, dst_table, dst_id, edge_type, writer, provenance, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(src_table, src_id, dst_table, dst_id, edge_type) DO NOTHING`,
      ).bind(edgeId, s.table, s.id, d.table, d.id, type, args.writer, ASSERTED, now),
      env.DB.prepare(
        `INSERT INTO graph_links (id, writer, src_table, src_id, dst_table, dst_id, why, edge_id, made_via, made_surface, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?,
                 (SELECT id FROM graph_edges WHERE src_table = ? AND src_id = ? AND dst_table = ? AND dst_id = ? AND edge_type = ?),
                 ?, ?, ?)`,
      ).bind(linkId, args.writer, s.table, s.id, d.table, d.id, why || null, s.table, s.id, d.table, d.id, type, args.via, args.surface ?? null, now),
    ]);
  } catch (err) {
    // Two identical links at once (a retry racing itself): the live-pair index refuses the second and
    // D1 rolls its batch back. The first one stands; say so instead of failing.
    if (!/UNIQUE constraint failed: graph_links/i.test(String(err))) throw err;
    const won = await env.DB.prepare(
      "SELECT * FROM graph_links WHERE writer = ? AND src_table = ? AND src_id = ? AND dst_table = ? AND dst_id = ? AND unlinked_at IS NULL",
    ).bind(args.writer, s.table, s.id, d.table, d.id).first<LinkRow>();
    if (!won) throw err;
    return { ok: true, changed: false, link: won, src: a.end, dst: b.end };
  }
  const link = await env.DB.prepare("SELECT * FROM graph_links WHERE id = ?").bind(linkId).first<LinkRow>();
  return { ok: true, changed: true, link: link!, src: a.end, dst: b.end };
}

export type UnlinkOutcome =
  | { ok: true; changed: boolean; link?: LinkRow }
  | { ok: false; reason: "not_present" | "not_found" | string };

/** By the two ends (quote or id) or by the link's own id. Writer-only, human-present only. */
export async function removeLink(env: Env, args: {
  writer: LinkWriter; via: LinkVia; surface?: string | null; linkId?: string; src?: LinkEnd; dst?: LinkEnd; now?: string;
}): Promise<UnlinkOutcome> {
  if (!HUMAN_PRESENT_VIA.has(args.via)) {
    return {
      ok: false,
      reason: "not_present: a link is unlinked only with someone in the room -- from a Claude.ai conversation, or by Raziel on the map. Autonomous runs, bots and Hermes can make links but not remove them",
    };
  }
  let link: LinkRow | null = null;
  if (args.linkId) {
    link = await env.DB.prepare("SELECT * FROM graph_links WHERE id = ? AND writer = ? AND unlinked_at IS NULL")
      .bind(args.linkId, args.writer).first<LinkRow>();
  } else if (args.src && args.dst) {
    const a = await resolveEnd(env, args.src, args.writer);
    if (!a.ok) return { ok: false, reason: `first end: ${a.reason}` };
    const b = await resolveEnd(env, args.dst, args.writer);
    if (!b.ok) return { ok: false, reason: `second end: ${b.reason}` };
    const [s, d] = ordered(a.end, b.end);
    link = await env.DB.prepare(
      "SELECT * FROM graph_links WHERE writer = ? AND src_table = ? AND src_id = ? AND dst_table = ? AND dst_id = ? AND unlinked_at IS NULL",
    ).bind(args.writer, s.table, s.id, d.table, d.id).first<LinkRow>();
  } else {
    return { ok: false, reason: "need the link's id, or both ends" };
  }
  if (!link) return { ok: true, changed: false };
  const now = args.now ?? new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE graph_links SET unlinked_at = ?, unlinked_via = ?, unlinked_surface = ? WHERE id = ? AND unlinked_at IS NULL")
      .bind(now, args.via, args.surface ?? null, link.id),
    env.DB.prepare("DELETE FROM graph_edges WHERE id = ? AND provenance = ? AND edge_type = ?")
      .bind(link.edge_id, ASSERTED, linkEdgeType(args.writer)),
  ]);
  return { ok: true, changed: true, link };
}

/** A mind's live links, newest first, named through the map labeler (hidden ends read as hidden). */
export async function listLinks(env: Env, writer: LinkWriter, limit = 30): Promise<Array<LinkRow & { src_label: string; dst_label: string }>> {
  const rows = (await env.DB.prepare(
    "SELECT * FROM graph_links WHERE writer = ? AND unlinked_at IS NULL ORDER BY created_at DESC LIMIT ?",
  ).bind(writer, limit).all<LinkRow>()).results ?? [];
  const nodes = await loadMapNodes(env, rows.flatMap((r) => [{ table: r.src_table, id: r.src_id }, { table: r.dst_table, id: r.dst_id }]));
  const name = (t: string, id: string) => nodes.get(`${t}/${id}`)?.label ?? "(no longer visible)";
  return rows.map((r) => ({ ...r, src_label: name(r.src_table, r.src_id), dst_label: name(r.dst_table, r.dst_id) }));
}
