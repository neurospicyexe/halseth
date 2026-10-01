import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { readFront, readFrontHistory } from "../../front/source.js";
import { extractMemberName, extractDescriptionUpdate } from "../extract.js";
import {
  listSystemMembers, recallAlter, findMemberByName,
  logAlterNote, logFrontEvent,
} from "../backends/plural-store.js";
import { buildResponse } from "../response/builder.js";
import type { ResponseKey } from "../response/budget.js";
import { triggerMatches } from "../lib/trigger.js";
import { lookupMember, renderLookup } from "../../roster/pk-roster.js";
import { extractLookupName } from "./roster.js";

// Front reads go through src/front/source.ts (B43, 2026-09-30). "Unknown" is never rendered as
// "no one is fronting": the retired SimplyPlural binding did exactly that, and a companion took it
// as a fact about the system.
export async function execPluralGetCurrentFront(ctx: ExecutorContext): Promise<ExecutorResult> {
  const result = await readFront(ctx.env);
  const text = result.status === "ok"
    ? `${result.name} is fronting.`
    : `Front state unknown (${result.reason}). Read who is fronting from Raziel; do not assume no one is.`;
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, { session_id: "" }, text);
}

/** The three SimplyPlural WRITE verbs keep their routes so the phrase cannot fall to the classifier
 *  and land on some other write; they answer that nothing was written, and why. */
function retiredWrite(what: string): ExecutorResult {
  return {
    response_key: "witness",
    witness: `nothing written: ${what} went to SimplyPlural, which was retired 2026-09-30 (the new plural app has no API yet). ` +
      `For a note about a system member, use "log alter note" (Halseth's own store).`,
    ack: false,
  };
}

/**
 * REPOINTED 2026-08-13 to the live roster (mig 0117). The nullsafe-plural-v2 static fallback was
 * removed with the SimplyPlural binding on 2026-09-30 (B43); the roster is the only source.
 *
 * Why: plural-v2 serves member lookups from a BAKED-IN `src/members.json` -- 512 entries carrying
 * `name` and `pk` only, **no pronouns**. The live PluralKit roster is 538 members with 463 pronouns.
 * So this path was answering from a snapshot 26 members short of reality and structurally unable to
 * report anyone's pronouns. (It also declared its return type as `{name, pk, description}` while the
 * worker returns `{member_id, name}`, so two of three fields were always undefined.)
 *
 * The roster's own `unavailable` status is returned as-is, so "could not look" never renders as
 * "no such member".
 */
export async function execPluralGetMember(ctx: ExecutorContext): Promise<ExecutorResult> {
  const trigger = ctx.entry.triggers.find(t => triggerMatches(ctx.req.request, t));
  const name = extractLookupName(ctx.req.request, ctx.entry.triggers, ctx.req.context)
    ?? (trigger ? extractMemberName(ctx.req.request, trigger) : null);
  if (!name) {
    return { response_key: "witness", witness: "couldn't identify a member name; try 'tell me about Ash'" };
  }

  const lookup = await lookupMember(ctx.env, name);
  return {
    data: { ...lookup, summary: renderLookup(lookup) },
    meta: { operation: "plural_get_member", source: "pk_roster", status: lookup.status },
  };
}

export async function execPluralUpdateMemberDescription(ctx: ExecutorContext): Promise<ExecutorResult> {
  const parsed = extractDescriptionUpdate(ctx.req.request);
  if (!parsed) {
    return { response_key: "witness", witness: "couldn't parse that; try 'update Ash\\'s description to [text]'" };
  }
  return retiredWrite(`the description update for ${parsed.member}`);
}

/**
 * REPOINTED 2026-08-13 to the live roster (mig 0117). Same reason as `execPluralGetMember`.
 *
 * Second defect fixed here: this used to pass `ctx.req.request` -- the ENTIRE request sentence --
 * as the search query, so "search members for Magpie" was substring-matched against member names
 * and matched nothing. The name is extracted now.
 */
export async function execPluralSearchMembers(ctx: ExecutorContext): Promise<ExecutorResult> {
  const name = extractLookupName(ctx.req.request, ctx.entry.triggers, ctx.req.context);
  if (!name) {
    return { response_key: "witness", witness: "couldn't read a name to search for; try 'find member Magpie'" };
  }
  const lookup = await lookupMember(ctx.env, name);
  return {
    data: { ...lookup, summary: renderLookup(lookup) },
    meta: { operation: "plural_search_members", source: "pk_roster", status: lookup.status },
  };
}

export async function execPluralGetFrontHistory(ctx: ExecutorContext): Promise<ExecutorResult> {
  const history = await readFrontHistory(ctx.env);
  if (history.status === "unknown") {
    // Never an empty array: [] reads as "no one has fronted".
    return { response_key: "witness", witness: `front history unknown (${history.reason})`, ack: false, status: "unknown" };
  }
  return { data: history.events, meta: { operation: "plural_get_front_history" } };
}

export async function execPluralLogFrontChange(ctx: ExecutorContext): Promise<ExecutorResult> {
  return retiredWrite("the front change");
}

export async function execPluralAddMemberNote(ctx: ExecutorContext): Promise<ExecutorResult> {
  return retiredWrite("the member note");
}

// ── Halseth-native plural store executors (D1) ──

export async function execLogAlterNote(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ member_name: string; note: string }>(ctx.req.context);
  const memberName = p?.member_name ?? extractMemberName(ctx.req.request, "log alter note");
  const note = p?.note;
  if (!memberName || !note) {
    return { response_key: "witness", witness: "log_alter_note needs member_name and note in context" };
  }
  const member = await findMemberByName(ctx.env, memberName);
  if (!member) return { response_key: "witness", witness: `member '${memberName}' not found -- use list_members to see available members` };
  const id = await logAlterNote(ctx.env, member.id, note, ctx.req.companion_id, null);
  return { ack: true, note_id: id, member_name: member.name };
}

export async function execFrontUpdate(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ member_name: string; status: "fronting" | "co-con" | "unknown"; custom_status?: string }>(ctx.req.context);
  const memberName = p?.member_name ?? extractMemberName(ctx.req.request, "who is fronting");
  if (!memberName || !p?.status) {
    return { response_key: "witness", witness: "front_update needs member_name and status (fronting/co-con/unknown) in context" };
  }
  const member = await findMemberByName(ctx.env, memberName);
  if (!member) return { response_key: "witness", witness: `member '${memberName}' not found` };
  const id = await logFrontEvent(ctx.env, member.id, p.status, p.custom_status ?? null, null);
  return { ack: true, front_event_id: id, member_name: member.name, status: p.status };
}

export async function execAlterRecall(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ member_name: string }>(ctx.req.context);
  const memberName = p?.member_name ?? extractMemberName(ctx.req.request, "recall alter");
  if (!memberName) {
    return { response_key: "witness", witness: "couldn't extract a member name; try 'recall alter Ash' or pass member_name in context" };
  }
  const result = await recallAlter(ctx.env, memberName);
  if (!result.member) return { response_key: "witness", witness: `member '${memberName}' not found` };
  return { data: result, meta: { operation: "halseth_alter_recall" } };
}

export async function execListMembers(ctx: ExecutorContext): Promise<ExecutorResult> {
  const members = await listSystemMembers(ctx.env);
  return { data: members, meta: { operation: "halseth_list_members" } };
}
