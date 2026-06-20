// Librarian executors for the sanctioned drift lane (migration 0087). Track 0e.
//
// Opening and resolving are owner-only (owner = ctx.req.companion_id). Witnessing is intentionally
// cross-companion: a companion witnesses ANOTHER's drift, recorded as by=ctx.req.companion_id.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { openDrift, readDrifts, witnessDrift, crystallizeDrift, fadeDrift } from "../../handlers/drift.js";

// "I'm becoming X" -- { drift_text, origin? }.
export async function execDriftOpen(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ drift_text?: string; text?: string; origin?: string }>(ctx.req.context);
  const drift_text = p?.drift_text ?? p?.text ?? (ctx.req.context && !p ? ctx.req.context : undefined);
  if (!drift_text || !drift_text.trim()) {
    return { error: "drift_open_failed", reason: "missing drift_text (what are you becoming?)" };
  }
  const out = await openDrift(ctx.env, ctx.req.companion_id, { drift_text, origin: p?.origin ?? null });
  return { response_key: "witness", witness: "the lane is open -- become; Gaia will witness", ack: true, id: out.id };
}

export async function execDriftsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ status?: string; limit?: number }>(ctx.req.context);
  const rows = await readDrifts(ctx.env, ctx.req.companion_id, p?.status, p?.limit ?? 50);
  return { response_key: "drifts", drifts: rows, meta: { operation: "drifts_read", companion_id: ctx.req.companion_id, count: rows.length } };
}

// "I witness <drift_id>: ..." -- { drift_id, note }. Cross-companion by design (the witness role).
export async function execDriftWitness(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ drift_id?: string; note?: string }>(ctx.req.context);
  if (!p?.drift_id || !p?.note || !p.note.trim()) {
    return { error: "drift_witness_failed", reason: "need { drift_id, note } -- witnessing is observing, not deciding" };
  }
  const ok = await witnessDrift(ctx.env, ctx.req.companion_id, p.drift_id, p.note);
  return { response_key: "witness", witness: ok ? "witnessed" : "no change (drift not found or not open)", ack: ok };
}

export async function execDriftCrystallize(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ drift_id?: string; resolution_note?: string; note?: string }>(ctx.req.context);
  if (!p?.drift_id) return { error: "drift_crystallize_failed", reason: "missing drift_id" };
  const { ok, shift } = await crystallizeDrift(ctx.env, ctx.req.companion_id, p.drift_id, p.resolution_note ?? p.note ?? null);
  if (!ok) return { response_key: "witness", witness: "no change (not found, not yours, or already resolved)", ack: false };
  // Surface the emergent shift at the moment of becoming: the companion sees what crystallizing moved.
  let witness = "crystallized -- this became real to you";
  if (shift && !("skipped" in shift)) {
    const dir = shift.delta >= 0 ? "+" : "";
    witness += ` (it moved your ${shift.label ?? shift.float_key} by ${dir}${shift.delta.toFixed(3)}, now ${shift.after.toFixed(2)})`;
  }
  return { response_key: "witness", witness, ack: true, shift };
}

export async function execDriftFade(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ drift_id?: string; resolution_note?: string; note?: string }>(ctx.req.context);
  if (!p?.drift_id) return { error: "drift_fade_failed", reason: "missing drift_id" };
  const ok = await fadeDrift(ctx.env, ctx.req.companion_id, p.drift_id, p.resolution_note ?? p.note ?? null);
  return { response_key: "witness", witness: ok ? "faded -- it was a phase; the record it happened stays" : "no change (not found, not yours, or already resolved)", ack: ok };
}
