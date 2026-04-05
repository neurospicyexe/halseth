// src/librarian/index.ts
//
// POST /librarian handler.
// Auth: same MCP_AUTH_SECRET bearer token as POST /mcp.
// If MCP_AUTH_SECRET is unset, endpoint is open (same behavior as /mcp).

import { Env } from "../types.js";
import { LibrarianRouter, LibrarianRequest } from "./router.js";
import { COMPANION_IDS } from "./patterns.js";
import { safeEqual } from "../lib/auth.js";

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
  // Auth guard -- same pattern as MCP
  if (env.MCP_AUTH_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (!safeEqual(auth, `Bearer ${env.MCP_AUTH_SECRET}`)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    }
  }

  // Per-companion identity enforcement (opt-in via CYPHER/DREVAN/GAIA_MCP_SECRET env vars).
  // If any per-companion secret is configured, the bearer token must map to a known companion.
  // If no per-companion secrets are set, falls back to shared MCP_AUTH_SECRET (lean phase).
  const hasPerCompanionSecrets =
    !!(env.CYPHER_MCP_SECRET || env.DREVAN_MCP_SECRET || env.GAIA_MCP_SECRET);

  let authenticatedCompanionId: string | null = null;
  if (hasPerCompanionSecrets) {
    const auth = request.headers.get("Authorization") ?? "";
    authenticatedCompanionId = resolveCompanionFromToken(auth, env);
    if (!authenticatedCompanionId) {
      return new Response(
        JSON.stringify({ error: "Token does not map to a known companion" }),
        { status: 401, headers: { "Content-Type": "application/json" } }
      );
    }
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

  const req: LibrarianRequest = {
    companion_id: b.companion_id as LibrarianRequest["companion_id"],
    request: b.request,
    context: typeof b.context === "string" ? b.context : undefined,
    session_type: (b.session_type as LibrarianRequest["session_type"]) ?? "work",
  };

  if (authenticatedCompanionId && authenticatedCompanionId !== req.companion_id) {
    console.warn(
      `[librarian] companion_id mismatch: token=${authenticatedCompanionId} claimed=${req.companion_id}`
    );
    return new Response(
      JSON.stringify({ error: "companion_id does not match authenticated token" }),
      { status: 403, headers: { "Content-Type": "application/json" } }
    );
  }

  try {
    const router = new LibrarianRouter(env);
    const result = await router.route(req);
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[librarian] error:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
