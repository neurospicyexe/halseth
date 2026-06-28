// src/handlers/briefing.ts
//
// ND daily-rhythm briefing endpoints (accessibility / executive-function layer).
//   POST /mind/briefing/run     body: { kind: 'morning'|'midday'|'evening', force?: boolean }
//                               gather -> format -> dedup -> deliver via letter_to_raziel.
//                               No-op (reason:'gated') unless BRIEFING_ENABLED='true' or force.
//   GET  /mind/briefing/:kind   preview: composes from live data, writes nothing, ignores gate.
//
// Delivery rides the existing letter_to_raziel rail (companion_journal, agent='steward'),
// which Hearth /journal already renders. No new table, no new surface. ADMIN_SECRET auth.
// The cron timing lives in the nullsafe-discord autonomous-worker (thin trigger, like guardian).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { runBriefing, gatherBriefingData, formatBriefing, isBriefingKind } from "../webmind/briefing.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function postBriefingRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { kind?: string; force?: boolean } = {};
  try { body = await request.json(); } catch { /* empty body -> validation below */ }

  const kind = body.kind ?? "";
  if (!isBriefingKind(kind)) {
    return json({ error: "kind required: morning | midday | evening" }, 400);
  }
  try {
    const result = await runBriefing(env, kind, { force: body.force === true });
    return json(result);
  } catch (err) {
    console.error("[briefing] run error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getBriefingPreview(
  request: Request,
  env: Env,
  params: Record<string, string>
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const kind = params.kind ?? "";
  if (!isBriefingKind(kind)) {
    return json({ error: "kind required: morning | midday | evening" }, 400);
  }
  try {
    const data = await gatherBriefingData(env);
    return json({ kind, preview: true, text: formatBriefing(kind, data) });
  } catch (err) {
    console.error("[briefing] preview error", String(err));
    return json({ error: "Internal server error" }, 500);
  }
}
