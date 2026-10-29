// src/graph/people.ts -- the people the memory graph may link to (mig 0149, M5).
//
// A person exists here only because Raziel named them (see the migration header for the measurement
// that ruled out matching the roster blind). This file holds the list's rules; the matching itself is
// rebuild lane (l), src/graph/rebuild.ts buildPeopleMentionsEdges.

import type { Env } from "../types.js";

export const PERSON_KINDS = ["headmate", "person", "pet", "other"] as const;
export type PersonKind = typeof PERSON_KINDS[number];

/** Raziel's own names (Raziel confirmed 2026-10-29: "Yes I'm crash"). The centre every memory is
 *  relative to is never a node on the list: "Raziel" alone is in 824 kept rows and "Crash" in 928,
 *  so a node for him would link to nearly everything and say nothing. Refused on add, and never
 *  matched by the rebuild even if a row slipped in. */
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
  added_by: string;
  created_at: string;
}

export function parseMatchNames(raw: unknown): string[] {
  let v: unknown = raw;
  if (typeof raw === "string") { try { v = JSON.parse(raw); } catch { return []; } }
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean))];
}

/** Every spelling a person matches on: label plus match_names, deduped, short ones dropped. */
export function spellingsOf(p: { label: string; match_names: string[] }): string[] {
  return [...new Set([p.label.trim(), ...p.match_names])].filter((s) => s.length >= PERSON_MIN_NAME_LEN && !isCentreName(s));
}

/** Spellings claimed by more than one live person. Matched for nobody: the graph never picks. */
export function ambiguousSpellings(people: Array<{ label: string; match_names: string[] }>): Set<string> {
  const owners = new Map<string, number>();
  for (const p of people) for (const s of spellingsOf(p)) owners.set(s, (owners.get(s) ?? 0) + 1);
  return new Set([...owners].filter(([, n]) => n > 1).map(([s]) => s));
}

interface PersonRow { id: string; label: string; match_names: string; kind: string; pk_member_id: string | null; note: string | null; added_by: string; created_at: string }

const toPerson = (r: PersonRow): GraphPerson => ({
  ...r, kind: (PERSON_KINDS as readonly string[]).includes(r.kind) ? (r.kind as PersonKind) : "other",
  match_names: parseMatchNames(r.match_names),
});

export async function listPeople(env: Env): Promise<GraphPerson[]> {
  const res = await env.DB.prepare(
    "SELECT id, label, match_names, kind, pk_member_id, note, added_by, created_at FROM graph_people WHERE archived = 0 ORDER BY label",
  ).all<PersonRow>();
  return (res.results ?? []).map(toPerson);
}

export type AddPersonResult = { ok: true; person: GraphPerson } | { ok: false; reason: string };

export async function addPerson(env: Env, input: {
  label: string; match_names?: string[]; kind?: string; pk_member_id?: string | null; note?: string | null; added_by: string;
}): Promise<AddPersonResult> {
  const label = input.label.trim();
  if (label.length < PERSON_MIN_NAME_LEN) return { ok: false, reason: `a name needs at least ${PERSON_MIN_NAME_LEN} characters` };
  const kind = input.kind && (PERSON_KINDS as readonly string[]).includes(input.kind) ? input.kind : "person";
  if (isCentreName(label)) return { ok: false, reason: `${label} is Raziel, the centre every memory is relative to -- never a node on the map` };
  const names = parseMatchNames(input.match_names ?? []).filter((n) => n !== label && !isCentreName(n));
  const existing = await env.DB.prepare("SELECT id FROM graph_people WHERE label = ? AND archived = 0").bind(label).first<{ id: string }>();
  if (existing) return { ok: false, reason: `${label} is already on the list` };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO graph_people (id, label, match_names, kind, pk_member_id, note, added_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, label, JSON.stringify(names), kind, input.pk_member_id ?? null, input.note?.trim() || null, input.added_by, now).run();
  return { ok: true, person: { id, label, match_names: names, kind: kind as PersonKind, pk_member_id: input.pk_member_id ?? null, note: input.note?.trim() || null, added_by: input.added_by, created_at: now } };
}

/** Archive, never delete: the person's mention edges drop at the next rebuild (no source, no edge). */
export async function archivePerson(env: Env, id: string): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE graph_people SET archived = 1 WHERE id = ? AND archived = 0").bind(id).run();
  return (r.meta?.changes ?? 0) > 0;
}
