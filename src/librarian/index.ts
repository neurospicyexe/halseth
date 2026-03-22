// src/librarian/index.ts
//
// POST /librarian handler.
// Auth: same MCP_AUTH_SECRET bearer token as POST /mcp.
// If MCP_AUTH_SECRET is unset, endpoint is open (same behavior as /mcp).

import { Env } from "../types.js";
import { LibrarianRouter, LibrarianRequest } from "./router.js";
import { COMPANION_IDS } from "./patterns.js";

export async function handleLibrarian(request: Request, env: Env): Promise<Response> {
  // Auth guard -- same pattern as MCP
  if (env.MCP_AUTH_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.MCP_AUTH_SECRET}`) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
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

  const req: LibrarianRequest = {
    companion_id: b.companion_id as LibrarianRequest["companion_id"],
    request: b.request,
    context: typeof b.context === "string" ? b.context : undefined,
    session_type: (b.session_type as LibrarianRequest["session_type"]) ?? "work",
  };

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
