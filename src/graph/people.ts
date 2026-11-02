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
import { careCategory } from "../people/care-guard.js";

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
  /** mig 0163: see PersonExtras. Null on every row until the migration is applied. */
  system_of: string | null;
  relation: string | null;
  frame_line: string | null;
  discord_user_id: string | null;
  pk_system: string | null;
  added_by: string;
  created_at: string;
}

/** The mig 0163 columns (B49, people as graph nodes). */
export interface PersonExtras {
  system_of: string | null;
  relation: string | null;
  frame_line: string | null;
  discord_user_id: string | null;
  pk_system: string | null;
}
export const EXTRA_KEYS = ["system_of", "relation", "frame_line", "discord_user_id", "pk_system"] as const;
export const RELATIONS = ["partner", "family", "friend", "kid", "pet", "other"] as const;
export const PK_SYSTEMS = ["raziel", "blue"] as const;
export const FRAME_LINE_MAX = 200;
const NO_EXTRAS: PersonExtras = { system_of: null, relation: null, frame_line: null, discord_user_id: null, pk_system: null };

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

interface PersonRow { id: string; label: string; match_names: string; kind: string; pk_member_id: string | null; note: string | null; shares_name_with?: string | null; system_of?: string | null; relation?: string | null; frame_line?: string | null; discord_user_id?: string | null; pk_system?: string | null; added_by: string; created_at: string }

const toPerson = (r: PersonRow): GraphPerson => ({
  ...r,
  kind: r.kind === "headmate" ? "self" : (PERSON_KINDS as readonly string[]).includes(r.kind) ? (r.kind as PersonKind) : "other",
  match_names: parseMatchNames(r.match_names),
  shares_name_with: r.shares_name_with ?? null,
  system_of: r.system_of ?? null,
  relation: r.relation ?? null,
  frame_line: r.frame_line ?? null,
  discord_user_id: r.discord_user_id ?? null,
  pk_system: r.pk_system ?? null,
});

const LIST_SQL = (cols: string) =>
  `SELECT id, label, match_names, kind, pk_member_id, note, ${cols}added_by, created_at FROM graph_people WHERE archived = 0 ORDER BY (kind != 'centre'), label`;

/** Only the missing 0160 column; any other error is rethrown. */
export const missingSharesName = (e: unknown) => /(no such column|has no column named):?\s*\S*shares_name_with/i.test(String(e));

/** Only a missing 0163 column; any other error is rethrown. */
export const missingExtras = (e: unknown) => /(no such column|has no column named):?\s*\S*(system_of|relation|frame_line|discord_user_id|pk_system)/i.test(String(e));

/** The centre first, then everyone else by name. Pre-0163 the new columns read as null, pre-0160 shares_name_with too. */
export async function listPeople(env: Env): Promise<GraphPerson[]> {
  const res = await env.DB.prepare(LIST_SQL(`shares_name_with, ${EXTRA_KEYS.join(", ")}, `)).all<PersonRow>()
    .catch(onlyIf((e) => missingExtras(e) || missingSharesName(e), () => env.DB.prepare(LIST_SQL("shares_name_with, ")).all<PersonRow>()
      .catch(onlyIf(missingSharesName, () => env.DB.prepare(LIST_SQL("")).all<PersonRow>()))));
  return (res.results ?? []).map(toPerson);
}

/** A shared name with no other spelling would link nothing; say so instead of saving a dead entry. */
export function sharedNeedsSpelling(label: string, shares: string | null, names: string[], kind?: string): string | null {
  if (!shares) return null;
  const example = kind === "self" ? `${label} (ours)` : `${label} (Blue)`;
  return spellingsOf({ label, match_names: names, shares_name_with: shares }).length === 0
    ? `${label} is also a character, so the bare name won't link. Add a spelling only the person has, like "${example}".`
    : null;
}

export type AddPersonResult = { ok: true; person: GraphPerson; warnings: string[] } | { ok: false; reason: string };

const collapse = (s: string) => s.replace(/\s+/g, " ").trim();
const str = (v: unknown): string | null => (typeof v === "string" && collapse(v) ? collapse(v) : null);

/** What a frame_line hit says. A CATEGORY, never the term: the warning must not repeat what it guards. */
export function frameLineWarnings(line: string | null | undefined): string[] {
  const c = careCategory(line);
  return c ? [`This line touches ${c} words. The triad is never given care or health detail as material, so the bots will leave this line out until it is reworded.`] : [];
}

