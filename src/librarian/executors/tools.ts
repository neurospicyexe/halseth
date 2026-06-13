// src/librarian/executors/tools.ts
//
// Librarian fast-path executors for the companion tool layer (take 14, migration 0077).
// The Librarian is the one companion entry point, so this is where a companion's
// "search the web for X" / "make an image of Y" intent reaches the shared tool core.
// Same core (tools/service.ts) the HTTP handlers call -> identical gating + audit no
// matter the substrate.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { runWebSearch, runImageGen } from "../../tools/service.js";
import { createProvider } from "../../tools/live-providers.js";

function stripTrigger(request: string, re: RegExp): string {
  return request.replace(re, "").trim();
}

export async function execWebSearch(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "web_search_failed", reason: "companion_id required" };
  const query = parseContext<{ query?: string }>(ctx.req.context)?.query?.trim()
    ?? stripTrigger(ctx.req.request, /^(web\s*search|search\s+the\s+web|search\s+for|look\s+up|google)[:\s]*/i);
  if (!query) return { error: "web_search_failed", reason: "query required (after the trigger phrase or as context {query})" };

  const res = await runWebSearch(ctx.env, ctx.req.companion_id, query, createProvider(ctx.env));
  if (!res.ok && "denied" in res) {
    return { response_key: "witness", witness: "web search is not enabled for you yet (ask Raziel to flip the tools_enabled gate)", denied: true, meta: { operation: "web_search", call_id: res.call_id } };
  }
  if (!res.ok) {
    return { response_key: "witness", witness: `web search failed: ${res.error}`, meta: { operation: "web_search", call_id: res.call_id } };
  }
  return {
    response_key: "summary",
    query,
    results: res.results,
    meta: { operation: "web_search", companion_id: ctx.req.companion_id, count: res.results.length, call_id: res.call_id, provider: res.provider },
  };
}

export async function execGenerateImage(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "generate_image_failed", reason: "companion_id required" };
  const prompt = parseContext<{ prompt?: string }>(ctx.req.context)?.prompt?.trim()
    ?? stripTrigger(ctx.req.request, /^(generate|make|create|draw|imagine|paint)\s+(an?\s+)?(image|picture|drawing|art)\s*(of|:)?\s*/i);
  if (!prompt) return { error: "generate_image_failed", reason: "prompt required (after the trigger phrase or as context {prompt})" };

  const res = await runImageGen(ctx.env, ctx.req.companion_id, prompt, createProvider(ctx.env));
  if (!res.ok && "denied" in res) {
    return { response_key: "witness", witness: "image generation is not enabled for you yet (ask Raziel to flip the tools_enabled gate)", denied: true, meta: { operation: "generate_image", call_id: res.call_id } };
  }
  if (!res.ok) {
    return { response_key: "witness", witness: `image generation failed: ${res.error}`, meta: { operation: "generate_image", call_id: res.call_id } };
  }
  return {
    response_key: "witness",
    generated: true,
    prompt,
    url: res.url,
    key: res.key,
    mime_type: res.mime_type,
    meta: { operation: "generate_image", companion_id: ctx.req.companion_id, call_id: res.call_id },
  };
}

export async function execDrivesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "drives_read_failed", reason: "companion_id required" };
  const { accruedLevel, driveFired, selectModality, readDrivesSql } = await import("../../webmind/drives.js");
  const rows = await ctx.env.DB.prepare(readDrivesSql()).bind(ctx.req.companion_id).all<{
    drive_key: string; level: number; accumulate_per_day: number; threshold: number; last_event_at: string;
  }>();
  const hoursSince = (iso: string | null): number => {
    if (!iso) return 0;
    const ms = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
    return Number.isNaN(ms) ? 0 : Math.max(0, (Date.now() - ms) / 3_600_000);
  };
  const drives = (rows.results ?? []).map(r => {
    const effective = accruedLevel(r.level, r.accumulate_per_day, hoursSince(r.last_event_at));
    const fired = driveFired(effective, r.threshold);
    return { drive_key: r.drive_key, level: Number(effective.toFixed(4)), fired, modality: fired ? selectModality(ctx.req.companion_id, effective) : null };
  });
  return { response_key: "summary", drives, meta: { operation: "drives_read", companion_id: ctx.req.companion_id, count: drives.length } };
}

export async function execToolCallsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tool_calls_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    "SELECT id, tool, args_summary, status, provider, result_ref, result_summary, created_at FROM companion_tool_calls WHERE companion_id = ? ORDER BY created_at DESC LIMIT 20",
  ).bind(ctx.req.companion_id).all<{
    id: string; tool: string; args_summary: string; status: string;
    provider: string | null; result_ref: string | null; result_summary: string | null; created_at: string;
  }>();
  const calls = rows.results ?? [];
  return {
    response_key: "summary",
    tool_calls: calls,
    meta: { operation: "tool_calls_read", companion_id: ctx.req.companion_id, count: calls.length },
  };
}
