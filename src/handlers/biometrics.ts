import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

import { generateId } from "../db/queries.js";

export async function handleBiometricsLatest(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const row = await env.DB.prepare(
    "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT 1"
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

  const result = await env.DB.prepare(
    "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT ?"
  ).bind(limit).all();

  return new Response(JSON.stringify(result.results), {
    headers: { "Content-Type": "application/json" },
  });
}

export async function handleBiometricsPost(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;

  let body: {
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
  const energy = clampInt(body.energy, 0, 10);
  const focus = clampInt(body.focus, 0, 10);
  const spoons = clampInt(body.spoons, 0, 12);
  const medsTaken =
    body.meds_taken === true || body.meds_taken === 1 ? 1
    : body.meds_taken === false || body.meds_taken === 0 ? 0
    : null;

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO biometric_snapshots
      (id, recorded_at, logged_at, source, hrv_resting, resting_hr,
       sleep_hours, sleep_quality, stress_score, steps, active_energy, notes,
       mood, pain, energy, focus, spoons, meds_taken)
    VALUES (?, ?, ?, 'hearth', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
    energy,
    focus,
    spoons,
    medsTaken,
  ).run();

  return new Response(JSON.stringify({ id, logged_at: now }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
