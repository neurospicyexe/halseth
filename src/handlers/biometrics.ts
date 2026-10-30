import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

import { generateId } from "../db/queries.js";

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

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

  let body: { spoons?: unknown; mood?: unknown; energy?: unknown };
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
  const intField = (name: "spoons" | "energy", hi: number): string | null => {
    const v = body[name];
    if (v === undefined) return null;
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0 || v > hi) return `${name} must be an integer 0..${hi}`;
    sets.push(`${name} = ?`);
    bindings.push(v);
    return null;
  };
  const err = intField("spoons", 12) ?? intField("energy", 10);
  if (err) return jsonRes({ error: err }, 400);
  if (body.mood !== undefined) {
    if (typeof body.mood !== "string" || body.mood.length > 80) return jsonRes({ error: "mood must be a string up to 80 chars" }, 400);
    sets.push("mood = ?");
    bindings.push(body.mood.trim() === "" ? null : body.mood.trim());
  }
  if (sets.length === 0) return jsonRes({ error: "no fields to update" }, 400);

  const res = await env.DB.prepare(`UPDATE biometric_snapshots SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...bindings, id).run();
  if (!res.meta?.changes) return jsonRes({ error: "not found" }, 404);
  return jsonRes({ ok: true, id });
}

// DELETE /biometrics/:id: undo a check-in.
export async function handleBiometricsDelete(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const id = params.id;
  if (!id) return jsonRes({ error: "id required" }, 400);
  const res = await env.DB.prepare("DELETE FROM biometric_snapshots WHERE id = ?").bind(id).run();
  if (!res.meta?.changes) return jsonRes({ error: "not found" }, 404);
  return jsonRes({ ok: true, id });
}
