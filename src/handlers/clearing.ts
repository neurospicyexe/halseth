// src/handlers/clearing.ts -- the weekly clearing pass endpoint (Goal B, 2026-06-14).
//   POST /mind/clearing/run -- triage the pending ratification backlog with high substrate;
//                              auto-decline drift, shortlist real growth for Raziel. ADMIN_SECRET.
// The worker cron is a thin trigger; the decision runs here (mirrors the Guardian organ).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { runClearingPass } from "../clearing/pass.js";

export async function postClearingRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const result = await runClearingPass(env);
    return new Response(JSON.stringify(result), { status: 200, headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[clearing] run error", String(err));
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
