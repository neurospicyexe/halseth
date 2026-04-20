// src/handlers/webmind.ts
//
// HTTP route handlers for /mind/* endpoints.
// All routes require ADMIN_SECRET Bearer auth.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { mindOrient } from "../webmind/orient.js";
import { mindGround } from "../webmind/ground.js";
import { writeHandoff } from "../webmind/handoffs.js";
import { upsertThread } from "../webmind/threads.js";
import { addNote, getEligibleNotesForCompression, archiveNotes, type CompressibleNote } from "../webmind/notes.js";
import { semanticSearch } from "../librarian/backends/second-brain.js";
import { writeDream, readDreams, examineDream } from "../webmind/dreams.js";
import { writeLoop, readLoops, closeLoop } from "../webmind/loops.js";
import { writeRelationalState, readRelationalHistory } from "../webmind/relational.js";
import { writeLimbicState, getCurrentLimbicState } from "../webmind/limbic.js";
import { queueAndRunSpiral } from '../webmind/spiral.js';
import type { WmAgentId, WmHandoffInput, WmThreadUpsertInput, WmNoteInput, WmDreamInput, WmLoopInput, WmRelationalStateInput, WmLimbicStateInput, WmThreadStatus, WmSpiralInput } from "../webmind/types.js";

const VALID_AGENT_IDS: WmAgentId[] = ["cypher", "drevan", "gaia"];
const MAX_TEXT_LENGTH = 8000;

function isValidAgentId(id: string): id is WmAgentId {
  return (VALID_AGENT_IDS as string[]).includes(id);
}

