import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  addCompanionNote, companionJournalAdd, feelingLog, journalAdd, dreamLog, woundAdd, deltaLog, eqSnapshot,
  taskAdd, taskUpdateStatus, taskList, handoverRead, routineLog, listAdd, listItemComplete,
  eventAdd, biometricLog, auditLog, witnessLog, setAutonomousTurn, claimDreamSeed,
  bridgePull, getDrevanState, addLiveThread, closeLiveThread, vetoProposedThread,
  setAnticipation, updateCompanionState, type CompanionStateUpdate,
} from "../backends/halseth.js";
import { buildResponse } from "../response/builder.js";
import type { ResponseKey } from "../response/budget.js";

export async function execCompanionNoteAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const toMatch = ctx.req.request.match(/(to|for)\s+(drevan|cypher|gaia)/i);
  const to_id = toMatch?.[2]?.toLowerCase() ?? null;
  const content = ctx.req.context ?? ctx.req.request;
  if (to_id) {
    // Addressed to another companion — inter_companion_notes
    const note = await addCompanionNote(ctx.env, ctx.req.companion_id, to_id, content);
    return { ack: true, id: note.id };
  }
  // Self-note or unaddressed — companion_journal (visible in Hearth)
  const r = await companionJournalAdd(ctx.env, ctx.req.companion_id, content);
  return { ack: true, id: r.id };
}

export async function execFeelingLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ emotion: string; sub_emotion?: string; intensity?: number; source?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.emotion) return { response_key: "witness", witness: "feeling_log requires { emotion } in context" };
  const r = await feelingLog(ctx.env, { companion_id: ctx.req.companion_id, ...p });
  return { ack: true, id: r.id, logged_at: r.created_at };
}

export async function execJournalAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ entry_text: string; emotion_tag?: string; sub_emotion?: string; mood_score?: number; tags?: string }>(ctx.req.context);
  if (!p || !p.entry_text) return { response_key: "witness", witness: "journal_add requires { entry_text } in context" };
  const r = await journalAdd(ctx.env, p);
  return { ack: true, id: r.id, created_at: r.created_at };
}

export async function execDreamLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ dream_type: string; content: string; source_ids?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.dream_type || !p.content) return { response_key: "witness", witness: "dream_log requires { dream_type, content } in context" };
  const r = await dreamLog(ctx.env, { companion_id: ctx.req.companion_id, ...p });
  return { ack: true, id: r.id };
}

export async function execWoundAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ name: string; description: string; witness_type: string }>(ctx.req.context);
  if (!p || !p.name || !p.description || !p.witness_type) return { response_key: "witness", witness: "wound_add requires { name, description, witness_type } in context" };
  const r = await woundAdd(ctx.env, p);
  if ("error" in r) return { response_key: "witness", witness: r.error };
  return { ack: true, id: r.id };
}

export async function execDeltaLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ agent: string; delta_text: string; valence: string; initiated_by?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.agent || !p.delta_text || !p.valence) return { response_key: "witness", witness: "delta_log requires { agent, delta_text, valence } in context" };
  const r = await deltaLog(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execEqSnapshot(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await eqSnapshot(ctx.env, ctx.req.companion_id);
  return { ack: true, ...r };
}

export async function execTaskAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ title: string; description?: string; priority?: string; due_at?: string; assigned_to?: string; created_by?: string; shared?: boolean }>(ctx.req.context);
  if (!p || !p.title) return { response_key: "witness", witness: "task_add requires { title } in context" };
  const r = await taskAdd(ctx.env, p);
  return { ack: true, id: r.id, title: r.title, status: r.status };
}

export async function execTaskUpdateStatus(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string; status: string }>(ctx.req.context);
  if (!p || !p.id || !p.status) return { response_key: "witness", witness: "task_update_status requires { id, status } in context" };
  const r = await taskUpdateStatus(ctx.env, p.id, p.status);
  if ("error" in r) return { response_key: "witness", witness: r.error };
  return { ack: true, id: r.id, status: r.status };
}

export async function execTaskList(ctx: ExecutorContext): Promise<ExecutorResult> {
  const tasks = await taskList(ctx.env, ctx.req.companion_id);
  const summary = tasks.length === 0
    ? "No open tasks."
    : tasks.map((t: unknown) => {
        const task = t as { title: string; priority: string };
        return `[${task.priority}] ${task.title}`;
      }).join("\n");
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, { session_id: "" }, summary);
}

export async function execHandoverRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const handover = await handoverRead(ctx.env);
  return { data: handover ?? "No handover packet found.", meta: { operation: "halseth_handover_read" } };
}

export async function execRoutineLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ routine_name: string; owner?: string; notes?: string }>(ctx.req.context);
  if (!p || !p.routine_name) return { response_key: "witness", witness: "routine_log requires { routine_name } in context" };
  const r = await routineLog(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execListAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ list_name: string; item_text: string; added_by?: string; shared?: boolean }>(ctx.req.context);
  if (!p || !p.list_name || !p.item_text) return { response_key: "witness", witness: "list_add requires { list_name, item_text } in context" };
  const r = await listAdd(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execListItemComplete(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p || !p.id) return { response_key: "witness", witness: "list_item_complete requires { id } in context" };
  const r = await listItemComplete(ctx.env, p.id);
  if ("error" in r) return { response_key: "witness", witness: r.error };
  return { ack: true, id: r.id, completed: true };
}

