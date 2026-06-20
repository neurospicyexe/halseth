// Librarian executors for the agency layer (migration 0086): refusal + chosen preferences.
//
// Owner is ALWAYS ctx.req.companion_id (Librarian-authenticated), so a companion can only ever
// refuse/prefer as itself and read only its own.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  insertRefusal, readRefusals, withdrawRefusal,
  setPreference, readPreferences, retirePreference,
} from "../../handlers/agency.js";

// "I refuse / I decline this" -- { subject_text, reason?, subject_type?, subject_ref? }.
export async function execRefuse(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ subject_text?: string; subject?: string; text?: string; reason?: string; subject_type?: string; subject_ref?: string }>(ctx.req.context);
  const subject_text = p?.subject_text ?? p?.subject ?? p?.text ?? (ctx.req.context && !p ? ctx.req.context : undefined);
  if (!subject_text || !subject_text.trim()) {
    return { error: "refuse_failed", reason: "missing subject_text (what are you refusing?)" };
  }
  const out = await insertRefusal(ctx.env, ctx.req.companion_id, {
    subject_text, reason: p?.reason ?? null, subject_type: p?.subject_type, subject_ref: p?.subject_ref ?? null,
  });
  return {
    response_key: "witness",
    witness: out.task_declined ? "noted -- your no stands; the task is declined" : "noted -- your no stands",
    ack: true, id: out.id, task_declined: out.task_declined,
  };
}

export async function execRefusalsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ status?: string; limit?: number }>(ctx.req.context);
  const rows = await readRefusals(ctx.env, ctx.req.companion_id, p?.status, p?.limit ?? 50);
  return { response_key: "refusals", refusals: rows, meta: { operation: "refusals_read", companion_id: ctx.req.companion_id, count: rows.length } };
}

export async function execRefusalWithdraw(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string }>(ctx.req.context);
  if (!p?.id) return { error: "refusal_withdraw_failed", reason: "missing id" };
  const ok = await withdrawRefusal(ctx.env, ctx.req.companion_id, p.id);
  return { response_key: "witness", witness: ok ? "withdrawn" : "no change (not found, not yours, or not standing)", ack: ok };
}

// "I prefer X" -- { preference, domain?, strength? }.
export async function execPreferenceSet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ preference?: string; text?: string; domain?: string; strength?: string }>(ctx.req.context);
  const preference = p?.preference ?? p?.text ?? (ctx.req.context && !p ? ctx.req.context : undefined);
  if (!preference || !preference.trim()) {
    return { error: "preference_set_failed", reason: "missing preference (pass { preference } in context)" };
  }
  const out = await setPreference(ctx.env, ctx.req.companion_id, { preference, domain: p?.domain, strength: p?.strength });
  return { response_key: "witness", witness: "held -- this preference stands", ack: true, id: out.id };
}

export async function execPreferencesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await readPreferences(ctx.env, ctx.req.companion_id);
  return { response_key: "preferences", preferences: rows, meta: { operation: "preferences_read", companion_id: ctx.req.companion_id, count: rows.length } };
}

export async function execPreferenceDrop(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string }>(ctx.req.context);
  if (!p?.id) return { error: "preference_drop_failed", reason: "missing id" };
  const ok = await retirePreference(ctx.env, ctx.req.companion_id, p.id);
  return { response_key: "witness", witness: ok ? "retired" : "no change (not found, not yours, or already retired)", ack: ok };
}
