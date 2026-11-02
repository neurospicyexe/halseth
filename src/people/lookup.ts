// src/people/lookup.ts -- the PULL path for people (Raziel 2026-11-02): a companion who decides to
// look a person up on Raziel's list reads what Raziel wrote about them.
//
// The PUSH path (graph/people.ts buildFrameIndex, GET /people/frame-index) is rendered lines the bots
// inject when someone is mentioned and never carries the private `note`. This is the other half:
// a Librarian verb, `who is <name>` / `who's <name>` / `look up person <name>` / `tell me about <name>`.
//
// Pure D1 over graph_people + map_keep_off (+ graph_edges for the mention count). It touches no care,
// med, biometric or escalation table, and it is never wired into orient or boot. Any companion may look
// up anyone on the list; the response carries nothing that belongs to another companion.
//
// Resolution is the graph's: label or any spelling (spellingsOf), case-insensitive, whitespace
// collapsed. A spelling claimed by two live entries resolves nobody (ambiguousSpellings). Archived
// rows never resolve (listPeople reads archived = 0 only). Keep-off FAILS CLOSED like the frame index:
// a person whose label, spelling or owner hits is not answered at all, and an unreadable list answers
// nothing about anyone.

import type { Env } from "../types.js";
import {
  ambiguousSpellings, listPeople, renderFrameLine, spellingsOf, isCentreName, normalizeSharesName,
  type GraphPerson, type PersonKind,
} from "../graph/people.js";
import { keepOffMatcher } from "../graph/keep-off.js";
import { careCategory } from "./care-guard.js";

export type LookupVerb = "who" | "tell";

/** Start-anchored, so ordinary speech that merely contains these words is never read as a lookup.
 *  "who is fronting / here / been fronting" are excluded up front (front state owns them); everything
 *  else is only a CANDIDATE: the router checks the name against the live list and falls through to
 *  whatever handled the request before when nobody is there. */
