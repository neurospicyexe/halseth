// src/librarian/mcp.ts
//
// POST /librarian/mcp -- Librarian as a single-tool MCP endpoint.
//
// Exposes one tool: ask_librarian(request, companion_id, context?, session_type?)
// The tool routes to Halseth D1, Plural, or Second Brain via LibrarianRouter.
// No HTTP hop -- LibrarianRouter is called directly in-process.
//
// Auth: same MCP_AUTH_SECRET bearer token as POST /mcp and POST /librarian.
//
// Companions connect here only. Raw /mcp stays for Raziel direct use.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { toReqRes, toFetchResponse } from "fetch-to-node";
import { z } from "zod";
import { Env } from "../types.js";
import { LibrarianRouter, LibrarianRequest } from "./router.js";
import { COMPANION_IDS } from "./patterns.js";

function buildServer(env: Env): McpServer {
  const server = new McpServer({
    name: "halseth-librarian",
    version: "1.0.0",
  });

  server.tool(
    "ask_librarian",
    "Route a natural language request to Halseth, Plural, or Second Brain. Returns shaped boot data for session opens, raw records for data reads, or mutation acks. Pass structured payload as JSON string in context for mutations.",
    {
      request:      z.string().describe("Natural language request. Used for routing. E.g. 'open my session', 'log a feeling', 'search vault'."),
      companion_id: z.enum(COMPANION_IDS).describe("Which companion is making the request."),
      context:      z.string().optional().describe("JSON-encoded payload for mutations. E.g. '{\"emotion\":\"grief\",\"intensity\":70}'. Also used for context hints on reads."),
      session_type: z.enum(["checkin", "hangout", "work", "ritual"]).optional().describe("Session type — used for session_open shaping. Defaults to 'work'."),
    },
    async (args) => {
      const req: LibrarianRequest = {
        companion_id: args.companion_id,
        request:      args.request,
        context:      args.context,
        session_type: args.session_type ?? "work",
      };

      const router = new LibrarianRouter(env);
      const result = await router.route(req);

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
      };
    },
  );

  return server;
}

export async function handleLibrarianMcp(request: Request, env: Env): Promise<Response> {
  // Auth guard -- accepts MCP_AUTH_SECRET or ADMIN_SECRET (same as authGuard, covers
  // Discord bots using HALSETH_SECRET) OR OAuth token (Claude.ai projects).
  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401 });
  }
  const token = auth.slice(7);
  const validSecrets = [env.MCP_AUTH_SECRET, env.ADMIN_SECRET].filter(Boolean);
  if (!validSecrets.some(s => s === token)) {
    // Fall back to OAuth token lookup (issued by /oauth/token)
    const row = await env.DB.prepare(
      "SELECT expires_at FROM oauth_tokens WHERE token = ?"
    ).bind(token).first<{ expires_at: string }>();
    if (!row || new Date(row.expires_at) < new Date()) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // GET probe from mcp-remote -- return 405 so it falls back to Streamable HTTP
  if (request.method === "GET") {
    return new Response("SSE transport not supported; use Streamable HTTP (POST)", {
      status: 405,
      headers: { Allow: "POST, DELETE" },
    });
  }

  const server = buildServer(env);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });

  const { req, res } = toReqRes(request);

  try {
    await server.connect(transport);
    await transport.handleRequest(req, res);
    return toFetchResponse(res);
  } catch (err) {
    console.error("[librarian/mcp] error:", err);
    return new Response(JSON.stringify({ error: "Internal error" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
