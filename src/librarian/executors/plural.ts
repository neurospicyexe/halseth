import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { getCurrentFront, getMember, updateMemberDescription, searchMembers, getFrontHistory, logFrontChange, addMemberNote } from "../backends/plural.js";
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

export async function execPluralGetCurrentFront(ctx: ExecutorContext): Promise<ExecutorResult> {
  const result = await getCurrentFront(ctx.env);
  const text = result.status === "ok"
    ? `${result.front.name} is fronting.`
    : result.status === "no_front"
    ? "No one is currently fronting."
    : "Front state unavailable.";
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, { session_id: "" }, text);
}

/**
 * REPOINTED 2026-08-13 to the live roster (mig 0117), with nullsafe-plural-v2 kept only as a
 * fallback.
 *
 * Why: plural-v2 serves member lookups from a BAKED-IN `src/members.json` -- 512 entries carrying
 * `name` and `pk` only, **no pronouns**. The live PluralKit roster is 538 members with 463 pronouns.
 * So this path was answering from a snapshot 26 members short of reality and structurally unable to
 * report anyone's pronouns. (It also declared its return type as `{name, pk, description}` while the
 * worker returns `{member_id, name}`, so two of three fields were always undefined.)
 *
 * Leaving the old path as the fallback rather than deleting it: if the roster cache is cold, a stale
 * hit still beats nothing -- but it is second, and the roster's own `unavailable` status is preserved
 * when both miss, so "could not look" never renders as "no such member".
 */
export async function execPluralGetMember(ctx: ExecutorContext): Promise<ExecutorResult> {
  const trigger = ctx.entry.triggers.find(t => triggerMatches(ctx.req.request, t));
  const name = extractLookupName(ctx.req.request, ctx.entry.triggers, ctx.req.context)
    ?? (trigger ? extractMemberName(ctx.req.request, trigger) : null);
  if (!name) {
    return { response_key: "witness", witness: "couldn't identify a member name; try 'tell me about Ash'" };
  }

  const lookup = await lookupMember(ctx.env, name);
  if (lookup.status === "found" || lookup.status === "ambiguous" || lookup.status === "candidates") {
    return {
      data: { ...lookup, summary: renderLookup(lookup) },
      meta: { operation: "plural_get_member", source: "pk_roster", status: lookup.status },
    };
  }

  // Roster says absent or unreachable -- try the legacy static list before answering, then report
  // the ROSTER's status if it also misses, because that status carries the not_found/unavailable
  // distinction the legacy path cannot express.
  const member = await getMember(ctx.env, name);
  if (member) {
    return {
      data: member,
      meta: { operation: "plural_get_member", source: "plural-v2-static", warning: "stale snapshot; no pronouns recorded in this source" },
    };
  }
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
  const updateResult = await updateMemberDescription(ctx.env, parsed.member, parsed.description);
  if (!updateResult.success) {
    return { response_key: "witness", witness: updateResult.error ?? "update failed" };
  }
  return { ack: true, id: updateResult.member_id, name: updateResult.name };
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
  if (lookup.status === "not_found") {
    // Legacy static list as a last look before reporting absence.
    const legacy = await searchMembers(ctx.env, name);
    if (legacy.length) {
      return {
        data: legacy,
        meta: { operation: "plural_search_members", source: "plural-v2-static", warning: "stale snapshot; no pronouns recorded in this source" },
      };
    }
  }
  return {
    data: { ...lookup, summary: renderLookup(lookup) },
    meta: { operation: "plural_search_members", source: "pk_roster", status: lookup.status },
  };
}

export async function execPluralGetFrontHistory(ctx: ExecutorContext): Promise<ExecutorResult> {
  const history = await getFrontHistory(ctx.env);
  // raw: true -- full history array
  return { data: history, meta: { operation: "plural_get_front_history" } };
}

export async function execPluralLogFrontChange(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ member_id: string; status: "fronting" | "co-con" | "unknown"; custom_status?: string }>(ctx.req.context);
  if (!p?.member_id || !p?.status) return { response_key: "witness", witness: "log_front_change requires { member_id, status } in context" };
  const r = await logFrontChange(ctx.env, p);
  if (!r.success) return { response_key: "witness", witness: r.error ?? "log_front_change failed" };
  return { ack: true, front_id: r.front_id ?? null, name: r.name, result: r.result };
}

export async function execPluralAddMemberNote(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ member_id: string; note: string; title?: string; color?: string }>(ctx.req.context);
  if (!p?.member_id || !p?.note) return { response_key: "witness", witness: "add_member_note requires { member_id, note } in context" };
  const r = await addMemberNote(ctx.env, p);
  if (!r.success) return { response_key: "witness", witness: r.error ?? "add_member_note failed" };
  return { ack: true, id: r.id ?? null, member_id: r.member_id, name: r.name };
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
