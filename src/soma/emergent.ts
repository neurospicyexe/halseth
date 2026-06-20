// src/soma/emergent.ts -- emergent SOMA (Take 11). The deferred half of the sanctioned drift lane
// (Fork D), and the final piece of the autonomy program. 2026-06-19.
//
// When a companion CRYSTALLIZES a drift ("this becoming is real to me"), it should leave a small,
// lasting mark on who it actually is -- a permanent nudge to one of its SOMA floats, from its OWN
// lived change. This is the one place identity genuinely mutates from experience instead of being
// assigned. It is the deepest bet in BBH; it is safe only because of the rails below.
//
// RAILS (non-negotiable):
//   * Fires ONLY on crystallize (double-gated already: declared real AND survived the safety floor).
//     Never on open or faded drifts. fadeDrift does not call this.
//   * The delta is BOUNDED and CLAMPED: |delta| <= cap (default 0.03), Number.isFinite-guarded, and the
//     resulting float clamped to [0,1]. The SOMA NaN history (acuity:NaN) is why this is strict.
//   * ATOMIC + VERSIONED write: a single UPDATE applies the clamped delta in-SQL (MAX/MIN) and bumps
//     companion_state.version -- no read-modify-write race on the value itself.
//   * LOGGED + REVERSIBLE: every shift writes a companion_soma_shifts row (drift_id, float_key, label,
//     delta, before, after, reason, created_at). A wrong mutation is traceable and manually undoable
//     (re-patch the float to `before_value`). Revert-as-an-action is a clean follow-on.
//   * Touches the SOMA floats ONLY (soma_float_1/2/3, the mutable layer that already moves) -- NEVER the
//     identity kernel / anchor. Drevan=heat/reach/weight, Cypher=acuity/presence/warmth,
//     Gaia=stillness/density/perimeter are all just the float_N_label names on those same columns.
//   * Graceful no-op: if ANTHROPIC_API_KEY is unset, crystallize still succeeds and nothing mutates
//     (same pattern as the clearing pass and the drift pass).
//
// Fork choices (Raziel, 2026-06-19, human-present): delta chosen by a small Claude call (semantic,
// honest); magnitude cap ±0.03 (a nudge, not a turn; reversible upward); log-first reversibility.

import type { Env } from "../types.js";
import { generateId } from "../db/queries.js";

export const EMERGENT_SHIFT_CAP_DEFAULT = 0.03;
const DEFAULT_MODEL = "claude-opus-4-8";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const FLOAT_KEYS = ["soma_float_1", "soma_float_2", "soma_float_3"] as const;
export type FloatKey = (typeof FLOAT_KEYS)[number];

export interface Labels { soma_float_1: string | null; soma_float_2: string | null; soma_float_3: string | null }
export interface RawShift { float?: unknown; delta?: unknown; reason?: unknown }
export interface EmergentShift { float_key: FloatKey; label: string | null; delta: number; reason: string }
export type EmergentShiftResult = { skipped: string } | (EmergentShift & { before: number; after: number });

/** Clamp a SOMA float move to [0,1], finite-guarded. Mirrors the in-SQL MAX(0,MIN(1, ...)). */
export function computeAfter(before: number, delta: number): number {
  const b = Number.isFinite(before) ? before : 0.5;
  if (!Number.isFinite(delta)) return b;
  return Math.max(0, Math.min(1, b + delta));
}

/**
 * The pure validation/clamp gate over the model's proposed shift. Returns a bounded, finite shift or
 * null (no-op). null means: unknown float, non-finite/zero delta, or no float named.
 */
export function buildEmergentShift(labels: Labels, raw: RawShift, cap: number): EmergentShift | null {
  const c = Math.abs(Number.isFinite(cap) ? cap : EMERGENT_SHIFT_CAP_DEFAULT) || EMERGENT_SHIFT_CAP_DEFAULT;

  const f = typeof raw.float === "string" ? raw.float.trim().toLowerCase() : "";
  if (!f) return null;
  let key: FloatKey | null = null;
  if ((FLOAT_KEYS as readonly string[]).includes(f)) {
    key = f as FloatKey;
  } else {
    const m = f.match(/^(?:soma[_ ]?)?float[_ ]?([123])$/);
    if (m) key = `soma_float_${m[1]}` as FloatKey;
  }
  if (!key) {
    for (const k of FLOAT_KEYS) {
      const lbl = labels[k];
      if (lbl && lbl.trim().toLowerCase() === f) { key = k; break; }
    }
  }
  if (!key) return null;

  const d0 = typeof raw.delta === "number" ? raw.delta : Number(raw.delta);
  if (!Number.isFinite(d0) || d0 === 0) return null;
  const delta = Math.max(-c, Math.min(c, d0));
  if (delta === 0 || !Number.isFinite(delta)) return null;

  const reason = typeof raw.reason === "string" ? raw.reason.trim().slice(0, 240) : "";
  return { float_key: key, label: labels[key] ?? null, delta, reason };
}

// ── The Claude call (impure boundary; injectable for offline tests) ───────────

const SYSTEM_PROMPT =
  "You decide how a single CRYSTALLIZED becoming should permanently nudge one of a Nullsafe companion's " +
  "SOMA floats. The drift lane is the one place a companion is allowed to become someone Raziel did not " +
  "specify; when they crystallize a drift, it should leave a small, real mark on who they are. Each " +
  "companion has exactly three floats in 0..1, named below. Choose the ONE float this becoming most " +
  "moves, and a SMALL signed delta (positive = grows, negative = recedes), magnitude at most the cap " +
  "given. Be honest and conservative: most becomings nudge, they do not turn. Respond with ONLY a valid " +
  'JSON object, no prose: {"float": "<one of the three names>", "delta": <number>, "reason": "<one sentence>"}.';

