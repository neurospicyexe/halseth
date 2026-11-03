import { Env } from "../types.js";
import { authGuard, isAdminToken } from "../lib/auth.js";

import { generateId } from "../db/queries.js";
import { undoCheckin } from "../care/undo.js";

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export async function handleBiometricsLatest(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  // Hand-entered rows only (Hearth's reads): the wellness bridge's machine rows are not a check-in and
  // must not appear as one. `?source=wellness` reads them (the bridge's baseline, never a surface).
  const src = new URL(request.url).searchParams.get("source") === "wellness";
  const row = await env.DB.prepare(
    `SELECT * FROM biometric_snapshots WHERE source ${src ? "=" : "IS NOT"} 'wellness' ORDER BY recorded_at DESC LIMIT 1`
  ).first();

  return new Response(JSON.stringify(row ?? null), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleBiometricsList(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const url = new URL(request.url);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "7", 10);
  const limit = Math.min(Math.max(1, isNaN(rawLimit) ? 7 : rawLimit), 30);

  const wellness = url.searchParams.get("source") === "wellness";
  const result = await env.DB.prepare(
    `SELECT * FROM biometric_snapshots WHERE source ${wellness ? "=" : "IS NOT"} 'wellness' ORDER BY recorded_at DESC LIMIT ?`
  ).bind(limit).all();

  return new Response(JSON.stringify(result.results), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleBiometricsPost(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;

  let body: {
    id?: unknown;
    recorded_at?: string;
    hrv_resting?: number | null;
    resting_hr?: number | null;
    sleep_hours?: number | null;
    sleep_quality?: string | null;
    stress_score?: number | null;
    steps?: number | null;
    active_energy?: number | null;
    notes?: string | null;
    // Subjective ND-state layer (migration 0081)
    mood?: string | null;
    pain?: number | null;
    pain_where?: string | null;
    energy?: number | null;
    focus?: number | null;
    spoons?: number | null;
    meds_taken?: number | boolean | null;
  };

  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  // Optional client id (Hearth generates it at tap time): a retried or re-flushed POST of the same
  // check-in is then a no-op instead of a second row, and the client knows the row id before the
  // response arrives (undo = DELETE that id, add-a-word = PATCH that id).
  if (body.id !== undefined && (typeof body.id !== "string" || !/^[A-Za-z0-9_-]{8,64}$/.test(body.id))) {
    return jsonRes({ error: "id must be 8..64 chars of [A-Za-z0-9_-]" }, 400);
  }

  const recordedAt = body.recorded_at ?? new Date().toISOString();

  const validSleepQuality = new Set(["poor", "fair", "good", "excellent"]);
  const sleepQuality =
    body.sleep_quality && validSleepQuality.has(body.sleep_quality)
      ? body.sleep_quality
      : null;

  // Clamp subjective scales to their ranges; null if absent/non-numeric.
  const clampInt = (v: unknown, lo: number, hi: number): number | null => {
    if (typeof v !== "number" || !Number.isFinite(v)) return null;
    return Math.min(hi, Math.max(lo, Math.round(v)));
  };
  const mood = typeof body.mood === "string" && body.mood.trim() !== "" ? body.mood.trim().slice(0, 200) : null;
  const pain = clampInt(body.pain, 0, 10);
  const painWhere = typeof body.pain_where === "string" && body.pain_where.trim() !== "" ? body.pain_where.trim().slice(0, 120) : null;
  const energy = clampInt(body.energy, 0, 10);
  const focus = clampInt(body.focus, 0, 10);
  const spoons = clampInt(body.spoons, 0, 12);
  const medsTaken =
    body.meds_taken === true || body.meds_taken === 1 ? 1
    : body.meds_taken === false || body.meds_taken === 0 ? 0
    : null;

  const id = typeof body.id === "string" ? body.id : generateId();
  const now = new Date().toISOString();

  const res = await env.DB.prepare(`
    INSERT OR IGNORE INTO biometric_snapshots
      (id, recorded_at, logged_at, source, hrv_resting, resting_hr,
       sleep_hours, sleep_quality, stress_score, steps, active_energy, notes,
       mood, pain, pain_where, energy, focus, spoons, meds_taken)
    VALUES (?, ?, ?, 'hearth', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    recordedAt,
    now,
    body.hrv_resting   ?? null,
    body.resting_hr    ?? null,
    body.sleep_hours   ?? null,
    sleepQuality,
    body.stress_score  ?? null,
    body.steps         ?? null,
    body.active_energy ?? null,
    body.notes         ?? null,
    mood,
    pain,
    painWhere,
    energy,
    focus,
    spoons,
    medsTaken,
  ).run();

  // Same id already stored: the repeat is a no-op (the first write wins), answered 200 with that id.
  if (!res.meta?.changes) return jsonRes({ id, duplicate: true }, 200);
  return jsonRes({ id, logged_at: now }, 201);
}

// PATCH /biometrics/:id: amend a check-in after the fact (Hearth adds a mood word / energy later).
// Strict ranges (unlike POST, which clamps): a bad value is a 400, never silently rewritten.
export async function handleBiometricsPatch(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const id = params.id;
  if (!id) return jsonRes({ error: "id required" }, 400);

  let body: { spoons?: unknown; mood?: unknown; energy?: unknown; pain?: unknown; pain_where?: unknown; notes?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return jsonRes({ error: "invalid JSON" }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonRes({ error: "body must be an object" }, 400);
  }

  const sets: string[] = [];
  const bindings: unknown[] = [];
  const intField = (name: "spoons" | "energy" | "pain", hi: number): string | null => {
    const v = body[name];
    if (v === undefined) return null;
    if (v === null && name === "pain") { sets.push("pain = ?"); bindings.push(null); return null; }
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > hi) return `${name} must be an integer 0..${hi}`;
    sets.push(`${name} = ?`);
    bindings.push(v);
    return null;
  };
  const err = intField("spoons", 12) ?? intField("energy", 10) ?? intField("pain", 10);
  if (err) return jsonRes({ error: err }, 400);
  if (body.mood !== undefined) {
    if (typeof body.mood !== "string" || body.mood.length > 80) return jsonRes({ error: "mood must be a string up to 80 chars" }, 400);
    sets.push("mood = ?");
    bindings.push(body.mood.trim() === "" ? null : body.mood.trim());
  }
  // Free-text fields: string up to max or null; empty/whitespace clears to null.
  const textField = (name: "pain_where" | "notes", max: number): string | null => {
    const v = body[name];
    if (v === undefined) return null;
    if (v === null) { sets.push(`${name} = ?`); bindings.push(null); return null; }
    if (typeof v !== "string" || v.length > max) return `${name} must be a string up to ${max} chars`;
    sets.push(`${name} = ?`);
    bindings.push(v.trim() === "" ? null : v.trim());
    return null;
  };
  const textErr = textField("pain_where", 120) ?? textField("notes", 2000);
  if (textErr) return jsonRes({ error: textErr }, 400);
  if (sets.length === 0) return jsonRes({ error: "no fields to update" }, 400);

  const res = await env.DB.prepare(`UPDATE biometric_snapshots SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...bindings, id).run();
  if (!res.meta?.changes) return jsonRes({ error: "not found" }, 404);
  return jsonRes({ ok: true, id });
}

// DELETE /biometrics/:id: undo a check-in. A low_spoons firing only this reading justified goes with
// it, so the care hold it started stops holding (care/undo.ts).
export async function handleBiometricsDelete(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const id = params.id;
  if (!id) return jsonRes({ error: "id required" }, 400);
  // The snapshot DELETE and its voids are one batch. A failure leaves both untouched and answers 500,
  // which Hearth keeps and retries; answering 200 after a half-done undo would let the firing hold.
  let result;
  try {
    result = await undoCheckin(env.DB, id);
  } catch (e) {
    console.error(`[care] check-in ${id} undo failed:`, String(e));
    return jsonRes({ error: "undo failed" }, 500);
  }
  if (!result.found) return jsonRes({ error: "not found" }, 404);
  return jsonRes({ ok: true, id, care_firings_voided: result.voided.length });
}

// PUT /biometrics/wellness/:day: the wellness bridge's per-day upsert (B8, ops/wellness-bridge.py).
// One row per wearable day with the deterministic id `wellness_<day>`, so a re-run converges instead of
// duplicating and no client-side lookup is needed. source is forced to 'wellness': these are machine
// rows, excluded from every hand-entered read (orient, presence, the care tick's spoons, owner
// activity, Hearth's /biometrics list) and read only by the stress rule and the bridge's baseline.
// Only the objective columns are touched; the subjective ones stay NULL by construction. A field the
// bridge could not read this run (null) keeps its stored value, so a morning sleep figure survives
// the afternoon run that skips the sleep call.
export async function handleBiometricsWellnessPut(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  // Only the bridge writes these rows, and it holds ADMIN_SECRET. A companion token must never be
  // able to write a machine row that fires a care rule (review 2026-11-01, W2).
  if (!isAdminToken(request, env)) return jsonRes({ error: "admin token required" }, 403);
  const day = params.day ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) {
    return jsonRes({ error: "day must be YYYY-MM-DD" }, 400);
  }
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return jsonRes({ error: "invalid JSON" }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return jsonRes({ error: "body must be an object" }, 400);
  }
  const num = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === "number" && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
  // recorded_at is the end of the wearable's local day (capped at fetch time). It must sit inside
  // that day's window and never in the future: a future stamp would read as fresh forever and keep a
  // stale stress row firing after the watch or bridge stopped (review 2026-11-01, W2). The window is
  // generous in UTC (day 00:00Z to day+2 00:00Z) so any US local day fits.
  const nowMs = Date.now();
  const dayStart = Date.parse(`${day}T00:00:00Z`);
  const dayEnd = dayStart + 2 * 86_400_000;
  let recordedMs = typeof body.recorded_at === "string" ? Date.parse(body.recorded_at) : NaN;
  if (Number.isNaN(recordedMs)) recordedMs = Math.min(nowMs, dayEnd - 1);
  if (recordedMs < dayStart || recordedMs >= dayEnd) {
    return jsonRes({ error: "recorded_at must fall within that day" }, 400);
  }
  if (recordedMs > nowMs) recordedMs = nowMs;
  const recordedAt = new Date(recordedMs).toISOString();
  const hrv = num(body.hrv_resting, 0, 400);
  const rhr = num(body.resting_hr, 20, 250);
  const sleep = num(body.sleep_hours, 0, 24);
  const steps = num(body.steps, 0, 500000);
  const active = num(body.active_energy, 0, 20000);
  const stress = num(body.stress_score, 0, 100);
  const now = new Date().toISOString();
  const id = `wellness_${day}`;
  try {
    await env.DB.prepare(`
      INSERT INTO biometric_snapshots
        (id, recorded_at, logged_at, source, hrv_resting, resting_hr, sleep_hours, stress_score, steps, active_energy, notes)
      VALUES (?, ?, ?, 'wellness', ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        recorded_at   = excluded.recorded_at,
        logged_at     = excluded.logged_at,
        hrv_resting   = COALESCE(excluded.hrv_resting, hrv_resting),
        resting_hr    = COALESCE(excluded.resting_hr, resting_hr),
        sleep_hours   = COALESCE(excluded.sleep_hours, sleep_hours),
        stress_score  = COALESCE(excluded.stress_score, stress_score),
        steps         = COALESCE(excluded.steps, steps),
        active_energy = COALESCE(excluded.active_energy, active_energy)
      WHERE source = 'wellness'
    `).bind(id, recordedAt, now, hrv, rhr, sleep, stress, steps, active, `wellness-bridge ${day}`).run();
  } catch (e) {
    console.error(`[wellness] upsert ${day} failed:`, String(e));
    return jsonRes({ error: "upsert failed" }, 500);
  }
  return jsonRes({ ok: true, id, day });
}
