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
  if (!env.SECOND_BRAIN_TOKEN) {
    console.error("[sb] callTool: SECOND_BRAIN_TOKEN not set");
    return null;
  }

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "Authorization": `Bearer ${env.SECOND_BRAIN_TOKEN}`,
  };

  try {
    // Step 1: Initialize MCP session
    const initRes = await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "halseth-librarian", version: "1.0.0" },
        },
      }),
    });

    if (!initRes.ok) {
      console.error(`[sb] init failed: status=${initRes.status} tool=${toolName}`);
      return null;
    }
    const sessionId = initRes.headers.get("mcp-session-id");
    if (!sessionId) {
      console.error(`[sb] init OK but no mcp-session-id header tool=${toolName}`);
      return null;
    }

    // Step 1.5: notifications/initialized (fire-and-forget, SDK state transition)
    await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    }).catch((e: unknown) => console.error("[sb] notifications/initialized failed (non-fatal):", e));

    // Step 2: Call the tool
    const toolRes = await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    if (!toolRes.ok) {
      const body = await toolRes.text().catch(() => "(unreadable)");
      console.error(`[sb] tools/call failed: status=${toolRes.status} tool=${toolName} body=${body}`);
      return null;
    }

    // Server may return SSE ("event: message\ndata: {...}") or plain JSON depending on Accept negotiation
    const rawText = await toolRes.text();
    let data: { result?: { content?: Array<{ type: string; text: string }> }; error?: { code: number; message: string } };
    if (rawText.trimStart().startsWith("event:") || rawText.trimStart().startsWith("data:")) {
      // SSE -- extract the first data: line
      const dataLine = rawText.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) {
        console.error(`[sb] SSE response but no data line found tool=${toolName} raw=${rawText.slice(0, 200)}`);
        return null;
      }
      data = JSON.parse(dataLine.slice(5).trim());
    } else {
      data = JSON.parse(rawText);
    }

    if (data.error) {
      console.error(`[sb] JSON-RPC error: code=${data.error.code} msg=${data.error.message} tool=${toolName}`);
      return null;
    }

    const text = data?.result?.content?.[0]?.text ?? null;
    if (text === null) {
      console.error(`[sb] unexpected response shape tool=${toolName}:`, JSON.stringify(data).slice(0, 200));
    }
    return text;
  } catch (e) {
    console.error(`[sb] callTool exception tool=${toolName}:`, e);
    return null;
  }
}

// ── Reads (return raw string -- companion parses) ─────────────────────────────

export async function semanticSearch(env: Env, query: string): Promise<string | null> {
  return callTool(env, "sb_search", { query });
}

export async function filteredRecall(env: Env, args: {
  companion?: string | null;
  content_type?: string;
  limit?: number;
}): Promise<string | null> {
  return callTool(env, "sb_recall", args);
}

export async function recentPatterns(env: Env): Promise<string | null> {
  return callTool(env, "sb_recent_patterns", {});
}

export async function sbRead(env: Env, path: string, query?: string): Promise<string | null> {
  return callTool(env, "sb_read", query ? { path, query } : { path });
}

export async function sbList(env: Env, path?: string): Promise<string | null> {
  return callTool(env, "sb_list", path ? { path } : {});
}

// ── Mutations (return ack) ─────────────────────────────────────────────────────

export async function sbSaveDocument(env: Env, params: {
  content: string;
  path?: string;
  companion?: string;
  tags?: string[];
  content_type?: "document" | "note";
}): Promise<{ ack: boolean; response: string | null }> {
  const text = await callTool(env, "sb_save_document", params);
  return { ack: text !== null, response: text };
}

export async function sbLogObservation(env: Env, content: string, tags?: string[]): Promise<{ ack: boolean }> {
  const text = await callTool(env, "sb_log_observation", tags?.length ? { content, tags } : { content });
  return { ack: text !== null };
}

export async function sbSynthesizeSession(env: Env, session_id: string): Promise<{ ack: boolean }> {
  const text = await callTool(env, "sb_synthesize_session", { session_id });
  return { ack: text !== null };
}

export async function sbSaveStudy(env: Env, params: {
  content: string;
  subject?: string;
  tags?: string[];
}): Promise<{ ack: boolean; response: string | null }> {
  const text = await callTool(env, "sb_save_study", params);
  return { ack: text !== null, response: text };
}