/** Check the mig 0163 fields against the list (plan 1a). `merged` is the entry as it would be saved.
 *  Pure; `people` is the live list (centre included). Returns a reason or null. */
export function validateExtras(kind: string, selfId: string | null, merged: PersonExtras, people: GraphPerson[]): string | null {
  if (merged.relation && !(RELATIONS as readonly string[]).includes(merged.relation)) return `relation is one of ${RELATIONS.join(", ")}`;
  if (merged.pk_system && !(PK_SYSTEMS as readonly string[]).includes(merged.pk_system)) return `pk_system is one of ${PK_SYSTEMS.join(", ")}`;
  if (merged.frame_line && merged.frame_line.length > FRAME_LINE_MAX) return `a frame line is at most ${FRAME_LINE_MAX} characters (this is ${merged.frame_line.length})`;
  if (merged.discord_user_id && !/^\d{5,25}$/.test(merged.discord_user_id)) return "a Discord user id is digits only (turn on Developer Mode, right-click the person, Copy User ID)";
  if (kind === "centre") return "the centre carries none of these";
  if (kind === "self") {
    if (merged.system_of || merged.relation || merged.discord_user_id || merged.frame_line) {
      return "a system name is Raziel: it carries no system, relation, Discord id or frame line (it is always rendered as one of Raziel's names)";
    }
    if (merged.pk_system && merged.pk_system !== "raziel") return "a system name's pk_system is raziel";
  } else if (merged.pk_system === "raziel") {
    return "pk_system raziel is for a system name only";
  }
  if (merged.system_of) {
    const owner = people.find((p) => p.id === merged.system_of);
    if (!owner) return "that system owner is not on the live list";
    if (owner.id === selfId) return "someone cannot be a member of their own system";
    if (owner.kind !== "person" && owner.kind !== "centre") return "a system belongs to a person (or the centre), not a name, pet or other";
    if (owner.system_of) return `${owner.label} is a system member; a system hangs off one person, not a chain`;
    if (selfId && people.some((p) => p.system_of === selfId)) return "this person has system members of their own; move them first";
  }
  if (merged.pk_system === "blue") {
    const owner = people.find((p) => p.id === merged.system_of);
    if (!owner || owner.label.trim().toLowerCase() !== "blue") return "pk_system blue needs system_of = Blue's entry";
  }
  if (merged.discord_user_id) {
    const dup = people.find((p) => p.discord_user_id === merged.discord_user_id && p.id !== selfId);
    if (dup) return `that Discord id already belongs to ${dup.label}`;
  }
  return null;
}

type ExtrasInput = { [K in keyof PersonExtras]?: string | null };
const touches = (x: PersonExtras) => EXTRA_KEYS.some((k) => x[k] !== null);
const isUnique = (e: unknown) => /UNIQUE constraint/i.test(String(e));
const NEEDS_0163 = "system, relation, frame line, Discord id and PK system need the 0163 migration first";

