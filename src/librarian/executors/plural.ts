import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { getCurrentFront, getMember, updateMemberDescription, searchMembers, getFrontHistory, logFrontChange, addMemberNote } from "../backends/plural.js";
import { extractMemberName, extractDescriptionUpdate } from "../extract.js";
import { buildResponse } from "../response/builder.js";
import type { ResponseKey } from "../response/budget.js";

export async function execPluralGetCurrentFront(ctx: ExecutorContext): Promise<ExecutorResult> {
  const result = await getCurrentFront(ctx.env);
  const text = result.status === "ok"
    ? `${result.front.name} is fronting.`
    : result.status === "no_front"
    ? "No one is currently fronting."
    : "Front state unavailable.";
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, { session_id: "" }, text);
}

export async function execPluralGetMember(ctx: ExecutorContext): Promise<ExecutorResult> {
  const trigger = ctx.entry.triggers.find(t => ctx.req.request.toLowerCase().includes(t));
  const name = trigger ? extractMemberName(ctx.req.request, trigger) : null;
  if (!name) {
    return { response_key: "witness", witness: "couldn't identify a member name; try 'tell me about Ash'" };
  }
  const member = await getMember(ctx.env, name);
  if (!member) {
    return { response_key: "witness", witness: `couldn't find member '${name}'` };
  }
  // raw: true -- full member record, no shaping
  return { data: member, meta: { operation: "plural_get_member" } };
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

export async function execPluralSearchMembers(ctx: ExecutorContext): Promise<ExecutorResult> {
  const members = await searchMembers(ctx.env, ctx.req.request);
  // raw: true -- full member array
  return { data: members, meta: { operation: "plural_search_members" } };
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
