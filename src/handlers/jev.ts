// src/handlers/jev.ts -- POST /admin/jev: admin-gated proxy to Jev via the Workers AI binding.
//
// Door #1 for Jev (docs/PLAN-jev-2026-09-20.md §2.4 step 1). The retro scoring harness and the
// VPS bots reach Jev through here so there is one vendor route, one bill, and one log line to
// grep. Raw MCP/admin surfaces stay Raziel-direct; companions never call this themselves.
//
// Body: { state: string, questions: Record<string, JevQuestion>, purpose?: string }
// 200: { model, answers, latency_ms, usage }
// 400: malformed body (the caller's bug)        502: the binding threw (Jev/Workers AI's problem)
// The 400/502 split is the point: a gate that fails open on 502 must NOT fail open on 400.

import type { Env } from "../types.js";
import { safeEqual } from "../lib/auth.js";
import { jevEval, JevInputError } from "../lib/jev.js";

const JSON_HEADERS = { "Content-Type": "application/json" } as const;

export async function postJevEval(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return new Response("Service not configured: ADMIN_SECRET required", { status: 503 });
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.ADMIN_SECRET}`)) return new Response("Unauthorized", { status: 401 });
  if (!env.AI) return new Response(JSON.stringify({ error: "AI binding not present" }), { status: 503, headers: JSON_HEADERS });

  let body: { state?: unknown; questions?: unknown; purpose?: unknown };
  try {
    body = await request.json() as typeof body;
  } catch {
    return new Response(JSON.stringify({ error: "body must be JSON" }), { status: 400, headers: JSON_HEADERS });
  }
  const purpose = typeof body.purpose === "string" ? body.purpose.slice(0, 64) : "admin";

  const debug = new URL(request.url).searchParams.get("debug") === "1";
  try {
    const result = await jevEval(env, body.state as string, body.questions as never, { purpose });
    // raw_preview only exists on a partial answer; it is the binding's own payload, so like the
    // 502 diagnostic it stays behind `?debug=1`.
    const { raw_preview, ...clean } = result;
    return new Response(JSON.stringify(debug ? result : clean), { status: 200, headers: JSON_HEADERS });
  } catch (e) {
    if (e instanceof JevInputError) {
      return new Response(JSON.stringify({ error: e.message }), { status: 400, headers: JSON_HEADERS });
    }
    // Never echo the binding's raw diagnostic to the client (admin-error-shape test lineage);
    // the [jev] FAILED log line already has it.
    // `?debug=1` (admin-only route, so already behind the bearer) echoes the error CLASS and the
    // first 200 chars of the message -- enough to tell "model not in catalogue" from "bad input
    // shape" without a log round-trip. Never on by default.
    const err = e as Error & { code?: unknown };
    const payload = debug
      ? { error: "jev evaluation failed", name: err?.name ?? null, code: err?.code ?? null, message: String(err?.message ?? e).slice(0, 200) }
      : { error: "jev evaluation failed -- see server logs" };
    return new Response(JSON.stringify(payload), { status: 502, headers: JSON_HEADERS });
  }
}
