// src/webmind/sol-hoard-people.ts -- the names the nest must never hold (B62 step 6, mig 0166).
//
// Drevan: the hoard holds nothing about Raziel's body and no facts about Raziel. Every name that
// could carry one is collected here: the centre's names, every live graph_people spelling, every
// roster member. Fails CLOSED: an unreadable list returns undefined and every caller keeps
// nothing new on that pass. Takes a D1 handle (not Env) so both tend paths and the handlers share it.

import type { Env } from "../types.js";
import { listPeople, spellingsOf, CENTRE_NAMES } from "../graph/people.js";
import { personRegex } from "./sol-hoard.js";

export async function loadPersonRegex(db: D1Database): Promise<RegExp | null | undefined> {
  try {
    // listPeople reads env.DB only.
    const [people, roster] = await Promise.all([
      (async () => listPeople({ DB: db } as unknown as Env))(),
      (async () => db.prepare("SELECT name, display_name FROM pk_roster").all<{ name: string; display_name: string | null }>())(),
    ]);
    const names = new Set<string>(CENTRE_NAMES);
    for (const p of people) { names.add(p.label); for (const s of spellingsOf(p)) names.add(s); }
    for (const r of roster.results ?? []) { if (r.name) names.add(r.name); if (r.display_name) names.add(r.display_name); }
    return personRegex(names);
  } catch (err) {
    console.error("[sol-hoard] person list unreadable; the nest keeps nothing new this pass", { error: String(err) });
    return undefined;
  }
}