export const PERSON_LOOKUP_RE =
  /^(?:please\s+)?(?:(?:who\s+is|who['’]s|whos|look\s+up\s+person)|tell\s+me\s+about)\s+(?!(?:currently\s+|now\s+)?fronting\b|here\b|been\b)\S/i;

const NAME_MAX_CHARS = 60;
const NAME_MAX_WORDS = 5;

const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();

/** Pull the name out of a lookup request, or null (not a lookup, or not name-shaped). */
export function parsePersonLookup(request: string): { name: string; verb: LookupVerb } | null {
  const t = request.trim();
  if (!PERSON_LOOKUP_RE.test(t)) return null;
  const m = /^(?:please\s+)?(who\s+is|who['’]s|whos|look\s+up\s+person|tell\s+me\s+about)\s+([\s\S]+)$/i.exec(t);
  if (!m) return null;
  const verb: LookupVerb = /^tell/i.test(m[1]!) ? "tell" : "who";
  const name = m[2]!
    .replace(/[\s?!.,;:]+$/g, "")
    .replace(/^['"“”‘’\s]+|['"“”‘’\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!name || name.length > NAME_MAX_CHARS || name.split(" ").length > NAME_MAX_WORDS) return null;
  return { name, verb };
}

export interface PersonLookup {
  label: string;
  kind: PersonKind;
  /** The one-word relation (partner, family, ...), or null. */
  relation: string | null;
  /** Whose system this person is a member of (owner's label), or null. */
  system_of: string | null;
  /** renderFrameLine's finished line (care-guarded and keep-off-guarded like the frame index), or null. */
  frame_line: string | null;
  /** Raziel's note verbatim (trimmed of surrounding whitespace only), or null. */
  note: string | null;
  /** Set when a note exists but is withheld, with the CATEGORY of why, never the term. */
  note_withheld: string | null;
  spellings: string[];
  shares_name_with: string | null;
  /** True when the name asked was the bare label of a shared name. */
  asked_bare_shared_name: boolean;
  /** Kept rows the graph links to them; null when the count could not be read. */
  mentions: number | null;
  /** Centre and self: "<name> is Raziel". */
  is_raziel: boolean;
}

export type PersonLookupResult = { status: "found"; person: PersonLookup } | { status: "none" };

/** Resolve `name` on the live list. "none" covers: nobody by that name, an ambiguous spelling, archived,
 *  kept off, or keep-off unreadable. A caller cannot tell those apart, by design.
 *  `mentionCount` is injected so this module does not import an HTTP handler. */
export async function lookupPerson(
  env: Env, name: string, verb: LookupVerb = "who",
  mentionCount?: (env: Env, personId: string) => Promise<number>,
): Promise<PersonLookupResult> {
  const key = norm(name);
  if (!key) return { status: "none" };
  let keepOff: RegExp | null;
  try { keepOff = await keepOffMatcher(env); } catch { return { status: "none" }; }
  let people: GraphPerson[];
  try { people = await listPeople(env); } catch { return { status: "none" }; }
  const byId = new Map(people.map((p) => [p.id, p]));
  const live = people.filter((p) => p.kind !== "centre");
  const hit = (s: string | null | undefined) => !!s && !!keepOff && keepOff.test(s);

  // The centre: Raziel and Crash are the same node, never a spelling of anyone else.
  const centre = people.find((p) => p.kind === "centre");
  if (isCentreName(name) || (centre && norm(centre.label) === key)) {
    return { status: "found", person: raziel(centre?.label ?? "Raziel") };
  }

  const ambiguous = ambiguousSpellings(live);
  let matched: GraphPerson | undefined;
  let bareShared = false;
  const viaSpelling = live.filter((p) => spellingsOf(p).some((s) => norm(s) === key && !ambiguous.has(s)));
  if (viaSpelling.length === 1) matched = viaSpelling[0];
  else if (viaSpelling.length === 0 && verb === "who") {
    // An explicit "who is <bare shared name>" is a question about a person, not free text the graph
    // would have to guess at, so the bare label of a shared name answers (and says so). "tell me
    // about" never does: "tell me about Barbossa" is as often the film.
    const bare = live.filter((p) => normalizeSharesName(p.shares_name_with) && norm(p.label) === key);
    if (bare.length === 1) { matched = bare[0]; bareShared = true; }
  }
  if (!matched) return { status: "none" };

  const owner = matched.system_of ? byId.get(matched.system_of) : undefined;
  if (hit(matched.label) || matched.match_names.some(hit) || hit(owner?.label)) return { status: "none" };

  if (matched.kind === "self") return { status: "found", person: raziel(matched.label, true) };

  const frameLineOk = !!matched.frame_line && !hit(matched.frame_line) && careCategory(matched.frame_line) === null;
  const note = matched.note?.trim() || null;
  let note_withheld: string | null = null;
  let shownNote = note;
  if (note) {
    const cc = careCategory(note);
    if (hit(note)) { shownNote = null; note_withheld = "it names something on Raziel's keep-off list"; }
    else if (cc) { shownNote = null; note_withheld = `it touches ${cc} words, and care or health detail is never handed to the triad as material`; }
  }
  let mentions: number | null = null;
  if (mentionCount) { try { mentions = await mentionCount(env, matched.id); } catch { mentions = null; } }
  return {
    status: "found",
    person: {
      label: matched.label,
      kind: matched.kind,
      relation: matched.relation,
      system_of: owner ? (owner.kind === "centre" ? "Raziel" : owner.label) : null,
      frame_line: renderFrameLine(matched, byId, frameLineOk),
      note: shownNote,
      note_withheld,
      spellings: spellingsOf(matched),
      shares_name_with: normalizeSharesName(matched.shares_name_with),
      asked_bare_shared_name: bareShared,
      mentions,
      is_raziel: false,
    },
  };
}

function raziel(label: string, self = false): PersonLookup {
  return {
    label, kind: self ? "self" : "centre", relation: null, system_of: null,
    frame_line: `${label} is Raziel${self ? " (one of Raziel's names)" : ""}`,
    note: null, note_withheld: null, spellings: [], shares_name_with: null, asked_bare_shared_name: false,
    mentions: null, is_raziel: true,
  };
}

/** The router's pre-check: does this request name someone on the list? When not, the request falls
 *  through to whatever handled it before this verb existed. */
export async function personLookupApplies(env: Env, request: string): Promise<boolean> {
  const p = parsePersonLookup(request);
  if (!p) return false;
  try { return (await lookupPerson(env, p.name, p.verb)).status === "found"; } catch { return false; }
}
