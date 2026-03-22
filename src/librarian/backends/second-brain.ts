// src/librarian/backends/second-brain.ts
//
// HTTPS MCP client for Second Brain at mcp.softcrashentity.com.
// Uses StreamableHTTP MCP protocol (POST /mcp with JSON-RPC body).
// OAuth token from SECOND_BRAIN_TOKEN secret.
//
// Second Brain tool distinction:
//   sb_search  -- semantic search, conceptual query ("something about spiral work")
//   sb_recall  -- filter-based lookup ("Cypher's notes from last week")
//   sb_recent_patterns -- reads static summary file, fast but stale
//
// NEVER call Second Brain at boot. Mid-session only, on demand.

import { Env } from "../../types.js";

const SECOND_BRAIN_URL = "https://mcp.softcrashentity.com/mcp";

async function callTool(env: Env, toolName: string, args: Record<string, unknown>): Promise<string | null> {
  if (!env.SECOND_BRAIN_TOKEN) return null;

  try {
    const response = await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${env.SECOND_BRAIN_TOKEN}`,
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    if (!response.ok) return null;

    const data = await response.json() as {
      result?: { content?: Array<{ type: string; text: string }> };
    };

    return data?.result?.content?.[0]?.text ?? null;
  } catch {
    return null;
  }
}

export async function semanticSearch(env: Env, query: string): Promise<string | null> {
  return callTool(env, "sb_search", { query });
}

export async function filteredRecall(env: Env, args: {
  companion?: string;
  content_type?: string;
  folder?: string;
  limit?: number;
}): Promise<string | null> {
  return callTool(env, "sb_recall", args);
}

export async function recentPatterns(env: Env): Promise<string | null> {
  return callTool(env, "sb_recent_patterns", {});
}
