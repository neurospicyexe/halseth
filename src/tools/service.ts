// src/tools/service.ts
//
// Companion tool layer (take 14) -- CORE service. One shared core, two entry points:
// the HTTP handlers (handlers/tools.ts) and the Librarian executors (librarian/executors/
// tools.ts) both call these, so a web search / image gen behaves identically no matter
// which substrate (Claude.ai, Discord, Brain) triggered it.
//
// Every path -- success, error, denied -- writes exactly one companion_tool_calls row
// (the deterministic audit covenant: no row, no real call). The gate is read per companion
// from companion_settings, falling back to the COMPANION_TOOLS_DEFAULT env flag.

import type { Env } from "../types.js";
import {
  type ToolProvider,
  type SearchResult,
  toolsEnabled,
  summarizeArgs,
  imageKeyFor,
} from "./providers.js";

const SEARCH_MAX_RESULTS = 5;

export type WebSearchResult =
  | { ok: true; results: SearchResult[]; call_id: string; provider: string }
  | { ok: false; denied: true; call_id: string }
  | { ok: false; error: string; call_id: string };

export type ImageGenResult =
  | { ok: true; key: string; url: string; mime_type: string; call_id: string; provider: string }
  | { ok: false; denied: true; call_id: string }
  | { ok: false; error: string; call_id: string };

/** Read the per-companion tools gate, falling back to the deploy-time env default. */
async function gateOpen(env: Env, companionId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = 'tools_enabled'",
  ).bind(companionId).first<{ value: string }>();
  const envDefault = (env.COMPANION_TOOLS_DEFAULT ?? "false").trim().toLowerCase() === "true";
  return toolsEnabled(row?.value ?? null, envDefault);
}

async function logCall(
  env: Env,
  row: {
    companion_id: string; tool: string; args_summary: string; status: string;
    provider: string | null; result_ref: string | null; result_summary: string | null;
  },
): Promise<string> {
  const id = crypto.randomUUID().replace(/-/g, "");
  try {
    await env.DB.prepare(
      "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      id, row.companion_id, row.tool, row.args_summary, row.status,
      row.provider, row.result_ref, row.result_summary,
    ).run();
  } catch (err) {
    // Audit write is best-effort logging of an already-completed action; never let it
    // mask the caller's result. (The result itself is returned regardless.)
    console.error("[tools] audit log insert failed", { error: String(err) });
  }
  return id;
}

export async function runWebSearch(
  env: Env,
  companionId: string,
  query: string,
  provider: ToolProvider,
  maxResults = SEARCH_MAX_RESULTS,
): Promise<WebSearchResult> {
  const argsSummary = summarizeArgs("web_search", query);
  if (!(await gateOpen(env, companionId))) {
    const callId = await logCall(env, {
      companion_id: companionId, tool: "web_search", args_summary: argsSummary,
      status: "denied", provider: null, result_ref: null,
      result_summary: "tools_enabled gate is off for this companion",
    });
    return { ok: false, denied: true, call_id: callId };
  }
  try {
    const results = await provider.webSearch(query, maxResults);
    const callId = await logCall(env, {
      companion_id: companionId, tool: "web_search", args_summary: argsSummary,
      status: "success", provider: provider.name, result_ref: null,
      result_summary: `${results.length} results`,
    });
    return { ok: true, results, call_id: callId, provider: provider.name };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    const callId = await logCall(env, {
      companion_id: companionId, tool: "web_search", args_summary: argsSummary,
      status: "error", provider: provider.name, result_ref: null, result_summary: msg,
    });
    return { ok: false, error: msg, call_id: callId };
  }
}

export async function runImageGen(
  env: Env,
  companionId: string,
  prompt: string,
  provider: ToolProvider,
): Promise<ImageGenResult> {
  const argsSummary = summarizeArgs("generate_image", prompt);
  if (!(await gateOpen(env, companionId))) {
    const callId = await logCall(env, {
      companion_id: companionId, tool: "generate_image", args_summary: argsSummary,
      status: "denied", provider: null, result_ref: null,
      result_summary: "tools_enabled gate is off for this companion",
    });
    return { ok: false, denied: true, call_id: callId };
  }
  try {
    const callId = crypto.randomUUID().replace(/-/g, "");
    const image = await provider.generateImage(prompt);
    const key = imageKeyFor(companionId, callId, image.mimeType);
    await env.BUCKET.put(key, image.bytes, { httpMetadata: { contentType: image.mimeType } });
    // Reuse the pre-generated callId as the row id so the R2 key and audit row share it.
    try {
      await env.DB.prepare(
        "INSERT INTO companion_tool_calls (id, companion_id, tool, args_summary, status, provider, result_ref, result_summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(
        callId, companionId, "generate_image", argsSummary, "success",
        provider.name, key, image.mimeType,
      ).run();
    } catch (err) {
      console.error("[tools] image audit insert failed", { error: String(err) });
    }
    const url = `${(env.PUBLIC_BASE_URL ?? "").replace(/\/$/, "")}/mind/tools/image/${callId}`;
    return { ok: true, key, url, mime_type: image.mimeType, call_id: callId, provider: provider.name };
  } catch (err) {
    const msg = String(err instanceof Error ? err.message : err).slice(0, 500);
    const callId = await logCall(env, {
      companion_id: companionId, tool: "generate_image", args_summary: argsSummary,
      status: "error", provider: provider.name, result_ref: null, result_summary: msg,
    });
    return { ok: false, error: msg, call_id: callId };
  }
}