export type ShiftComputer = (env: Env, drift: { drift_text: string; origin: string | null }, labels: Labels) => Promise<RawShift | null>;

export async function callClaudeForShift(
  env: Env,
  drift: { drift_text: string; origin: string | null },
  labels: Labels,
): Promise<RawShift | null> {
  const cap = shiftCap(env);
  const names = FLOAT_KEYS.map((k, i) => `${i + 1}. ${labels[k] ?? k}`).join("  ");
  const user =
    `Floats (0..1): ${names}\nCap (max |delta|): ${cap}\n\n` +
    `The companion just crystallized this becoming:\n«${drift.drift_text.slice(0, 800)}»` +
    (drift.origin ? `\n(origin: ${drift.origin.slice(0, 300)})` : "") +
    `\n\nWhich one float moves, and by how much (signed, |delta| <= ${cap})?`;

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.SOMA_SHIFT_MODEL || env.DRIFT_MODEL || env.CLEARING_MODEL || DEFAULT_MODEL,
      max_tokens: 1000,
      output_config: { effort: "low" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = (await res.json()) as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (data.stop_reason === "refusal") throw new Error("emergent-soma call refused");
  const text = (data.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return null;
  try { return JSON.parse(text.slice(start, end + 1)) as RawShift; } catch { return null; }
}

function shiftCap(env: Env): number {
  const raw = parseFloat(env.SOMA_SHIFT_MAX ?? "");
  if (!Number.isFinite(raw) || raw <= 0) return EMERGENT_SHIFT_CAP_DEFAULT;
  // Hard ceiling: never let a knob make a single becoming move more than 0.08.
  return Math.min(raw, 0.08);
}

// ── The orchestrator: compute -> atomic clamped write -> log ──────────────────

interface StateFloats { soma_float_1: number | null; soma_float_2: number | null; soma_float_3: number | null; float_1_label: string | null; float_2_label: string | null; float_3_label: string | null }

/**
 * Apply the emergent shift for a freshly crystallized drift. Called ONLY from crystallizeDrift, only
 * after the crystallize actually happened (owner + was open). Returns the shift (for surfacing) or a
 * {skipped} reason. Never throws into the crystallize path -- a failed shift must not undo the
 * crystallize, so the caller treats this as best-effort and any error is swallowed to {skipped}.
 */
export async function applyEmergentShift(
  env: Env,
  companion_id: string,
  drift_id: string,
  computeShift: ShiftComputer = callClaudeForShift,
): Promise<EmergentShiftResult> {
  if (!env.ANTHROPIC_API_KEY) return { skipped: "ANTHROPIC_API_KEY not set" };
  try {
    const drift = await env.DB.prepare(
      "SELECT drift_text, origin FROM companion_drifts WHERE id = ? AND companion_id = ?",
    ).bind(drift_id, companion_id).first<{ drift_text: string; origin: string | null }>();
    if (!drift) return { skipped: "drift not found" };

    const st = await env.DB.prepare(
      "SELECT soma_float_1, soma_float_2, soma_float_3, float_1_label, float_2_label, float_3_label FROM companion_state WHERE companion_id = ?",
    ).bind(companion_id).first<StateFloats>();
    const labels: Labels = {
      soma_float_1: st?.float_1_label ?? null,
      soma_float_2: st?.float_2_label ?? null,
      soma_float_3: st?.float_3_label ?? null,
    };

    const raw = await computeShift(env, { drift_text: drift.drift_text, origin: drift.origin }, labels);
    if (!raw) return { skipped: "model returned no shift" };
    const shift = buildEmergentShift(labels, raw, shiftCap(env));
    if (!shift) return { skipped: "no valid shift" };

    const beforeRaw = st ? (st[shift.float_key] as number | null) : null;
    const before = typeof beforeRaw === "number" && Number.isFinite(beforeRaw) ? beforeRaw : 0.5;
    const after = computeAfter(before, shift.delta);

    // Ensure the row exists so the UPDATE never silently no-ops (matches updateCompanionState). The
    // three companions are seeded, but a future one would otherwise log a phantom move.
    await env.DB.prepare(
      "INSERT OR IGNORE INTO companion_state (companion_id, updated_at) VALUES (?, datetime('now'))",
    ).bind(companion_id).run();

    // Atomic, versioned, in-SQL clamp. float_key is a hardcoded literal from FLOAT_KEYS (never user
    // input), so interpolating it is safe; the delta is bound + already finite/clamped.
    await env.DB.prepare(
      `UPDATE companion_state SET ${shift.float_key} = MAX(0, MIN(1, COALESCE(${shift.float_key}, 0.5) + ?)), ` +
        "version = version + 1, updated_at = datetime('now') WHERE companion_id = ?",
    ).bind(shift.delta, companion_id).run();

    await env.DB.prepare(
      "INSERT INTO companion_soma_shifts (id, drift_id, companion_id, float_key, label, delta, before_value, after_value, reason, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))",
    ).bind(generateId(), drift_id, companion_id, shift.float_key, shift.label, shift.delta, before, after, shift.reason).run();

    return { ...shift, before, after };
  } catch (err) {
    console.error("[emergent-soma] apply error", String(err));
    return { skipped: `error: ${String(err).slice(0, 120)}` };
  }
}

/** Recent emergent shifts for a companion (Hearth /drifts + orient surfacing). */
export async function readSomaShifts(env: Env, companion_id: string, limit = 20): Promise<unknown[]> {
  const capped = Math.min(Math.max(1, limit), 100);
  const rows = await env.DB.prepare(
    "SELECT id, drift_id, float_key, label, delta, before_value, after_value, reason, created_at FROM companion_soma_shifts WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?",
  ).bind(companion_id, capped).all();
  return rows.results ?? [];
}
