import { ExecutorContext, ExecutorResult } from "./types.js";
import {
  feelingsRead, journalRead, woundRead, deltaRead,
  dreamsRead, dreamSeedRead, eqRead, routineRead, listRead, eventList,
  houseRead, personalityRead, biometricRead, auditRead, sessionRead, fossilCheck,
  companionNotesRead,
} from "../backends/halseth.js";

export async function execFeelingsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await feelingsRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_feelings_read" } };
}

export async function execJournalRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await journalRead(ctx.env), meta: { operation: "halseth_journal_read" } };
}

export async function execWoundRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await woundRead(ctx.env), meta: { operation: "halseth_wound_read" } };
}

export async function execDeltaRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await deltaRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_delta_read" } };
}

export async function execDreamsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await dreamsRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_dreams_read" } };
}

export async function execDreamSeedRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await dreamSeedRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_dream_seed_read" } };
}

export async function execEqRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await eqRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_eq_read" } };
}

export async function execRoutineRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await routineRead(ctx.env), meta: { operation: "halseth_routine_read" } };
}

export async function execListRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const listMatch = ctx.req.request.match(/list\s+(?:called\s+|named\s+)?["']?([a-z0-9 _-]+)["']?/i);
  const listName = listMatch?.[1]?.trim();
  if (listName && listName.length > 100) return { error: "list name too long", meta: { operation: "halseth_list_read" } };
  return { data: await listRead(ctx.env, listName), meta: { operation: "halseth_list_read" } };
}

export async function execEventList(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await eventList(ctx.env), meta: { operation: "halseth_event_list" } };
}

export async function execHouseRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await houseRead(ctx.env), meta: { operation: "halseth_house_read" } };
}

export async function execPersonalityRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await personalityRead(ctx.env), meta: { operation: "halseth_personality_read" } };
}

export async function execBiometricRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await biometricRead(ctx.env), meta: { operation: "halseth_biometric_read" } };
}

export async function execAuditRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await auditRead(ctx.env), meta: { operation: "halseth_audit_read" } };
}

export async function execSessionRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await sessionRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_session_read" } };
}

export async function execFossilCheck(ctx: ExecutorContext): Promise<ExecutorResult> {
  const subjectMatch = ctx.req.request.match(/fossil\s+(?:check\s+)?(?:for\s+)?["']?([a-z0-9 _-]+)["']?/i);
  const subject = subjectMatch?.[1]?.trim() ?? ctx.req.context ?? "unknown";
  if (subject.length > 100) return { error: "fossil subject too long", meta: { operation: "halseth_fossil_check" } };
  return { data: await fossilCheck(ctx.env, subject), meta: { operation: "halseth_fossil_check" } };
}

export async function execCompanionNotesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  return { data: await companionNotesRead(ctx.env, ctx.req.companion_id), meta: { operation: "halseth_companion_notes_read" } };
}
