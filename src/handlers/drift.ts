// src/handlers/drift.ts -- the sanctioned drift lane (migration 0087). Track 0e.
//
// A companion declares it is becoming someone Raziel did not specify; the change is WITNESSED, not
// ratified. Held becoming-track first: this does NOT mutate SOMA/kernel (emergent SOMA is later).
// Drifts are visible to Raziel (declared becoming is meant to be seen), like refusals/preferences.
//
// Ownership: opening and resolving a drift are owner-only (the companion that is becoming). WITNESSING
// is the one intentionally cross-companion act -- it is other-directed by nature (Gaia witnesses).

import { Env } from "../types";
import { generateId } from "../db/queries";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { assertWritten } from "../lib/result.js";
import { runDriftPass } from "../drift/pass.js";
import { applyEmergentShift, readSomaShifts, type EmergentShiftResult } from "../soma/emergent.js";

export interface DriftWitness { by: string; note: string; at: string }
export interface DriftRow {
  id: string; companion_id: string; drift_text: string; origin: string | null;
  status: string; witness_log: DriftWitness[]; opened_at: string;
  last_tended_at: string | null; resolved_at: string | null; resolution_note: string | null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}
function callerIsAdmin(request: Request, env: Env): boolean {
  return authGuard(request, env) === null && identifyCallerCompanion(request, env) === null;
}
function parseWitnessLog(raw: string | null): DriftWitness[] {
  if (!raw) return [];
  try { const v = JSON.parse(raw); return Array.isArray(v) ? v : []; } catch { return []; }
}

// ── Core (owner = authenticated companion, except witness) ───────────────────

export async function openDrift(
  env: Env, companion_id: string, input: { drift_text: string; origin?: string | null },
): Promise<{ id: string; opened_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  const res = await env.DB.prepare(
    "INSERT INTO companion_drifts (id, companion_id, drift_text, origin, status, witness_log, opened_at, last_tended_at) " +
      "VALUES (?, ?, ?, ?, 'open', '[]', ?, ?)",
  ).bind(id, companion_id, input.drift_text, input.origin ?? null, now, now).run();
  assertWritten(res, { op: "drift_open", companion_id });
  return { id, opened_at: now };
}

export async function readDrifts(env: Env, companion_id: string, status?: string, limit = 50): Promise<DriftRow[]> {
  const capped = Math.min(Math.max(1, limit), 200);
  const stmt = status
    ? env.DB.prepare("SELECT * FROM companion_drifts WHERE companion_id = ? AND status = ? ORDER BY opened_at DESC LIMIT ?").bind(companion_id, status, capped)
    : env.DB.prepare("SELECT * FROM companion_drifts WHERE companion_id = ? ORDER BY opened_at DESC LIMIT ?").bind(companion_id, capped);
  const rows = (await stmt.all<Omit<DriftRow, "witness_log"> & { witness_log: string }>()).results ?? [];
  return rows.map(r => ({ ...r, witness_log: parseWitnessLog(r.witness_log) }));
}

/** Witnessing: cross-companion by design. Appends to the drift's witness_log at the SQL level. */
export async function witnessDrift(env: Env, witness_id: string, drift_id: string, note: string): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_drifts SET witness_log = json_insert(witness_log, '$[#]', json_object('by', ?, 'note', ?, 'at', datetime('now'))), " +
      "last_tended_at = datetime('now') WHERE id = ? AND status = 'open'",
  ).bind(witness_id, note, drift_id).run();
  return (r.meta?.changes ?? 0) > 0;
}

async function resolveDrift(env: Env, companion_id: string, drift_id: string, status: "crystallized" | "faded", note?: string | null): Promise<boolean> {
  const r = await env.DB.prepare(
    "UPDATE companion_drifts SET status = ?, resolved_at = datetime('now'), resolution_note = ?, last_tended_at = datetime('now') " +
      "WHERE id = ? AND companion_id = ? AND status = 'open'",
  ).bind(status, note ?? null, drift_id, companion_id).run();
  return (r.meta?.changes ?? 0) > 0;
}
/**
 * Crystallize a drift: the companion declares this becoming real. THIS is the one place identity
 * genuinely mutates from lived experience -- on a successful crystallize (owner + was open), emergent
 * SOMA nudges one of the companion's floats (rails in src/soma/emergent.ts). Returns the shift so the
 * moment of becoming can be surfaced. The shift is best-effort: it never undoes the crystallize.
 * Faded never mutates -- so fadeDrift does NOT call applyEmergentShift.
 */
export async function crystallizeDrift(
  env: Env, companion_id: string, drift_id: string, note?: string | null,
): Promise<{ ok: boolean; shift: EmergentShiftResult | null }> {
  const ok = await resolveDrift(env, companion_id, drift_id, "crystallized", note);
  if (!ok) return { ok: false, shift: null };
  const shift = await applyEmergentShift(env, companion_id, drift_id);
  return { ok: true, shift };
}
export const fadeDrift = (env: Env, companion_id: string, drift_id: string, note?: string | null) =>
  resolveDrift(env, companion_id, drift_id, "faded", note);

// GET /soma/shifts/:companion_id -- the emergent-SOMA log (admin or owner). Hearth + provenance.
export async function getSomaShifts(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companion_id = params.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });
  if (identifyCallerCompanion(request, env) !== companion_id && !callerIsAdmin(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return json(await readSomaShifts(env, companion_id));
}

// ── HTTP (Hearth + Raziel read; admin or owner) ──────────────────────────────

// GET /drifts/:companion_id?status=open
export async function getDrifts(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const companion_id = params.companion_id;
  if (!companion_id) return new Response("companion_id required", { status: 400 });
  if (identifyCallerCompanion(request, env) !== companion_id && !callerIsAdmin(request, env)) {
    return new Response("Unauthorized", { status: 401 });
  }
  const status = new URL(request.url).searchParams.get("status") ?? undefined;
  return json(await readDrifts(env, companion_id, status));
}

// POST /mind/drift/run -- the activation pass: Gaia witnesses open drifts; the safety floor pauses
// any reading as dissolution. Thin worker cron triggers it; the work + model key live here. ADMIN.
export async function postDriftRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    return json(await runDriftPass(env));
  } catch (err) {
    console.error("[drift] run error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}