export async function addPerson(env: Env, input: {
  label: string; match_names?: string[]; kind?: string; pk_member_id?: string | null; note?: string | null;
  shares_name_with?: string | null; added_by: string;
} & ExtrasInput): Promise<AddPersonResult> {
  const label = input.label.trim();
  if (label.length < PERSON_MIN_NAME_LEN) return { ok: false, reason: `a name needs at least ${PERSON_MIN_NAME_LEN} characters` };
  if (isCentreName(label)) return { ok: false, reason: `${label} is Raziel -- already the centre of the map` };
  const requested = input.kind === "headmate" ? "self" : input.kind;
  const kind = requested && ADDABLE_KINDS.has(requested) ? requested : "person";
  const names = parseMatchNames(input.match_names ?? []).filter((n) => n !== label && !isCentreName(n));
  const shares = normalizeSharesName(input.shares_name_with);
  const dead = sharedNeedsSpelling(label, shares, names, kind);
  if (dead) return { ok: false, reason: dead };
  const x: PersonExtras = {
    system_of: str(input.system_of), relation: str(input.relation), frame_line: str(input.frame_line),
    discord_user_id: str(input.discord_user_id), pk_system: str(input.pk_system),
  };
  const people = await listPeople(env);
  if (people.some((p) => p.label === label)) return { ok: false, reason: `${label} is already on the list` };
  const bad = validateExtras(kind, null, x, people);
  if (bad) return { ok: false, reason: bad };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const note = input.note?.trim() || null;
  const pk = input.pk_member_id ?? null;
  const person: GraphPerson = { id, label, match_names: names, kind: kind as PersonKind, pk_member_id: pk, note, shares_name_with: shares, ...x, added_by: input.added_by, created_at: now };
  const warnings = frameLineWarnings(x.frame_line);
  try {
    await env.DB.prepare(
      `INSERT INTO graph_people (id, label, match_names, kind, pk_member_id, note, shares_name_with, ${EXTRA_KEYS.join(", ")}, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, label, JSON.stringify(names), kind, pk, note, shares, x.system_of, x.relation, x.frame_line, x.discord_user_id, x.pk_system, input.added_by, now).run();
    return { ok: true, person, warnings };
  } catch (e) {
    if (isUnique(e)) return { ok: false, reason: "that Discord id already belongs to someone on the list" };
    if (!missingExtras(e) && !missingSharesName(e)) throw e;
    // Pre-0163: a plain add still works; one that needs the new columns refuses with the reason.
    if (touches(x)) return { ok: false, reason: NEEDS_0163 };
  }
  try {
    await env.DB.prepare(
      `INSERT INTO graph_people (id, label, match_names, kind, pk_member_id, note, shares_name_with, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, label, JSON.stringify(names), kind, pk, note, shares, input.added_by, now).run();
  } catch (e) {
    // Pre-0160: never save a shared name without its flag (the bare label would link every film line).
    if (!missingSharesName(e)) throw e;
    if (shares) return { ok: false, reason: "names shared with a character need the 0160 migration first" };
    await env.DB.prepare(
      `INSERT INTO graph_people (id, label, match_names, kind, pk_member_id, note, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(id, label, JSON.stringify(names), kind, pk, note, input.added_by, now).run();
  }
  return { ok: true, person, warnings };
}

export type UpdatePersonResult = { ok: true; person: GraphPerson; warnings: string[] } | { ok: false; status: 404 | 409; reason: string };

/** Change an entry's other spellings, its shared-name flag (mig 0160) and its frame fields (mig 0163).
 *  A field left undefined is unchanged; null or "" clears it. Label and kind stay: a different name is
 *  a different entry (archive + add). The centre is not editable here. */
export async function updatePerson(env: Env, id: string, input: { match_names?: string[]; shares_name_with?: string | null } & ExtrasInput): Promise<UpdatePersonResult> {
  const people = await listPeople(env);
  const current = people.find((p) => p.id === id);
  if (!current || current.kind === "centre") return { ok: false, status: 404, reason: "not found" };
  const names = input.match_names === undefined
    ? current.match_names
    : parseMatchNames(input.match_names).filter((n) => n !== current.label && !isCentreName(n));
  const shares = input.shares_name_with === undefined ? current.shares_name_with : normalizeSharesName(input.shares_name_with);
  const dead = sharedNeedsSpelling(current.label, shares, names, current.kind);
  if (dead) return { ok: false, status: 409, reason: dead };
  const x: PersonExtras = { system_of: current.system_of, relation: current.relation, frame_line: current.frame_line, discord_user_id: current.discord_user_id, pk_system: current.pk_system };
  for (const k of EXTRA_KEYS) if (input[k] !== undefined) x[k] = str(input[k]);
  const changed = EXTRA_KEYS.some((k) => input[k] !== undefined && x[k] !== current[k]);
  if (changed) {
    const bad = validateExtras(current.kind, id, x, people);
    if (bad) return { ok: false, status: 409, reason: bad };
  }
  const person: GraphPerson = { ...current, match_names: names, shares_name_with: shares, ...x };
  const warnings = frameLineWarnings(x.frame_line);
  if (changed) {
    try {
      await env.DB.prepare(`UPDATE graph_people SET match_names = ?, shares_name_with = ?, ${EXTRA_KEYS.map((k) => `${k} = ?`).join(", ")} WHERE id = ? AND archived = 0`)
        .bind(JSON.stringify(names), shares, x.system_of, x.relation, x.frame_line, x.discord_user_id, x.pk_system, id).run();
      return { ok: true, person, warnings };
    } catch (e) {
      if (isUnique(e)) return { ok: false, status: 409, reason: "that Discord id already belongs to someone on the list" };
      if (!missingExtras(e)) throw e;
      return { ok: false, status: 409, reason: NEEDS_0163 };
    }
  }
  try {
    await env.DB.prepare("UPDATE graph_people SET match_names = ?, shares_name_with = ? WHERE id = ? AND archived = 0")
      .bind(JSON.stringify(names), shares, id).run();
  } catch (e) {
    if (!missingSharesName(e)) throw e;
    return { ok: false, status: 409, reason: "editing needs the 0160 migration first" };
  }
  return { ok: true, person, warnings };
}

// ---------------------------------------------------------------------------------------------
// The frame index (B49 slice 1): what the bots may say about each person on the list.
// Pure functions; handlers/people.ts serves them. Everything here is data, framed as data.

/** Sanitize like the bots' pkProfileBlock: quotes and brackets cannot close or open a frame. */
export function sanitizeLine(s: string): string {
  return s.replace(/"/g, "'").replace(/\[/g, "(").replace(/\]/g, ")").replace(/\s+/g, " ").trim();
}

const RELATION_WORD: Record<string, string> = { partner: "partner", family: "family", friend: "friend", kid: "kid", pet: "pet" };

/** The finished line for one entry, or null when there is nothing true to say. No trailing period:
 *  the bot joins lines itself. A self entry is ALWAYS "<name>: Raziel (one of Raziel's names)": it is
 *  never rendered beside Raziel as someone else, and carries no frame line. The centre renders nothing.
 *  `frameLineOk` false = the line was dropped at read (care or keep-off hit). */
export function renderFrameLine(p: GraphPerson, byId: Map<string, GraphPerson>, frameLineOk = true): string | null {
  if (p.kind === "centre") return null;
  if (p.kind === "self") return sanitizeLine(`${p.label}: Raziel (one of Raziel's names)`);
  const owner = p.system_of ? byId.get(p.system_of) : undefined;
  let identity: string | null = null;
  if (owner && owner.kind !== "centre") identity = `${p.label}, a member of ${owner.label}'s system`;
  else if (owner) identity = `${p.label}, a member of Raziel's system`;
  else if (p.relation && RELATION_WORD[p.relation]) identity = `${p.label}, Raziel's ${RELATION_WORD[p.relation]}`;
  const line = frameLineOk && p.frame_line ? p.frame_line.replace(/[.!\s]+$/, "") : null;
  const parts = identity ? [identity, line] : line ? [`${p.label}: ${line}`] : [];
  const out = parts.filter(Boolean).join(". ");
  return out ? sanitizeLine(out) : null;
}

export interface FrameIndexEntry {
  id: string;
  label: string;
  kind: PersonKind;
  rendered: string;
  /** Curated spellings the bots may match in free text: ambiguous ones already removed. */
  spellings: string[];
  /** PK join: system plus the names a PK speaker may carry. */
  pk: { system: string; names: string[] } | null;
  discord_user_id: string | null;
}

/** The index for the bots. Centre excluded. Keep-off fails closed: a person whose label, spelling or
 *  owner hits is omitted; a frame line that hits keep-off or the care guard is dropped (the identity
 *  line stays). `keepOffRe` null = nothing kept off. Entries with nothing to render and no id to
 *  resolve by are left out. */
export function buildFrameIndex(people: GraphPerson[], keepOffRe: RegExp | null): FrameIndexEntry[] {
  const live = people.filter((p) => p.kind !== "centre");
  const byId = new Map(people.map((p) => [p.id, p]));
  const ambiguous = ambiguousSpellings(live);
  const hit = (s: string | null | undefined) => !!s && !!keepOffRe && keepOffRe.test(s);
  const out: FrameIndexEntry[] = [];
  for (const p of live) {
    const owner = p.system_of ? byId.get(p.system_of) : undefined;
    const allSpellings = spellingsOf(p);
    if (hit(p.label) || p.match_names.some(hit) || hit(owner?.label)) continue;
    const frameLineOk = !!p.frame_line && !hit(p.frame_line) && careCategory(p.frame_line) === null;
    const rendered = renderFrameLine(p, byId, frameLineOk);
    if (!rendered) continue;
    const spellings = allSpellings.filter((s) => !ambiguous.has(s));
    const pk = p.pk_system ? { system: p.pk_system, names: [...new Set([p.label, ...p.match_names])] } : null;
    out.push({ id: p.id, label: p.label, kind: p.kind, rendered, spellings, pk, discord_user_id: p.discord_user_id });
  }
  return out;
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