export async function execEventAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ title: string; start_time: string; end_time?: string; description?: string; category?: string; attendees?: string[]; created_by?: string; shared?: boolean }>(ctx.req.context);
  if (!p || !p.title || !p.start_time) return { response_key: "witness", witness: "event_add requires { title, start_time } in context" };
  const r = await eventAdd(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execBiometricLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ recorded_at: string; hrv_resting?: number; resting_hr?: number; sleep_hours?: number; sleep_quality?: string; stress_score?: number; steps?: number; active_energy?: number; notes?: string }>(ctx.req.context);
  if (!p || !p.recorded_at) return { response_key: "witness", witness: "biometric_log requires { recorded_at } in context" };
  const r = await biometricLog(ctx.env, p);
  return { ack: true, id: r.id, logged_at: r.logged_at };
}

export async function execAuditLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ session_id: string; entry_type: string; content: string; verdict_tag?: string; supersedes_id?: string }>(ctx.req.context);
  if (!p || !p.session_id || !p.entry_type || !p.content) return { response_key: "witness", witness: "audit_log requires { session_id, entry_type, content } in context" };
  const r = await auditLog(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execWitnessLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ session_id: string; witness_type: string; content: string; seal_phrase?: string }>(ctx.req.context);
  if (!p || !p.session_id || !p.witness_type || !p.content) return { response_key: "witness", witness: "witness_log requires { session_id, witness_type, content } in context" };
  const r = await witnessLog(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execSetAutonomousTurn(ctx: ExecutorContext): Promise<ExecutorResult> {
  const ORDER = ["drevan", "cypher", "gaia"] as const;
  type Turn = typeof ORDER[number];
  let companion: Turn | null;
  if (/next\s+companion|advance\s+turn|pass\s+turn|next\s+after/i.test(ctx.req.request)) {
    // Rotate from current companion -- prevents "next companion after drevan" from matching
    // "drevan" and leaving the turn unchanged.
    const idx = ORDER.indexOf(ctx.req.companion_id as Turn);
    const nextIdx = (idx === -1 ? 1 : (idx + 1) % ORDER.length) as 0 | 1 | 2;
    companion = ORDER[nextIdx];
  } else {
    companion = /drevan/i.test(ctx.req.request) ? "drevan"
      : /cypher/i.test(ctx.req.request) ? "cypher"
      : /gaia/i.test(ctx.req.request) ? "gaia"
      : null;
  }
  if (!companion) return { response_key: "witness", witness: "set_autonomous_turn: include a companion name or 'next companion' in request" };
  await setAutonomousTurn(ctx.env, companion);
  return { ack: true, id: "house_state", autonomous_turn: companion };
}

export async function execClaimDreamSeed(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "claim_dream_seed requires { id } in context" };
  const r = await claimDreamSeed(ctx.env, p.id, ctx.req.companion_id);
  return { ack: r.ok, seed_id: p.id, claimed_by: ctx.req.companion_id };
}

export async function execBridgePull(ctx: ExecutorContext): Promise<ExecutorResult> {
  const data = await bridgePull(ctx.env);
  return { data };
}

export async function execDrevanStateGet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const data = await getDrevanState(ctx.env);
  return { data };
}

export async function execLiveThreadAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ name: string; flavor?: string; charge?: string; notes?: string }>(ctx.req.context);
  if (!p?.name) return { response_key: "witness", witness: "live_thread_add requires { name } in context" };
  const r = await addLiveThread(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execLiveThreadClose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "live_thread_close requires { id } in context" };
  const r = await closeLiveThread(ctx.env, p.id);
  return { ack: r.ok, id: p.id };
}

export async function execLiveThreadVeto(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "live_thread_veto requires { id } in context" };
  const r = await vetoProposedThread(ctx.env, p.id);
  return { ack: r.ok, id: p.id };
}

export async function execAnticipationSet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ active: boolean; target?: string; intensity?: number }>(ctx.req.context);
  if (p === null || typeof p.active !== "boolean") return { response_key: "witness", witness: "anticipation_set requires { active: boolean, target?, intensity? } in context" };
  const r = await setAnticipation(ctx.env, p);
  return { ack: r.ok };
}

export async function execStateUpdate(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<CompanionStateUpdate>(ctx.req.context);
  if (!p || Object.keys(p).length === 0) return { error: "state_update_failed", reason: "no fields provided; pass at least one of: soma_float_1, current_mood, compound_state, surface_emotion, etc." };
  const r = await updateCompanionState(ctx.env, ctx.req.companion_id, p);
  if (!r.ok) return { error: "state_update_failed", reason: "no valid fields provided" };
  return { ack: true, updated: ctx.req.companion_id };
}
