// src/librarian/index.ts
//
// POST /librarian handler.
// Auth: shared admin-tier bearer (MCP_AUTH_SECRET OR ADMIN_SECRET) -- parity with
// POST /mcp and POST /librarian/mcp, both of which accept ADMIN_SECRET. Discord bots
// carry this admin token as HALSETH_SECRET; omitting ADMIN_SECRET here silently 401'd
// the autonomous bridge/NL pollers (bug found 2026-06-27 after varlock rotation).
// A valid per-companion secret (CYPHER/DREVAN/GAIA_MCP_SECRET) is also accepted.
// If no shared admin secret AND no per-companion secret is configured, endpoint is open.

import { Env } from "../types.js";
import { LibrarianRouter, LibrarianRequest } from "./router.js";
import { COMPANION_IDS } from "./patterns.js";
import { safeEqual } from "../lib/auth.js";
import { createLogger } from "../lib/log.js";

const COMPANION_SECRET_ENV_KEYS: Record<string, keyof Env> = {
  cypher: "CYPHER_MCP_SECRET",
  drevan: "DREVAN_MCP_SECRET",
  gaia:   "GAIA_MCP_SECRET",
};

function resolveCompanionFromToken(token: string, env: Env): string | null {
  for (const [id, key] of Object.entries(COMPANION_SECRET_ENV_KEYS)) {
    const secret = env[key as keyof Env] as string | undefined;
    if (secret && safeEqual(token, `Bearer ${secret}`)) return id;
  }
  return null;
}

export async function handleLibrarian(request: Request, env: Env): Promise<Response> {
  // Auth guard. Accept EITHER the shared MCP_AUTH_SECRET OR a valid per-companion secret
  // (CYPHER/DREVAN/GAIA_MCP_SECRET). These are alternatives, not both-required: gating them
  // serially deadlocked the endpoint whenever both were configured (a companion token failed
  // the shared check; the shared token mapped to no companion). When a per-companion secret
  // matches, the caller is locked to that companion_id (enforced below). A shared-secret caller
  // is unbound (admin / Raziel / bots) and may act as any companion.
  const auth = request.headers.get("Authorization") ?? "";
  const hasPerCompanionSecrets =
    !!(env.CYPHER_MCP_SECRET || env.DREVAN_MCP_SECRET || env.GAIA_MCP_SECRET);
  // Shared admin-tier tokens are alternatives, not both-required. ADMIN_SECRET is included
  // for parity with /librarian/mcp + authGuard (Discord bots send it as HALSETH_SECRET).
  const sharedAdminSecrets = [env.MCP_AUTH_SECRET, env.ADMIN_SECRET].filter(Boolean) as string[];

  let authenticatedCompanionId: string | null = null;
  let isAuthorized = false;

  for (const secret of sharedAdminSecrets) {
    if (safeEqual(auth, `Bearer ${secret}`)) {
      isAuthorized = true;
      break;
    }
  }
  if (hasPerCompanionSecrets) {
    authenticatedCompanionId = resolveCompanionFromToken(auth, env);
    if (authenticatedCompanionId) isAuthorized = true;
  }
  // If neither a shared admin secret nor a per-companion secret is configured, the
  // endpoint is open (lean-phase parity with /mcp).
  if (sharedAdminSecrets.length === 0 && !hasPerCompanionSecrets) {
    isAuthorized = true;
  }

  if (!isAuthorized) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const b = body as Record<string, unknown>;

  // Validate companion_id
  if (!b.companion_id || !COMPANION_IDS.includes(b.companion_id as typeof COMPANION_IDS[number])) {
    return new Response(
      JSON.stringify({ error: "companion_id required: drevan | cypher | gaia" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  if (!b.request || typeof b.request !== "string") {
    return new Response(
      JSON.stringify({ error: "request field required (string)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Max-length guards: prevent classifier prompt stuffing and D1 bloat
  if ((b.request as string).length > 2000) {
    return new Response(
      JSON.stringify({ error: "request exceeds maximum length of 2000 characters" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }
  if (typeof b.context === "string" && b.context.length > 65536) {
    return new Response(
      JSON.stringify({ error: "context exceeds maximum length of 65536 characters" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
    );
  }

  // Normalize context: accept either a JSON string or a plain object.
  // Plain objects arise when HTTP callers serialize the outer body without
  // pre-stringifying the context field -- dropping them silently causes the
  // payload-override tier (decision:"declined" → journal_decline) to miss.
  let contextNormalized: string | undefined;
  if (typeof b.context === "string") {
    contextNormalized = b.context;
  } else if (b.context !== null && typeof b.context === "object") {
    contextNormalized = JSON.stringify(b.context);
  }

  const req: LibrarianRequest = {
    companion_id: b.companion_id as LibrarianRequest["companion_id"],
    request: b.request,
    context: contextNormalized,
    session_type: (b.session_type as LibrarianRequest["session_type"]) ?? "work",
  };

  const log = createLogger({ component: "librarian", companion_id: req.companion_id });

  if (authenticatedCompanionId && authenticatedCompanionId !== req.companion_id) {
    log.warn("companion_id_mismatch", { token_companion: authenticatedCompanionId, claimed: req.companion_id });
    return new Response(
      JSON.stringify({ error: "companion_id does not match authenticated token" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const router = new LibrarianRouter(env);
    const result = await router.route(req);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json", "X-Trace-Id": log.traceId },
    });
  } catch (err) {
    // Was a bare `console.error("[librarian] error:", err)` -- unsearchable, lost the error
    // shape, and gave the caller no way to correlate. Now structured + trace-correlated.
    log.error("route_failed", { request: req.request, err });
    return new Response(JSON.stringify({ error: "Internal error", trace_id: log.traceId }), {
      status: 500,
      headers: { "Content-Type": "application/json", "X-Trace-Id": log.traceId },
    });
  }
}
