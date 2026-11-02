// Librarian executor for the people PULL path (Raziel 2026-11-02): `who is <name>`, `who's <name>`,
// `look up person <name>`, `tell me about <name>`. Logic in src/people/lookup.ts. Read-only; the caller's
// identity is irrelevant (any companion may look anyone on Raziel's list up) and nothing here is
// per-companion. The router only sends a request here when the name resolves (personLookupApplies);
// anything else keeps the route it had before this verb existed.

import type { ExecutorContext, ExecutorResult } from "./types.js";
import { lookupPerson, parsePersonLookup } from "../../people/lookup.js";
import { getMentionCounts } from "../../handlers/people.js";

const mentionCount = async (env: ExecutorContext["env"], id: string) => (await getMentionCounts(env)).byNode.get(id) ?? 0;

export async function execPersonWhoIs(ctx: ExecutorContext): Promise<ExecutorResult> {
  const parsed = parsePersonLookup(ctx.req.request);
  const none = { response_key: "witness", witness: "nobody by that name on Raziel's people list." };
  if (!parsed) return none;
  const r = await lookupPerson(ctx.env, parsed.name, parsed.verb, mentionCount);
  if (r.status !== "found") return none;
  const p = r.person;
  if (p.is_raziel) {
    return { response_key: "data", data: { found: true, label: p.label, kind: p.kind, is_raziel: true, answer: p.frame_line } };
  }
  const data: Record<string, unknown> = {
    found: true,
    label: p.label,
    kind: p.kind,
    relation: p.relation,
    system_of: p.system_of,
    frame_line: p.frame_line,
    spellings: p.spellings,
    shares_name_with: p.shares_name_with,
    mentions: p.mentions,
    note_label: "Raziel's note (written by Raziel about this person)",
    note: p.note,
  };
  if (p.note_withheld) data.note_withheld = `Raziel wrote a note, withheld here because ${p.note_withheld}.`;
  if (p.shares_name_with) {
    data.name_caution = `${p.label} is also ${p.shares_name_with}; the film/book character is not them.`
      + (p.asked_bare_shared_name ? " You asked by the bare name: this entry is the person, not the character." : "");
  }
  return { response_key: "data", data };
}
