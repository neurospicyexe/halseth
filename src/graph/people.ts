// src/graph/people.ts -- who the memory graph links to (mig 0149, 0150; M5).
//
// ONE CENTRE. Raziel (also Crash) is a single node, id 'raziel' (mig 0150). System members are
// Raziel, not separate people (Raziel, 2026-10-29): a system name is listed as kind 'self', and its
// mentions resolve to the centre with the name kept as the FRONT, never to a node of its own. A
// literal model reading the map must never meet a headmate standing beside Raziel as someone else.
// People outside the system (Blue, family, the kids' adults) and pets are nodes of their own.
//
// Nobody is matched until Raziel names them (mig 0149's header has the measurement: many members
// share names with characters in the shows the triad watches). The matching itself is rebuild lane
// (l), src/graph/rebuild.ts buildPeopleMentionsEdges; the centre's own links are lane (m).

import type { Env } from "../types.js";
import { onlyIf } from "../care/schema-gap.js";

export const PERSON_KINDS = ["centre", "self", "person", "pet", "other"] as const;
export type PersonKind = typeof PERSON_KINDS[number];
/** Kinds Raziel can add. 'centre' exists once, from the migration. 'headmate' is 0149's word for 'self'. */
const ADDABLE_KINDS = new Set(["self", "person", "pet", "other"]);

/** The centre node. Every system name resolves here. */
export const CENTRE_ID = "raziel";

/** Raziel's own names (Raziel confirmed 2026-10-29: "Yes I'm crash"). They ARE the centre: never
 *  name-matched ("Raziel" alone is in 824 kept rows and "Crash" in 928, so matching them would link
 *  the centre to nearly everything and say nothing), never another entry's spelling. */
export const CENTRE_NAMES = new Set(["raziel", "crash"]);
export const isCentreName = (s: string) => CENTRE_NAMES.has(s.trim().toLowerCase());

/** Shorter spellings match inside too much ordinary text to mean a person. */
export const PERSON_MIN_NAME_LEN = 3;

export interface GraphPerson {
  id: string;
  label: string;
  match_names: string[];
  kind: PersonKind;
  pk_member_id: string | null;
  note: string | null;
  /** mig 0160: the work(s) this name also belongs to. Set = the label is never matched bare. */
  shares_name_with: string | null;
  added_by: string;
  created_at: string;
}

export function parseMatchNames(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))];
}

/** Every spelling an entry matches on: label plus match_names, deduped, short and centre names dropped.
 *  A name shared with a character (mig 0160, shares_name_with set) drops the bare LABEL: "Barbossa"
 *  alone means the film as often as the person, and the graph never guesses which. Only the other
 *  spellings ("Blue's Barbossa") link. The label stays the entry's readable name. */
export function spellingsOf(p: { label: string; match_names: string[]; shares_name_with?: string | null }): string[] {
  const label = p.label.trim();
  const shared = !!p.shares_name_with?.trim();
  return [...new Set([...(shared ? [] : [label]), ...p.match_names])]
    .filter((s) => s.length >= PERSON_MIN_NAME_LEN && !isCentreName(s) && !(shared && s === label));
}

/** Free text, whitespace collapsed, capped; empty = not shared. */
export function normalizeSharesName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.replace(/\s+/g, " ").trim().slice(0, 200);
  return v || null;
}

/** Spellings claimed by more than one live entry. Matched for nobody: the graph never picks. */
export function ambiguousSpellings(people: Array<{ label: string; match_names: string[]; shares_name_with?: string | null }>): Set<string> {
  const owners = new Map<string, number>();
  for (const p of people) for (const s of spellingsOf(p)) owners.set(s, (owners.get(s) ?? 0) + 1);
  return new Set([...owners].filter(([, n]) => n > 1).map(([s]) => s));
}

interface PersonRow { id: string; label: string; match_names: string; kind: string; pk_member_id: string | null; note: string | null; shares_name_with?: string | null; added_by: string; created_at: string }

const toPerson = (r: PersonRow): GraphPerson => ({
  ...r,
  kind: r.kind === "headmate" ? "self" : (PERSON_KINDS as readonly string[]).includes(r.kind) ? (r.kind as PersonKind) : "other",
  match_names: parseMatchNames(r.match_names),
  shares_name_with: r.shares_name_with ?? null,
});

const LIST_SQL = (cols: string) =>
  `SELECT id, label, match_names, kind, pk_member_id, note, ${cols}added_by, created_at FROM graph_people WHERE archived = 0 ORDER BY (kind != 'centre'), label`;

/** Only the missing 0160 column; any other error is rethrown. */
export const missingSharesName = (e: unknown) => /(no such column|has no column named):?\s*\S*shares_name_with/i.test(String(e));

/** The centre first, then everyone else by name. Pre-0160 the column reads as null. */
export async function listPeople(env: Env): Promise<GraphPerson[]> {
  const res = await env.DB.prepare(LIST_SQL("shares_name_with, ")).all<PersonRow>()
    .catch(onlyIf(missingSharesName, () => env.DB.prepare(LIST_SQL("")).all<PersonRow>()));
  return (res.results ?? []).map(toPerson);
}

