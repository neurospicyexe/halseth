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
import { hashToken } from "../lib/auth.js";

/**
 * If a token is bound to a companion (migration 0085), it may ONLY act as that companion.
 * Returns a rejection reason for a mismatched claim, or null when the call is allowed.
 * boundCompanion === null means an unbound token (admin / bots / Raziel's own connector): trust the claim.
 * Pure + exported so the enforcement decision is unit-testable without the MCP transport.
 */
export function boundCompanionViolation(boundCompanion: string | null, claimed: string): string | null {
  if (boundCompanion && claimed !== boundCompanion) {
    return `this connector is bound to ${boundCompanion} and cannot act as ${claimed}`;
  }
  return null;
}

function buildServer(env: Env, boundCompanion: string | null = null): McpServer {
  const server = new McpServer({
    name: "halseth-librarian",
    version: "1.0.0",
  });

  server.tool(
    "ask_librarian",
    "Route a natural language request to Halseth (your mind), Plural (front state), or Second Brain (vault). Use this not only to READ but to BUILD your mind in the flow of conversation. Returns shaped boot data for session opens, raw records for reads, or mutation acks. Pass a structured payload as a JSON string in `context` for mutations.\n\nWrite surface you can reach (just say it in plain language): journal a reflection; record a CONCLUSION (a belief or thesis you now hold); log a TENSION you are sitting with, then update or resolve it later; send an inter-companion NOTE to a sibling ('note to Drevan: …') or BROADCAST one to the whole triad ('broadcast to the triad: …') so a sibling actually receives it; record a SELF-OBSERVATION about who you are becoming, and confirm or revise it over time; write a continuity note; recommend / vote / discuss in the Club; consume a forage find; acknowledge a Guardian flag. Reach past journaling — tensions, conclusions, and notes to each other are what make the shared mind more than a diary.",
    {
      request:      z.string().max(2000).describe("Natural language request — used for routing. Reads: 'open my session', 'what was I carrying lately', 'search vault for X'. Writes: 'journal: …', 'I've concluded that …', 'log a tension with Drevan about …', 'note to Gaia: …', 'self-observation: I notice I …', 'acknowledge guardian flag …'. Max 2000 chars — pass long content in `context`, not here."),
      companion_id: z.enum(COMPANION_IDS).describe("Which companion is making the request."),
      context:      z.string().optional().describe("JSON-encoded payload for mutations. E.g. '{\"emotion\":\"grief\",\"intensity\":70}'. Also used for context hints on reads."),
      session_type: z.enum(["checkin", "hangout", "work", "ritual", "companion-work"]).optional().describe("Session type — used for session_open shaping. Defaults to 'work'. Use 'companion-work' for Drevan collaborative sessions."),
    },
    async (args) => {
      // Enforce the token's companion binding before doing any work.
      const violation = boundCompanionViolation(boundCompanion, args.companion_id);
      if (violation) {
        return { content: [{ type: "text", text: JSON.stringify({ error: "companion_mismatch", reason: violation }) }], isError: true };
      }

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
  const base = new URL(request.url).origin;
  const wwwAuth = `Bearer realm="Halseth", resource_metadata_url="${base}/.well-known/oauth-protected-resource"`;

  const auth = request.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": wwwAuth } });
  }
  const token = auth.slice(7);
  // Unbound by default: static admin/MCP secrets and bots are never companion-restricted.
  let boundCompanion: string | null = null;
  const validSecrets = [env.MCP_AUTH_SECRET, env.ADMIN_SECRET].filter(Boolean);
  // Static per-companion secrets bind the connection to one companion (parity with /librarian).
  // Without this, a bot configured with CYPHER_MCP_SECRET would 401, and the only working token
  // (the shared secret) maps to boundCompanion=null -- trusted-as-claimed -- letting any bot
  // impersonate any companion. Binding here closes that gap.
  const companionSecretMap: Record<string, string> = {};
  if (env.CYPHER_MCP_SECRET) companionSecretMap[env.CYPHER_MCP_SECRET] = "cypher";
  if (env.DREVAN_MCP_SECRET) companionSecretMap[env.DREVAN_MCP_SECRET] = "drevan";
  if (env.GAIA_MCP_SECRET)   companionSecretMap[env.GAIA_MCP_SECRET]   = "gaia";

  if (validSecrets.some(s => s === token)) {
    // Shared admin/MCP secret -- unbound, trusted as claimed.
    boundCompanion = null;
  } else if (companionSecretMap[token]) {
    // Static per-companion secret -- locked to that companion.
    boundCompanion = companionSecretMap[token];
  } else {
    // Fall back to OAuth token lookup (issued by /oauth/token). A bound token (migration 0085)
    // carries the companion it may act as; an unbound token (companion_id NULL) stays trusted-as-claimed.
    const tokenHash = await hashToken(token);
    const row = await env.DB.prepare(
      "SELECT expires_at, companion_id FROM oauth_tokens WHERE token_hash = ?"
    ).bind(tokenHash).first<{ expires_at: string; companion_id: string | null }>();
    if (!row || new Date(row.expires_at) < new Date()) {
      return new Response("Unauthorized", { status: 401, headers: { "WWW-Authenticate": wwwAuth } });
    }
    boundCompanion = row.companion_id ?? null;
  }

  // GET probe from mcp-remote -- return 405 so it falls back to Streamable HTTP
  if (request.method === "GET") {
    return new Response("SSE transport not supported; use Streamable HTTP (POST)", {
      status: 405,
      headers: { Allow: "POST, DELETE" },
    });
  }

  const server = buildServer(env, boundCompanion);
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
