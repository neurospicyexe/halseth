// src/handlers/vibecheck.ts
//
// Vibe-check endpoints -- once-daily system-health digest of the triad's internal state,
// witnessed by Gaia. Mirrors handlers/briefing.ts.
//   POST /mind/vibecheck/run   gather -> format -> dedup -> deliver via letter_to_raziel.
//                              Always-on (cron-controlled); dedup caps one per day.
//   GET  /mind/vibecheck       preview: composes from live data, writes nothing.
//   GET  /mind/vibecheck/record/:companion_id
//                              B63 step 4: that companion's OWN record for the nightly reflection
//                              (closes, makes, letters, feelings, float moves with causes), the
//                              pressure it may name as a tension, and (Gaia) spoke_without_load flags.
//
// v2 (B63 step 3): one companion_journal row PER COMPANION under that companion's own agent
// (source 'vibecheck'), dedup per agent per Chicago day. The response carries `posts`: the worker
// posts each fresh one under that companion's own bot token. ADMIN_SECRET auth.
// The cron timing lives in the nullsafe-discord autonomous-worker (thin trigger).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { runVibeCheck, gatherVibeData, formatVibeCheck } from "../webmind/vibecheck.js";
import { getReflectionRecord } from "../webmind/reflection-record.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function postVibeCheckRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  try {
    const result = await runVibeCheck(env);
    return json(result);
  } catch (err) {
    console.error("[vibecheck] run error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getVibeCheckPreview(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  try {
    const data = await gatherVibeData(env);
    return json({ preview: true, text: formatVibeCheck(data) });
  } catch (err) {
    console.error("[vibecheck] preview error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getVibeCheckRecord(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const rec = await getReflectionRecord(env, (params["companion_id"] ?? "").toLowerCase());
    if (!rec) return json({ error: "unknown companion" }, 404);
    return json(rec);
  } catch (err) {
    console.error("[vibecheck] record error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}