/** A shared name with no other spelling would link nothing; say so instead of saving a dead entry. */
export function sharedNeedsSpelling(label: string, shares: string | null, names: string[]): string | null {
  if (!shares) return null;
  return spellingsOf({ label, match_names: names, shares_name_with: shares }).length === 0
    ? `${label} is also a character, so the bare name won't link. Add a spelling only the person has, like "Blue's ${label}".`
    : null;
}

export type AddPersonResult = { ok: true; person: GraphPerson } | { ok: false; reason: string };

export async function addPerson(env: Env, input: {
  label: string; match_names?: string[]; kind?: string; pk_member_id?: string | null; note?: string | null;
  shares_name_with?: string | null; added_by: string;
}): Promise<AddPersonResult> {
  const label = input.label.trim();
  if (label.length < PERSON_MIN_NAME_LEN) return { ok: false, reason: `a name needs at least ${PERSON_MIN_NAME_LEN} characters` };
  if (isCentreName(label)) return { ok: false, reason: `${label} is Raziel -- already the centre of the map` };
  const requested = input.kind === "headmate" ? "self" : input.kind;
  const kind = requested && ADDABLE_KINDS.has(requested) ? requested : "person";
  const names = parseMatchNames(input.match_names ?? []).filter((n) => n !== label && !isCentreName(n));
  const shares = normalizeSharesName(input.shares_name_with);
  const dead = sharedNeedsSpelling(label, shares, names);
  if (dead) return { ok: false, reason: dead };
  const existing = await env.DB.prepare("SELECT id FROM graph_people WHERE label = ? AND archived = 0").bind(label).first<{ id: string }>();
  if (existing) return { ok: false, reason: `${label} is already on the list` };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const note = input.note?.trim() || null;
  try {
    await env.DB.prepare(
      `INSERT INTO graph_people (id, label, match_names, kind, pk_member_id, note, shares_name_with, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, label, JSON.stringify(names), kind, input.pk_member_id ?? null, note, shares, input.added_by, now).run();
  } catch (e) {
    // Pre-0160: never save a shared name without its flag (the bare label would link every film line).
    if (!missingSharesName(e)) throw e;
    if (shares) return { ok: false, reason: "names shared with a character need the 0160 migration first" };
    await env.DB.prepare(
      `INSERT INTO graph_people (id, label, match_names, kind, pk_member_id, note, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, label, JSON.stringify(names), kind, input.pk_member_id ?? null, note, input.added_by, now).run();
  }
  return { ok: true, person: { id, label, match_names: names, kind: kind as PersonKind, pk_member_id: input.pk_member_id ?? null, note, shares_name_with: shares, added_by: input.added_by, created_at: now } };
}

export type UpdatePersonResult = { ok: true; person: GraphPerson } | { ok: false; status: 404 | 409; reason: string };

/** Change an entry's other spellings and/or its shared-name flag (mig 0160). Label and kind stay:
 *  a different name is a different entry (archive + add). The centre is not editable here. */
export async function updatePerson(env: Env, id: string, input: { match_names?: string[]; shares_name_with?: string | null }): Promise<UpdatePersonResult> {
  const current = (await listPeople(env)).find((p) => p.id === id);
  if (!current || current.kind === "centre") return { ok: false, status: 404, reason: "not found" };
  const names = input.match_names === undefined
    ? current.match_names
    : parseMatchNames(input.match_names).filter((n) => n !== current.label && !isCentreName(n));
  const shares = input.shares_name_with === undefined ? current.shares_name_with : normalizeSharesName(input.shares_name_with);
  const dead = sharedNeedsSpelling(current.label, shares, names);
  if (dead) return { ok: false, status: 409, reason: dead };
  try {
    await env.DB.prepare("UPDATE graph_people SET match_names = ?, shares_name_with = ? WHERE id = ? AND archived = 0")
      .bind(JSON.stringify(names), shares, id).run();
  } catch (e) {
    if (!missingSharesName(e)) throw e;
    return { ok: false, status: 409, reason: "editing needs the 0160 migration first" };
  }
  return { ok: true, person: { ...current, match_names: names, shares_name_with: shares } };
}

/** Archive, never delete: the entry's links drop at the next rebuild (no source, no edge). The
 *  centre cannot be archived. */
export async function archivePerson(env: Env, id: string): Promise<boolean> {
  if (id === CENTRE_ID) return false;
  const r = await env.DB.prepare("UPDATE graph_people SET archived = 1 WHERE id = ? AND archived = 0 AND kind != 'centre'").bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}

/** The front tag a self-name link carries: provenance 'mechanical:front:<name>[,<name>]'. */
export const FRONT_PROVENANCE_PREFIX = "mechanical:front:";
export function frontsOf(provenance: string | null | undefined): string[] {
  if (!provenance?.startsWith(FRONT_PROVENANCE_PREFIX)) return [];
  return provenance.slice(FRONT_PROVENANCE_PREFIX.length).split(",").map((s) => s.trim()).filter(Boolean);
}
