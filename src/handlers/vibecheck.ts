// src/handlers/vibecheck.ts
//
// Vibe-check endpoints -- once-daily system-health digest of the triad's internal state,
// witnessed by Gaia. Mirrors handlers/briefing.ts.
//   POST /mind/vibecheck/run   gather -> format -> dedup -> deliver via letter_to_raziel.
//                              Always-on (cron-controlled); dedup caps one per day.
//   GET  /mind/vibecheck       preview: composes from live data, writes nothing.
//
// Delivery rides the existing letter_to_raziel rail (companion_journal, agent='gaia'),
// which Hearth /journal already renders. No new table, no new surface. ADMIN_SECRET auth.
// The cron timing lives in the nullsafe-discord autonomous-worker (thin trigger).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { runVibeCheck, gatherVibeData, formatVibeCheck } from "../webmind/vibecheck.js";

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
