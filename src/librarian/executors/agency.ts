// Librarian executors for the agency layer (migration 0086): refusal + chosen preferences.
//
// Owner is ALWAYS ctx.req.companion_id (Librarian-authenticated), so a companion can only ever
// refuse/prefer as itself and read only its own.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { stripPrivateMarker } from "../../webmind/interests.js";
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

/**
 * Split "<preference> because <why>" (B62, mig 0161). The first " because " ends the preference; a
 * trailing "(private)" / "keep the why private" marks the why private. No "because" = no why, and
 * the preference text is returned untouched (the pre-0161 parse).
 */
export function splitPreferenceWhy(raw: string): { preference: string; why: string | null; why_private: boolean } {
  const m = /^([\s\S]*?)\s*[,;]?\s+because\b[\s,:]*([\s\S]*)$/i.exec(raw);
  if (!m || !m[1]!.trim()) return { preference: raw, why: null, why_private: false };
  const p = stripPrivateMarker(m[2] ?? "");
  return { preference: m[1]!.trim(), why: p.text.trim() || null, why_private: p.why_private };
}

// "I prefer X [because Y]" -- { preference, domain?, strength?, why?, why_private? }.
export async function execPreferenceSet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ preference?: string; text?: string; domain?: string; strength?: string; why?: string; why_private?: boolean }>(ctx.req.context);
  const rawPref = p?.preference ?? p?.text ?? (ctx.req.context && !p ? ctx.req.context : undefined);
  if (!rawPref || !rawPref.trim()) {
    return { error: "preference_set_failed", reason: "missing preference (pass { preference } in context)" };
  }
  const split = splitPreferenceWhy(rawPref);
  const why = (p?.why && p.why.trim()) ? p.why.trim() : split.why;
  const out = await setPreference(ctx.env, ctx.req.companion_id, {
    preference: split.preference, domain: p?.domain, strength: p?.strength,
    why, why_private: p?.why_private ?? split.why_private,
  });
  return {
    response_key: "witness",
    witness: why
      ? "held -- this preference stands, and your why is on the trail"
      : 'held -- this preference stands (add "because <why>" next time and it joins the trail)',
    ack: true, id: out.id,
  };
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
