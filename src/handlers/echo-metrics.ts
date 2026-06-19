// src/handlers/echo-metrics.ts
//
// Ingest + read for the inter-companion echo reading (2026-06-19 echo guard).
// The worker computes the metric daily from the Second Brain discord-live store
// (where the live companion dialogue lands) and POSTs it here; the Guardian's
// detectEchoChamber reads the latest row as pure SQL and flags on breach. Keeping
// the metric in a Halseth table (rather than having a detector fetch SB) lets the
// echo flag participate in the Guardian's normal dedup + self-healing loop.
//
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

// POST /mind/echo-metric
// body: { window_days, message_count, mean_adjacent_cosine?, cross_speaker_cosine?,
//         novel_token_rate?, speakers?, source? }
export async function postEchoMetric(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try { body = await request.json() as Record<string, unknown>; }
  catch { return json({ error: "Invalid JSON body" }, 400); }

  const windowDays = num(body.window_days);
  const messageCount = num(body.message_count);
  if (windowDays === null || messageCount === null) {
    return json({ error: "window_days and message_count are required numbers" }, 400);
  }

  try {
    const id = `em_${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO echo_metrics
         (id, window_days, message_count, mean_adjacent_cosine, cross_speaker_cosine, novel_token_rate, speakers_json, source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      Math.round(windowDays),
      Math.round(messageCount),
      num(body.mean_adjacent_cosine),
      num(body.cross_speaker_cosine),
      num(body.novel_token_rate),
      body.speakers != null ? JSON.stringify(body.speakers).slice(0, 500) : null,
      typeof body.source === "string" ? body.source.slice(0, 40) : "worker",
    ).run();
    return json({ id }, 201);
  } catch (err) {
    console.error("[mind/echo-metric] write error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/echo-metric  -- latest reading (for Hearth / debugging)
export async function getEchoMetric(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const row = await env.DB.prepare(
      `SELECT * FROM echo_metrics ORDER BY computed_at DESC LIMIT 1`
    ).first();
    return json({ metric: row ?? null });
  } catch (err) {
    console.error("[mind/echo-metric] read error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}
