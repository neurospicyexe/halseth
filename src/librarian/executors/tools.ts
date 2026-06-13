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
import { accruedLevel, driveFired, selectModality, hoursSinceIso, readDrivesSql } from "../../webmind/drives.js";
import {
  isValidAction, trustDelta, actionMood,
  listCreaturesSql, insertInteractionSql, interactBumpSql,
} from "../../webmind/creatures.js";

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
  const rows = await ctx.env.DB.prepare(readDrivesSql()).bind(ctx.req.companion_id).all<{
    drive_key: string; level: number; accumulate_per_day: number; threshold: number; last_event_at: string;
  }>();
  const drives = (rows.results ?? []).map(r => {
    const effective = accruedLevel(r.level, r.accumulate_per_day, hoursSinceIso(r.last_event_at));
    const fired = driveFired(effective, r.threshold);
    return { drive_key: r.drive_key, level: Number(effective.toFixed(4)), fired, modality: fired ? selectModality(ctx.req.companion_id, effective) : null };
  });
  return { response_key: "summary", drives, meta: { operation: "drives_read", companion_id: ctx.req.companion_id, count: drives.length } };
}

// take 10 -- creatures are shared presences (corvid + Raziel's animals); any companion
// can ask after them, so no companion_id gate on the read.
export async function execCreaturesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await ctx.env.DB.prepare(listCreaturesSql()).all<{
    id: string; name: string; species: string | null; kind: string; bio: string | null;
    state_json: string | null; trust: number; last_interaction_at: string | null;
  }>();
  const creatures = (rows.results ?? []).map(c => {
    let mood: string | null = null;
    try { mood = c.state_json ? (JSON.parse(c.state_json).mood ?? null) : null; } catch { /* malformed json -> no mood */ }
    return {
      id: c.id, name: c.name, species: c.species, kind: c.kind, bio: c.bio,
      trust: Number((c.trust ?? 0).toFixed(3)), mood, last_interaction_at: c.last_interaction_at,
    };
  });
  return { response_key: "summary", creatures, meta: { operation: "creatures_read", count: creatures.length } };
}

// take 10 -- a companion interacts with a creature (feed|play|talk|give). Atomic SQL
// trust bump + append-only log, exactly the handler path. Name lookup is exact-first
// then LIKE (name_lookup_exact_first doctrine) so a write never lands on the wrong row.
export async function execCreatureInteract(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "creature_interact_failed", reason: "companion_id required (the actor)" };
  const parsed = parseContext<{ creature?: string; creature_name?: string; action?: string; note?: string }>(ctx.req.context);
  const name = (parsed?.creature ?? parsed?.creature_name ?? "").trim();
  const action = (parsed?.action ?? "").trim().toLowerCase();
  if (!name) return { error: "creature_interact_failed", reason: "creature name required (context {creature, action})" };
  if (!isValidAction(action)) return { error: "creature_interact_failed", reason: "action must be one of feed, play, talk, give" };
  const note = parsed?.note?.trim().slice(0, 500) ?? null;

  const creature = (await ctx.env.DB.prepare("SELECT id, name FROM creatures WHERE name = ? COLLATE NOCASE").bind(name).first<{ id: string; name: string }>())
    ?? (await ctx.env.DB.prepare("SELECT id, name FROM creatures WHERE name LIKE ? COLLATE NOCASE ORDER BY name ASC LIMIT 1").bind(`%${name}%`).first<{ id: string; name: string }>());
  if (!creature) return { error: "creature_interact_failed", reason: `no creature matching "${name}"` };

  const interactionId = crypto.randomUUID().replace(/-/g, "");
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(insertInteractionSql()).bind(interactionId, creature.id, ctx.req.companion_id, action, note),
    ctx.env.DB.prepare(interactBumpSql()).bind(trustDelta(action), actionMood(action), creature.id),
  ]);
  const updated = await ctx.env.DB.prepare("SELECT trust FROM creatures WHERE id = ?").bind(creature.id).first<{ trust: number }>();
  return {
    response_key: "witness",
    witness: `you ${action === "give" ? "gave something to" : action} ${creature.name}`,
    interacted: true,
    meta: { operation: "creature_interact", creature: creature.name, action, trust: updated?.trust ?? null },
  };
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
