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

  const id = generateId();
  const now = new Date().toISOString();

  await env.DB.prepare(`
    INSERT INTO biometric_snapshots
      (id, recorded_at, logged_at, source, hrv_resting, resting_hr,
       sleep_hours, sleep_quality, stress_score, steps, active_energy, notes)
    VALUES (?, ?, ?, 'hearth', ?, ?, ?, ?, ?, ?, ?, ?)
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
  ).run();

  return new Response(JSON.stringify({ id, logged_at: now }), {
    status: 201,
    headers: { "Content-Type": "application/json" },
  });
}
