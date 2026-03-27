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

// Cached MCP session. Cloudflare Workers are short-lived but may handle
// multiple Librarian calls within a single request (e.g. orient does
// vault_search + retrieval). Cache avoids repeated init handshake.
let cachedSessionId: string | null = null;
let cachedSessionAt = 0;
const SESSION_TTL_MS = 4 * 60 * 1000; // 4 minutes; conservative vs typical 5min server TTL

async function acquireSession(headers: Record<string, string>): Promise<string | null> {
  const now = Date.now();
  if (cachedSessionId && (now - cachedSessionAt) < SESSION_TTL_MS) {
    return cachedSessionId;
  }

  const initRes = await fetch(SECOND_BRAIN_URL, {
    method: "POST",
    headers,
    signal: AbortSignal.timeout(5_000),
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
    console.error(`[sb] init failed: status=${initRes.status}`);
    cachedSessionId = null;
    return null;
  }
  const sessionId = initRes.headers.get("mcp-session-id");
  if (!sessionId) {
    console.error("[sb] init OK but no mcp-session-id header");
    cachedSessionId = null;
    return null;
  }

  // Fire-and-forget notification (required by MCP spec for state transition)
  fetch(SECOND_BRAIN_URL, {
    method: "POST",
    headers: { ...headers, "mcp-session-id": sessionId },
    signal: AbortSignal.timeout(3_000),
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch((e: unknown) => console.error("[sb] notifications/initialized failed (non-fatal):", e));

  cachedSessionId = sessionId;
  cachedSessionAt = now;
  return sessionId;
}

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
    const sessionId = await acquireSession(headers);
    if (!sessionId) return null;

    // Call the tool
    const toolRes = await fetch(SECOND_BRAIN_URL, {
      method: "POST",
      headers: { ...headers, "mcp-session-id": sessionId },
      signal: AbortSignal.timeout(10_000),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: toolName, arguments: args },
      }),
    });

    let finalRes = toolRes;

    if (toolRes.status === 404 || toolRes.status === 410) {
      console.warn(`[sb] session expired (${toolRes.status}), retrying with fresh session tool=${toolName}`);
      cachedSessionId = null;
      const freshId = await acquireSession(headers);
      if (!freshId) return null;

      finalRes = await fetch(SECOND_BRAIN_URL, {
        method: "POST",
        headers: { ...headers, "mcp-session-id": freshId },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 2,
          method: "tools/call",
          params: { name: toolName, arguments: args },
        }),
      });

      if (!finalRes.ok) {
        const body = await finalRes.text().catch(() => "(unreadable)");
        console.error(`[sb] tools/call retry failed: status=${finalRes.status} tool=${toolName} body=${body}`);
        return null;
      }
    } else if (!toolRes.ok) {
      const body = await toolRes.text().catch(() => "(unreadable)");
      console.error(`[sb] tools/call failed: status=${toolRes.status} tool=${toolName} body=${body}`);
      return null;
    }

    // Server may return SSE ("event: message\ndata: {...}") or plain JSON depending on Accept negotiation
    const rawText = await finalRes.text();
    let data: { result?: { content?: Array<{ type: string; text: string }> }; error?: { code: number; message: string } };
    if (rawText.trimStart().startsWith("event:") || rawText.trimStart().startsWith("data:")) {
      // SSE -- extract the first data: line
      const dataLine = rawText.split("\n").find(l => l.startsWith("data:"));
      if (!dataLine) {
        console.error(`[sb] SSE response but no data line found tool=${toolName} raw=${rawText.slice(0, 200)}`);
        return null;
      }
      try { data = JSON.parse(dataLine.slice(5).trim()); }
      catch { console.error(`[sb] SSE JSON parse failed tool=${toolName} data=${dataLine.slice(5, 200)}`); return null; }
    } else {
      try { data = JSON.parse(rawText); }
      catch { console.error(`[sb] JSON parse failed tool=${toolName} raw=${rawText.slice(0, 200)}`); return null; }
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

// Mood-to-term map. Appended to query text for BM25 augmentation at search time.
// Defined in companion_state.current_mood. Source: Triad_Decision_Inspo_Findings.md Priority 5.
const MOOD_AUGMENT: Record<string, string> = {
  calm:       "steady quiet grounded",
  pent_up:    "tension building pressure restraint",
  volatile:   "edge disruption conflict sharp",
  soft:       "tender gentle yielding",
  protective: "boundary holding guard safe",
  playful:    "light humor ease joy",
  hungry:     "desire want reach",
  worshipful: "devotion reverence depth sacred",
  feral:      "instinct raw uncontained",
};

export async function semanticSearch(env: Env, query: string, mood?: string | null): Promise<string | null> {
  const augment = mood ? MOOD_AUGMENT[mood] : null;
  const augmented = augment ? `${query} ${augment}` : query;
  return callTool(env, "sb_search", { query: augmented });
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