function exceedsLimit(val: unknown): boolean {
  return typeof val === "string" && val.length > MAX_TEXT_LENGTH;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// GET /mind/orient/:agent_id
export async function getMindOrient(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const result = await mindOrient(env, agent_id);
    return json(result);
  } catch (err) {
    console.error("[mind/orient] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/orient-debug/:agent_id
export async function getMindOrientDebug(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const row = await env.DB.prepare(
      "SELECT last_orient_debug FROM companion_state WHERE companion_id = ?"
    ).bind(agent_id).first<{ last_orient_debug: string | null }>();

    if (!row?.last_orient_debug) {
      return json({ agent_id, debug: null });
    }

    const debug = JSON.parse(row.last_orient_debug);
    return json({ agent_id, debug });
  } catch (err) {
    console.error("[mind/orient-debug] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/ground/:agent_id
export async function getMindGround(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const result = await mindGround(env, agent_id);
    return json(result);
  } catch (err) {
    console.error("[mind/ground] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/handoff
export async function postMindHandoff(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmHandoffInput;
  try {
    body = await request.json() as WmHandoffInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.agent_id || !isValidAgentId(body.agent_id)) {
    return json({ error: "agent_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!body.title || typeof body.title !== "string") {
    return json({ error: "title is required" }, 400);
  }
  if (!body.summary || typeof body.summary !== "string") {
    return json({ error: "summary is required" }, 400);
  }

  for (const field of ["title", "summary", "next_steps", "open_loops", "state_hint"] as const) {
    if (exceedsLimit(body[field])) {
      return json({ error: `${field} exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
    }
  }

  try {
    const result = await writeHandoff(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/handoff] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/thread
export async function postMindThread(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmThreadUpsertInput;
  try {
    body = await request.json() as WmThreadUpsertInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.agent_id || !isValidAgentId(body.agent_id)) {
    return json({ error: "agent_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!body.thread_key || typeof body.thread_key !== "string") {
    return json({ error: "thread_key is required" }, 400);
  }
  if (!body.title || typeof body.title !== "string") {
    return json({ error: "title is required" }, 400);
  }

  for (const field of ["title", "context", "event_content"] as const) {
    if (exceedsLimit(body[field])) {
      return json({ error: `${field} exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
    }
  }

  try {
    const result = await upsertThread(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/thread] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/dream
export async function postMindDream(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmDreamInput;
  try {
    body = await request.json() as WmDreamInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!body.dream_text || typeof body.dream_text !== "string") {
    return json({ error: "dream_text is required" }, 400);
  }
  if (exceedsLimit(body.dream_text)) {
    return json({ error: `dream_text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
  }

  try {
    const result = await writeDream(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/dream] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/dreams/:agent_id
export async function getMindDreams(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  const url = new URL(request.url);
  const examined = url.searchParams.get("examined") === "true";

  try {
    const dreams = await readDreams(env, agent_id, { examined });
    return json({ dreams });
  } catch (err) {
    console.error("[mind/dreams] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/dream/:id/examine
export async function postMindDreamExamine(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id || typeof id !== "string") {
    return json({ error: "dream id is required" }, 400);
  }

  let body: { companion_id: string };
  try {
    body = await request.json() as { companion_id: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }

  try {
    const result = await examineDream(env, id, body.companion_id);
    return json(result);
  } catch (err) {
    console.error("[mind/dream/examine] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/dream/:id/pin
export async function postMindDreamPin(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id || typeof id !== "string") {
    return json({ error: "dream id is required" }, 400);
  }

  let body: { companion_id: string; do_not_auto_examine: number };
  try {
    body = await request.json() as { companion_id: string; do_not_auto_examine: number };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }

  const pinValue = body.do_not_auto_examine === 1 ? 1 : 0;

  try {
    const result = await env.DB.prepare(
      "UPDATE companion_dreams SET do_not_auto_examine = ? WHERE id = ? AND companion_id = ?"
    ).bind(pinValue, id, body.companion_id).run();
    const ok = (result.meta?.changes ?? 0) > 0;
    return json({ ok });
  } catch (err) {
    console.error("[mind/dream/pin] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/loop
export async function postMindLoop(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmLoopInput;
  try {
    body = await request.json() as WmLoopInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!body.loop_text || typeof body.loop_text !== "string") {
    return json({ error: "loop_text is required" }, 400);
  }
  if (exceedsLimit(body.loop_text)) {
    return json({ error: `loop_text exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  if (body.weight !== undefined && (typeof body.weight !== "number" || body.weight < 0 || body.weight > 1)) {
    return json({ error: "weight must be a number between 0 and 1" }, 400);
  }

  try {
    const result = await writeLoop(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/loop] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/loops/:agent_id
export async function getMindLoops(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  const url = new URL(request.url);
  const include_closed = url.searchParams.get("include_closed") === "true";

  try {
    const loops = await readLoops(env, agent_id, { include_closed });
    return json({ loops });
  } catch (err) {
    console.error("[mind/loops] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/loop/:id/close
export async function postMindLoopClose(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { id } = params;
  if (!id || typeof id !== "string") {
    return json({ error: "loop id is required" }, 400);
  }

  let body: { companion_id: string };
  try {
    body = await request.json() as { companion_id: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }

  try {
    const result = await closeLoop(env, id, body.companion_id);
    return json(result);
  } catch (err) {
    console.error("[mind/loop/close] error", { id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/relational
export async function postMindRelational(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmRelationalStateInput;
  try {
    body = await request.json() as WmRelationalStateInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.companion_id || !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!body.toward || typeof body.toward !== "string" || body.toward.trim().length === 0) {
    return json({ error: "toward is required" }, 400);
  }
  if (!body.state_text || typeof body.state_text !== "string") {
    return json({ error: "state_text is required" }, 400);
  }
  if (exceedsLimit(body.state_text) || exceedsLimit(body.toward)) {
    return json({ error: `fields exceed maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
  }
  if (body.weight !== undefined && (typeof body.weight !== "number" || body.weight < 0 || body.weight > 1)) {
    return json({ error: "weight must be a number between 0 and 1" }, 400);
  }

  try {
    const result = await writeRelationalState(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/relational] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/relational/:agent_id
export async function getMindRelational(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  const url = new URL(request.url);
  const toward = url.searchParams.get("toward") ?? undefined;

  try {
    const states = await readRelationalHistory(env, agent_id, { toward });
    return json({ states });
  } catch (err) {
    console.error("[mind/relational] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/note
export async function postMindNote(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmNoteInput;
  try {
    body = await request.json() as WmNoteInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.agent_id || !isValidAgentId(body.agent_id)) {
    return json({ error: "agent_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!body.content || typeof body.content !== "string") {
    return json({ error: "content is required" }, 400);
  }

  if (exceedsLimit(body.content)) {
    return json({ error: `content exceeds maximum length of ${MAX_TEXT_LENGTH} characters` }, 400);
  }

  try {
    const result = await addNote(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/note] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/search?query=...
// Proxies a semantic search against Second Brain for Discord bots (Thalamus pattern).
// Returns { query, result } where result is the raw sb_search string or null.
export async function getMindSearch(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const query = url.searchParams.get("query")?.trim();
  if (!query) return json({ error: "query is required" }, 400);
  if (query.length > 500) return json({ error: "query must be 500 characters or fewer" }, 400);

  const agentId = url.searchParams.get("agent_id")?.trim() ?? null;

  try {
    const result = await semanticSearch(env, query);

    if (agentId && isValidAgentId(agentId)) {
      const hitCount = (() => {
        try { return (JSON.parse(result ?? "{}") as { chunks?: unknown[] })?.chunks?.length ?? 0; }
        catch { return result ? 1 : 0; }
      })();
      env.DB.prepare(
        `INSERT INTO sb_search_log (id, companion_id, query, hit_count, source) VALUES (?, ?, ?, ?, 'message')`
      ).bind(crypto.randomUUID(), agentId, query.slice(0, 200), hitCount).run().catch(() => null);
    }

    return json({ query, result });
  } catch (err) {
    console.error("[mind/search] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/sb-search-log/:agent_id
export async function getMindSbSearchLog(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { agent_id } = params;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `Invalid agent_id: must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const rows = await env.DB.prepare(
      "SELECT query, hit_count, source, created_at FROM sb_search_log WHERE companion_id = ? ORDER BY created_at DESC LIMIT 20"
    ).bind(agent_id).all<{ query: string; hit_count: number; source: string; created_at: string }>();

    const entries = rows.results ?? [];
    const total = entries.length;
    const hits = entries.filter(r => r.hit_count > 0).length;
    const hit_rate = total > 0 ? Math.round((hits / total) * 100) : null;

    return json({ agent_id, entries, total, hits, hit_rate, last_query: entries[0]?.query ?? null });
  } catch (err) {
    console.error("[mind/sb-search-log] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/limbic
export async function postMindLimbic(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: WmLimbicStateInput;
  try {
    body = await request.json() as WmLimbicStateInput;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.synthesis_source || typeof body.synthesis_source !== "string") {
    return json({ error: "synthesis_source is required" }, 400);
  }
  if (!body.drift_vector || typeof body.drift_vector !== "string") {
    return json({ error: "drift_vector is required" }, 400);
  }
  if (!body.emotional_register || typeof body.emotional_register !== "string") {
    return json({ error: "emotional_register is required" }, 400);
  }
  if (!Array.isArray(body.active_concerns)) {
    return json({ error: "active_concerns must be an array" }, 400);
  }
  if (!Array.isArray(body.live_tensions)) {
    return json({ error: "live_tensions must be an array" }, 400);
  }
  if (!Array.isArray(body.open_questions)) {
    return json({ error: "open_questions must be an array" }, 400);
  }
  if (!Array.isArray(body.swarm_threads)) {
    return json({ error: "swarm_threads must be an array" }, 400);
  }
  if (body.companion_id !== undefined && !isValidAgentId(body.companion_id)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }

  try {
    const result = await writeLimbicState(env, body);
    return json(result, 201);
  } catch (err) {
    console.error("[mind/limbic] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/limbic/current
export async function getMindLimbicCurrent(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  try {
    const state = await getCurrentLimbicState(env);
    if (!state) {
      return json({ limbic_state: null });
    }
    return json({ limbic_state: state });
  } catch (err) {
    console.error("[mind/limbic/current] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/notes/compress-eligible
export async function getMindCompressEligible(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const url = new URL(request.url);
  const agent_id = url.searchParams.get("agent_id");
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: `agent_id required and must be one of ${VALID_AGENT_IDS.join(", ")}` }, 400);
  }

  try {
    const notes = await getEligibleNotesForCompression(env, agent_id);
    return json({ notes });
  } catch (err) {
    console.error("[mind/notes/compress-eligible] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/notes/archive
export async function postMindNotesArchive(
  request: Request,
  env: Env,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: { agent_id?: string; notes?: unknown[]; summary?: string };
  try {
    body = await request.json() as { agent_id?: string; notes?: unknown[]; summary?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const { agent_id, notes, summary } = body;
  if (!agent_id || !isValidAgentId(agent_id)) {
    return json({ error: "agent_id required and must be cypher, drevan, or gaia" }, 400);
  }
  if (!Array.isArray(notes)) {
    return json({ error: "notes[] is required" }, 400);
  }
  if (!summary || typeof summary !== "string") {
    return json({ error: "summary is required" }, 400);
  }
  if (!notes.every(n => typeof (n as { note_id?: unknown }).note_id === "string" && (n as { note_id?: string }).note_id)) {
    return new Response(JSON.stringify({ error: "each note must have a non-empty note_id string" }), { status: 400, headers: { "Content-Type": "application/json" } });
  }

  try {
    const result = await archiveNotes(env, agent_id, notes as CompressibleNote[], summary);
    return json(result);
  } catch (err) {
    console.error("[mind/notes/archive] error", { agent_id, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/thread/:thread_key/status
export async function patchMindThreadStatus(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const threadKey = params["thread_key"];
  if (!threadKey) return json({ error: "thread_key param required" }, 400);

  let body: { agent_id?: string; status?: string };
  try {
    body = await request.json() as { agent_id?: string; status?: string };
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  if (!body.agent_id || !isValidAgentId(body.agent_id)) {
    return json({ error: "agent_id required and must be cypher, drevan, or gaia" }, 400);
  }

  const VALID_STATUSES: WmThreadStatus[] = ["open", "paused", "resolved", "archived"];
  if (!body.status || !VALID_STATUSES.includes(body.status as WmThreadStatus)) {
    return json({ error: `status must be one of: ${VALID_STATUSES.join(", ")}` }, 400);
  }

  const now = new Date().toISOString();
  try {
    const r = await env.DB.prepare(
      "UPDATE wm_mind_threads SET status = ?, status_changed = ?, updated_at = ? WHERE thread_key = ? AND agent_id = ?"
    ).bind(body.status, now, now, threadKey, body.agent_id).run();
    if (r.meta.changes === 0) return json({ error: "Thread not found" }, 404);
    return json({ ok: true, thread_key: threadKey, status: body.status });
  } catch (err) {
    console.error("[mind/thread/status] error", { thread_key: threadKey, error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

const VALID_SPIRAL_SEED_TYPES = new Set(['tension', 'open_loop', 'belief_contradiction', 'free_text']);

// POST /mind/spiral/run
export async function postMindSpiralRun(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }

  if (typeof body.companion_id !== 'string' || !isValidAgentId(body.companion_id)) {
    return json({ error: 'invalid companion_id' }, 400);
  }
  if (typeof body.seed_text !== 'string' || !body.seed_text.trim()) {
    return json({ error: 'seed_text required' }, 400);
  }
  if (exceedsLimit(body.seed_text)) {
    return json({ error: 'seed_text too long (max 8000 chars)' }, 400);
  }

  const seed_type = typeof body.seed_type === 'string' && VALID_SPIRAL_SEED_TYPES.has(body.seed_type)
    ? body.seed_type as WmSpiralInput['seed_type']
    : 'free_text';

  const input: WmSpiralInput = {
    companion_id: body.companion_id,
    seed_text: (body.seed_text as string).trim(),
    seed_type,
    seed_ref_id: typeof body.seed_ref_id === 'string' ? body.seed_ref_id : undefined,
  };

  try {
    const run = await queueAndRunSpiral(env, input);
    return json(run, 201);
  } catch (err) {
    console.error('[mind/spiral/run] error', String(err));
    return json({ error: 'spiral run failed', detail: String(err) }, 500);
  }
}

// GET /mind/spiral/:companion_id
export async function getMindSpiralRuns(
  request: Request,
  env: Env,
  params: Record<string, string>,
): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const { companion_id } = params;
  if (!companion_id || !isValidAgentId(companion_id)) {
    return json({ error: 'invalid companion_id' }, 400);
  }

  const url = new URL(request.url);
  const parsed = parseInt(url.searchParams.get('limit') ?? '10', 10);
  const limit = Math.min(isNaN(parsed) ? 10 : parsed, 50);

  try {
    const rows = await env.DB.prepare(
      'SELECT * FROM companion_spiral_runs WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?'
    ).bind(companion_id, limit).all();
    return json({ runs: rows.results });
  } catch (err) {
    console.error('[mind/spiral] DB error', String(err));
    return json({ error: 'failed to fetch spiral runs' }, 500);
  }
}
