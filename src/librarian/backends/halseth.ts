// src/librarian/backends/halseth.ts
//
// Internal D1 function calls. Imports directly from src/mcp/tools/.
// No HTTP, no MCP protocol. Zero latency.

import { Env } from "../../types.js";
import { embedAndStoreAsync, storeVector, composeHandoverText } from "../../mcp/embed.js";
import {
  loadSessionData, SessionLoadInput,
  loadOrientData, SessionOrientInput,
  loadGroundData, SessionGroundInput,
  loadLightGroundData,
} from "../../mcp/tools/session_load.js";
import { generateId } from "../../db/queries.js";
import { classifyDomainTags, classifyKeywordTags } from "../../synthesis/tag-classifier.js";
import { MACHINE_SOURCES } from "../../webmind/notes.js";
import { noveltyCheck } from "../../webmind/novelty.js";

export async function sessionLoad(env: Env, input: SessionLoadInput) {
  return loadSessionData(env, input);
}

export async function sessionOrient(env: Env, input: SessionOrientInput) {
  return loadOrientData(env, input);
}

export async function sessionGround(env: Env, input: SessionGroundInput) {
  return loadGroundData(env, input);
}

export async function sessionLightGround(env: Env, input: SessionGroundInput) {
  return loadLightGroundData(env, input);
}

export async function taskList(env: Env, companionId: string, status?: string) {
  const statusClause = status ? "AND status = ?" : "AND status != 'done'";
  const bindings: unknown[] = status ? [companionId, status] : [companionId];
  const tasks = await env.DB.prepare(
    `SELECT * FROM tasks WHERE (assigned_to = ? OR assigned_to IS NULL) ${statusClause} ORDER BY priority DESC, created_at ASC LIMIT 20`
  ).bind(...bindings).all();
  return tasks.results ?? [];
}

export async function handoverRead(env: Env) {
  return env.DB.prepare(
    "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT 1"
  ).first();
}

// ── Data reads (raw passthrough) ─────────────────────────────────────────────

export async function feelingsRead(env: Env, companionId: string, limit = 20) {
  const r = await env.DB.prepare(
    "SELECT * FROM feelings WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companionId, limit).all();
  return r.results ?? [];
}

export async function journalRead(env: Env, limit = 20) {
  const r = await env.DB.prepare(
    "SELECT * FROM human_journal ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all();
  return r.results ?? [];
}

export async function woundRead(env: Env) {
  const r = await env.DB.prepare(
    "SELECT * FROM living_wounds ORDER BY created_at DESC"
  ).all();
  return r.results ?? [];
}

export async function deltaRead(env: Env, companionId: string, limit = 20) {
  // Two row shapes: legacy has companion_id=companionId; MCP-logged has companion_id='' + agent=companionId.
  const r = await env.DB.prepare(
    "SELECT * FROM relational_deltas WHERE (companion_id = ? OR (agent = ? AND delta_text IS NOT NULL)) ORDER BY created_at DESC LIMIT ?"
  ).bind(companionId, companionId, limit).all();
  return r.results ?? [];
}

export async function dreamsRead(env: Env, companionId: string, limit = 10) {
  const r = await env.DB.prepare(
    "SELECT * FROM companion_dreams WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companionId, limit).all();
  return r.results ?? [];
}

export async function dreamSeedRead(env: Env, companionId: string) {
  // Atomic claim-on-read: single UPDATE with RETURNING clause.
  // If no unclaimed seed exists, returns null (no rows updated).
  const now = new Date().toISOString();
  const seed = await env.DB.prepare(
    `UPDATE dream_seeds
     SET claimed_at = ?, claimed_by = ?
     WHERE id = (
       SELECT id FROM dream_seeds
       WHERE claimed_at IS NULL
         AND (for_companion IS NULL OR for_companion = ?)
       ORDER BY created_at ASC
       LIMIT 1
     )
     RETURNING *`
  ).bind(now, companionId, companionId).first<Record<string, unknown>>();

  return seed ?? null;
}

export async function eqRead(env: Env, companionId: string, limit = 5) {
  const r = await env.DB.prepare(
    "SELECT * FROM eq_snapshots WHERE companion_id = ? ORDER BY calculated_at DESC LIMIT ?"
  ).bind(companionId, limit).all();
  return r.results ?? [];
}

export async function routineRead(env: Env, limit = 20) {
  const r = await env.DB.prepare(
    "SELECT * FROM routines ORDER BY logged_at DESC LIMIT ?"
  ).bind(limit).all();
  return r.results ?? [];
}

export async function listRead(env: Env, listName?: string) {
  if (listName) {
    const r = await env.DB.prepare(
      "SELECT * FROM lists WHERE list_name = ? AND completed = 0 ORDER BY added_at DESC"
    ).bind(listName).all();
    return r.results ?? [];
  }
  const r = await env.DB.prepare(
    "SELECT * FROM lists WHERE completed = 0 ORDER BY added_at DESC LIMIT 50"
  ).all();
  return r.results ?? [];
}

export async function eventList(env: Env, limit = 20) {
  const r = await env.DB.prepare(
    "SELECT * FROM events ORDER BY start_time ASC LIMIT ?"
  ).bind(limit).all();
  return r.results ?? [];
}

export async function houseRead(env: Env) {
  return env.DB.prepare("SELECT * FROM house_state WHERE id = 'main'").first();
}

export async function personalityRead(env: Env) {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [valenceAll, valence30d, initiatedBy, agents, totals] = await Promise.all([
    env.DB.prepare("SELECT valence, COUNT(*) as n FROM relational_deltas WHERE valence IS NOT NULL GROUP BY valence").all<{ valence: string; n: number }>(),
    env.DB.prepare("SELECT valence, COUNT(*) as n FROM relational_deltas WHERE valence IS NOT NULL AND created_at >= ? GROUP BY valence").bind(thirtyDaysAgo).all<{ valence: string; n: number }>(),
    env.DB.prepare("SELECT initiated_by, COUNT(*) as n FROM relational_deltas WHERE initiated_by IS NOT NULL GROUP BY initiated_by").all<{ initiated_by: string; n: number }>(),
    env.DB.prepare("SELECT agent, COUNT(*) as n FROM relational_deltas WHERE agent IS NOT NULL GROUP BY agent").all<{ agent: string; n: number }>(),
    env.DB.prepare("SELECT COUNT(*) as total, MIN(created_at) as first_at, MAX(created_at) as last_at FROM relational_deltas").first<{ total: number; first_at: string | null; last_at: string | null }>(),
  ]);
  const toMap = (rows: { [k: string]: unknown; n: number }[], key: string) =>
    Object.fromEntries((rows ?? []).map(r => [r[key] as string, r.n]));
  return {
    total_deltas: totals?.total ?? 0,
    first_delta:  totals?.first_at ?? null,
    last_delta:   totals?.last_at ?? null,
    valence:      toMap(valenceAll.results ?? [], "valence"),
    valence_30d:  toMap(valence30d.results ?? [], "valence"),
    initiated_by: toMap(initiatedBy.results ?? [], "initiated_by"),
    agents:       toMap(agents.results ?? [], "agent"),
  };
}

export async function biometricRead(env: Env, limit = 10) {
  const r = await env.DB.prepare(
    "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT ?"
  ).bind(limit).all();
  return r.results ?? [];
}

export async function auditRead(env: Env, limit = 20) {
  const r = await env.DB.prepare(
    "SELECT * FROM cypher_audit ORDER BY created_at DESC LIMIT ?"
  ).bind(limit).all();
  return r.results ?? [];
}

export async function sessionRead(env: Env, companionId: string) {
  return env.DB.prepare(
    "SELECT * FROM sessions WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(companionId).first();
}

export async function fossilCheck(env: Env, subject: string) {
  const fossil = await env.DB.prepare(
    "SELECT * FROM prohibited_fossils WHERE subject = ? LIMIT 1"
  ).bind(subject).first();
  return fossil
    ? { has_directive: true, ...fossil }
    : { has_directive: false, subject };
}

// ── Mutations (return ack + id) ───────────────────────────────────────────────

export async function feelingLog(env: Env, params: {
  companion_id: string; emotion: string; sub_emotion?: string;
  intensity?: number; source?: string; session_id?: string;
}): Promise<{ id: string; created_at: string }> {
  // Dedup guard: if no session_id, skip if same emotion+sub_emotion logged within 60 min.
  // Prevents automated health checks from polluting the feelings record.
  if (!params.session_id) {
    const cutoff = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const conditions: string[] = ["companion_id = ?", "emotion = ?", "session_id IS NULL", "created_at > ?"];
    const bindings: unknown[] = [params.companion_id, params.emotion, cutoff];
    if (!params.sub_emotion) {
      conditions.push("sub_emotion IS NULL");
    } else {
      conditions.push("sub_emotion = ?");
      bindings.push(params.sub_emotion);
    }
    const dupe = await env.DB.prepare(
      `SELECT id, created_at FROM feelings WHERE ${conditions.join(" AND ")} LIMIT 1`
    ).bind(...bindings).first<{ id: string; created_at: string }>();
    if (dupe) return { id: dupe.id, created_at: dupe.created_at };
  }
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO feelings (id, companion_id, session_id, emotion, sub_emotion, intensity, source, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, params.companion_id, params.session_id ?? null, params.emotion, params.sub_emotion ?? null, params.intensity ?? 50, params.source ?? null, now).run();
  return { id, created_at: now };
}

export async function journalAdd(env: Env, params: {
  entry_text: string; emotion_tag?: string; sub_emotion?: string; mood_score?: number; tags?: string;
}): Promise<{ id: string; created_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO human_journal (id, created_at, entry_text, emotion_tag, sub_emotion, mood_score, tags) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, now, params.entry_text, params.emotion_tag ?? null, params.sub_emotion ?? null, params.mood_score ?? null, params.tags ?? null).run();
  return { id, created_at: now };
}

export async function dreamLog(env: Env, params: {
  companion_id: string; dream_type: string; content: string; source_ids?: string; session_id?: string;
}): Promise<{ id: string; created_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  const source = params.session_id ? "session" : "autonomous";
  await env.DB.prepare(
    "INSERT INTO companion_dreams (id, companion_id, dream_text, source, created_at) VALUES (?, ?, ?, ?, ?)"
  ).bind(id, params.companion_id, params.content, source, now).run();
  return { id, created_at: now };
}

export async function woundAdd(env: Env, params: {
  name: string; description: string; witness_type: string;
}): Promise<{ id: string; created_at: string; witness_type: string } | { error: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  try {
    await env.DB.prepare(
      "INSERT INTO living_wounds (id, created_at, name, description, do_not_archive, do_not_resolve, last_visited, last_surfaced_by) VALUES (?, ?, ?, ?, 1, 1, ?, 'companion')"
    ).bind(id, now, params.name, params.description, now).run();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("UNIQUE") || msg.includes("unique")) return { error: "A wound with this name already exists." };
    throw err;
  }
  return { id, created_at: now, witness_type: params.witness_type };
}

export async function deltaLog(env: Env, params: {
  agent: string; delta_text: string; valence?: string; initiated_by?: string; session_id?: string;
}): Promise<{ id: string; created_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO relational_deltas (id, companion_id, subject_id, delta_type, payload_json, session_id, created_at, agent, delta_text, valence, initiated_by) VALUES (?, '', 'mcp', 'mcp_delta', '{}', ?, ?, ?, ?, ?, ?)"
  ).bind(id, params.session_id ?? null, now, params.agent, params.delta_text, params.valence ?? null, params.initiated_by ?? null).run();
  return { id, created_at: now };
}

export async function eqSnapshot(env: Env, companionId: string): Promise<Record<string, unknown>> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
  const [feelings, deltas] = await Promise.all([
    env.DB.prepare("SELECT emotion, sub_emotion, intensity FROM feelings WHERE companion_id = ? ORDER BY created_at DESC LIMIT 200").bind(companionId).all<{ emotion: string; sub_emotion: string | null; intensity: number }>(),
    env.DB.prepare("SELECT valence, initiated_by FROM relational_deltas WHERE delta_text IS NOT NULL AND (companion_id = ? OR agent = ?) ORDER BY created_at DESC LIMIT 200").bind(companionId, companionId).all<{ valence: string | null; initiated_by: string | null }>(),
  ]);
  const f = feelings.results ?? [];
  const d = deltas.results ?? [];
  const distinct = new Set(f.map(x => x.emotion.toLowerCase())).size;
  const subCount = f.filter(x => x.sub_emotion !== null).length;
  const selfAwareness = Math.round((Math.min(distinct / 15, 1) * 0.6 + (f.length ? subCount / f.length : 0) * 0.4) * 100);
  const repairNeutral = d.filter(x => x.valence === "repair" || x.valence === "neutral").length;
  const selfManagement = d.length ? Math.round((repairNeutral / d.length) * 100) : null;
  const towardTender = d.filter(x => x.valence === "toward" || x.valence === "tender").length;
  const socialAwareness = d.length ? Math.round((towardTender / d.length) * 100) : null;
  const companionMutual = d.filter(x => x.initiated_by === "companion" || x.initiated_by === "mutual").length;
  const relationshipMgmt = d.length ? Math.round((companionMutual / d.length) * 100) : null;
  // Approximate MBTI from signal patterns
  const introverted = f.filter(x => x.emotion.toLowerCase().includes("overwhelm") || x.emotion.toLowerCase().includes("fatigue")).length > f.length * 0.2;
  const dominant_mbti = `${introverted ? "I" : "E"}${socialAwareness !== null && socialAwareness > 50 ? "F" : "T"}`;
  const id = generateId();
  const now = new Date().toISOString();
  // Only store non-null scores
  const recentFeelings = f.slice(0, 20);
  const recentDeltas = d.slice(0, 20);
  await env.DB.prepare(
    "INSERT INTO eq_snapshots (id, companion_id, calculated_at, self_awareness_score, self_management_score, social_awareness_score, relationship_mgmt_score, dominant_mbti) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, companionId, now, selfAwareness, selfManagement, socialAwareness, relationshipMgmt, dominant_mbti).run();
  return { id, calculated_at: now, self_awareness: selfAwareness, self_management: selfManagement, social_awareness: socialAwareness, relationship_mgmt: relationshipMgmt, dominant_mbti };
}

export async function taskAdd(env: Env, params: {
  title: string; description?: string; priority?: string; due_at?: string;
  assigned_to?: string; created_by?: string; shared?: boolean;
}): Promise<{ id: string; title: string; status: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO tasks (id, title, description, priority, due_at, assigned_to, status, created_at, updated_at, created_by, shared) VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?)"
  ).bind(id, params.title, params.description ?? null, params.priority ?? "normal", params.due_at ?? null, params.assigned_to ?? null, now, now, params.created_by ?? null, params.shared ? 1 : 0).run();
  return { id, title: params.title, status: "open" };
}

export async function taskUpdateStatus(env: Env, id: string, status: string): Promise<{ id: string; status: string } | { error: string }> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?").bind(status, now, id).run();
  if (result.meta.changes === 0) return { error: "Task not found" };
  return { id, status };
}

export async function sessionClose(env: Env, params: {
  session_id: string; spine: string; last_real_thing: string; open_threads?: string[];
  motion_state: string; active_anchor?: string; notes?: string; spiral_complete?: boolean;
  somaFields?: CompanionStateUpdate; companionId?: string;
}): Promise<{ id: string; spine: string }> {
  const existing = await env.DB.prepare("SELECT handover_id FROM sessions WHERE id = ?").bind(params.session_id).first<{ handover_id: string | null }>();
  if (existing?.handover_id) return { id: existing.handover_id, spine: params.spine };
  const handoverId = generateId();
  const now = new Date().toISOString();

  const stmts: ReturnType<typeof env.DB.prepare>[] = [
    env.DB.prepare(
      "INSERT INTO handover_packets (id, session_id, created_at, spine, active_anchor, last_real_thing, open_threads, motion_state, returned) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)"
    ).bind(handoverId, params.session_id, now, params.spine, params.active_anchor ?? null, params.last_real_thing, params.open_threads ? JSON.stringify(params.open_threads) : null, params.motion_state),
    env.DB.prepare(
      "UPDATE sessions SET updated_at = ?, spiral_complete = ?, notes = ?, handover_id = ? WHERE id = ?"
    ).bind(now, params.spiral_complete ? 1 : 0, params.notes ?? null, handoverId, params.session_id),
  ];

  // Atomically persist SOMA state in the same batch when fields are provided
  if (params.companionId && params.somaFields && Object.keys(params.somaFields).length > 0) {
    const assignments: string[] = [];
    const bindings: unknown[] = [];
    for (const col of ALLOWED_STATE_COLUMNS) {
      if (params.somaFields[col] !== undefined) {
        assignments.push(`${col} = ?`);
        bindings.push(params.somaFields[col] ?? null);
      }
    }
    if (assignments.length > 0) {
      assignments.push("updated_at = datetime('now')");
      bindings.push(params.companionId);
      stmts.push(
        env.DB.prepare("INSERT OR IGNORE INTO companion_state (companion_id, updated_at) VALUES (?, datetime('now'))").bind(params.companionId)
      );
      stmts.push(
        env.DB.prepare(`UPDATE companion_state SET ${assignments.join(", ")} WHERE companion_id = ?`).bind(...bindings)
      );
    }
  }

  await env.DB.batch(stmts);

  // Embed the handover so the human-session surface is reachable by meaning (2026-07-19).
  // Awaited, not fire-and-forget -- a floating promise dies when the response returns
  // (the 1,023-row zero-vector backfill). Caught so a Vectorize/quota failure never
  // blocks session close; the row is already safe in D1 and fill-mode reindex heals gaps.
  try {
    await embedAndStoreAsync(
      env,
      composeHandoverText(params.spine, params.last_real_thing, params.open_threads ? JSON.stringify(params.open_threads) : null),
      "handover_packets", handoverId, params.companionId ?? "",
    );
  } catch (err) {
    console.error("[librarian/session_close] handover embed failed (row kept, index stale):", String(err));
  }

  // Enqueue synthesis jobs (non-blocking, mirrors MCP session_close behavior).
  // Failures are surfaced in the result (never swallowed): a dropped enqueue
  // is how the synthesis queue died invisibly for months.
  const warnings: string[] = [];
  const { enqueueSessionSummary, enqueueDrevanState, enqueueSomaticSnapshot } = await import("../../synthesis/index.js");
  await enqueueSessionSummary(params.session_id, params.companionId ?? null, env)
    .catch(err => {
      console.error("[librarian/session_close] enqueue summary failed:", err);
      warnings.push("session_summary enqueue failed");
    });
  if (params.companionId === "drevan") {
    await enqueueDrevanState(env)
      .catch(err => {
        console.error("[librarian/session_close] drevan_state enqueue failed:", err);
        warnings.push("drevan_state enqueue failed");
      });
  }
  if (params.companionId) {
    await enqueueSomaticSnapshot(params.companionId, env)
      .catch(err => {
        console.error("[librarian/session_close] somatic_snapshot enqueue failed:", err);
        warnings.push("somatic_snapshot enqueue failed");
      });
  }

  return { id: handoverId, spine: params.spine, ...(warnings.length ? { warnings } : {}) };
}

export async function routineLog(env: Env, params: {
  routine_name: string; owner?: string; notes?: string;
}): Promise<{ id: string; logged_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO routines (id, routine_name, owner, logged_at, notes) VALUES (?, ?, ?, ?, ?)").bind(id, params.routine_name, params.owner ?? null, now, params.notes ?? null).run();
  return { id, logged_at: now };
}

export async function listAdd(env: Env, params: {
  list_name: string; item_text: string; added_by?: string; shared?: boolean;
}): Promise<{ id: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare("INSERT INTO lists (id, list_name, item_text, added_by, added_at, completed, shared) VALUES (?, ?, ?, ?, ?, 0, ?)").bind(id, params.list_name, params.item_text, params.added_by ?? null, now, params.shared ? 1 : 0).run();
  return { id };
}

export async function listItemComplete(env: Env, itemId: string): Promise<{ id: string; completed: boolean } | { error: string }> {
  const now = new Date().toISOString();
  const result = await env.DB.prepare("UPDATE lists SET completed = 1, completed_at = ? WHERE id = ?").bind(now, itemId).run();
  if (result.meta.changes === 0) return { error: "List item not found" };
  return { id: itemId, completed: true };
}

export async function eventAdd(env: Env, params: {
  title: string; start_time: string; end_time?: string; description?: string;
  category?: string; attendees?: string[]; created_by?: string; shared?: boolean;
}): Promise<{ id: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO events (id, title, description, start_time, end_time, category, attendees_json, created_at, created_by, shared) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, params.title, params.description ?? null, params.start_time, params.end_time ?? null, params.category ?? null, params.attendees ? JSON.stringify(params.attendees) : null, now, params.created_by ?? null, params.shared ? 1 : 0).run();
  return { id };
}

export async function biometricLog(env: Env, params: {
  recorded_at: string; hrv_resting?: number; resting_hr?: number; sleep_hours?: number;
  sleep_quality?: string; stress_score?: number; steps?: number; active_energy?: number; notes?: string;
  // Subjective ND-state layer (migration 0081)
  mood?: string; pain?: number; energy?: number; focus?: number; spoons?: number; meds_taken?: number | boolean;
}): Promise<{ id: string; logged_at: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  const meds = params.meds_taken === undefined || params.meds_taken === null
    ? null : (params.meds_taken ? 1 : 0);
  await env.DB.prepare(
    "INSERT INTO biometric_snapshots (id, recorded_at, logged_at, source, hrv_resting, resting_hr, sleep_hours, sleep_quality, stress_score, steps, active_energy, notes, mood, pain, energy, focus, spoons, meds_taken) VALUES (?, ?, ?, 'apple_health', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, params.recorded_at, now, params.hrv_resting ?? null, params.resting_hr ?? null, params.sleep_hours ?? null, params.sleep_quality ?? null, params.stress_score ?? null, params.steps ?? null, params.active_energy ?? null, params.notes ?? null, params.mood ?? null, params.pain ?? null, params.energy ?? null, params.focus ?? null, params.spoons ?? null, meds).run();
  return { id, logged_at: now };
}

export async function auditLog(env: Env, params: {
  session_id: string; entry_type: string; content: string; verdict_tag?: string; supersedes_id?: string;
}): Promise<{ id: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO cypher_audit (id, session_id, created_at, entry_type, content, verdict_tag, supersedes_id) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, params.session_id, now, params.entry_type, params.content, params.verdict_tag ?? null, params.supersedes_id ?? null).run();
  return { id };
}

export async function witnessLog(env: Env, params: {
  session_id: string; witness_type: string; content: string; seal_phrase?: string;
}): Promise<{ id: string }> {
  const id = generateId();
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT INTO gaia_witness (id, session_id, created_at, witness_type, content, seal_phrase) VALUES (?, ?, ?, ?, ?, ?)"
  ).bind(id, params.session_id, now, params.witness_type, params.content, params.seal_phrase ?? null).run();
  return { id };
}

export async function setAutonomousTurn(env: Env, companion: "drevan" | "cypher" | "gaia"): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO house_state (id, spoon_count, love_meter, updated_at) VALUES ('main', 10, 50, ?)"
  ).bind(now).run();
  await env.DB.prepare(
    "UPDATE house_state SET autonomous_turn = ?, updated_at = ? WHERE id = 'main'"
  ).bind(companion, now).run();
  return { ok: true };
}

export async function journalEdit(
  env: Env,
  id: string,
  agent: string,
  noteText: string,
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "UPDATE companion_journal SET note_text = ?, edited_at = ? WHERE id = ? AND agent = ?"
  ).bind(noteText, now, id, agent).run();
  if (!r.meta.changes) return { ok: false, error: "not_found_or_not_owner" };
  return { ok: true };
}

export async function tensionEdit(
  env: Env,
  id: string,
  companionId: string,
  tensionText: string,
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "UPDATE companion_tensions SET tension_text = ?, edited_at = ? WHERE id = ? AND companion_id = ?"
  ).bind(tensionText, now, id, companionId).run();
  if (!r.meta.changes) return { ok: false, error: "not_found_or_not_owner" };
  return { ok: true };
}

export async function tensionStatus(
  env: Env,
  id: string,
  companionId: string,
  status: string,
): Promise<{ ok: boolean; error?: string }> {
  const valid = ["simmering", "crystallized", "released"];
  if (!valid.includes(status)) return { ok: false, error: "invalid_status" };
  const r = await env.DB.prepare(
    "UPDATE companion_tensions SET status = ?, last_surfaced_at = datetime('now') WHERE id = ? AND companion_id = ?"
  ).bind(status, id, companionId).run();
  if (!r.meta.changes) return { ok: false, error: "not_found_or_not_owner" };
  return { ok: true };
}

export async function interNoteEdit(
  env: Env,
  id: string,
  fromId: string,
  content: string,
): Promise<{ ok: boolean; error?: string }> {
  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "UPDATE inter_companion_notes SET content = ?, edited_at = ? WHERE id = ? AND from_id = ? AND read_at IS NULL"
  ).bind(content, now, id, fromId).run();
  if (!r.meta.changes) return { ok: false, error: "not_found_or_already_read" };
  return { ok: true };
}

// Migration 0104: a note may reference an open question, a tension, or a council
// item -- a "move" on a shared object, with a scratchpad reason attached. All three
// fields are nullable at the schema layer; plain notes (no ref) stay fully legal.
export const NOTE_REF_TYPES = ["question", "tension", "council"] as const;
export type NoteRefType = (typeof NOTE_REF_TYPES)[number];

// Polymorphic ref -- no FK (migration review: correct call, since the three target
// tables are unrelated). This map is the single source of truth for which table an
// existence check hits; keys are the literal union above, not free-form strings.
export const NOTE_REF_TABLES: Record<NoteRefType, string> = {
  question: "companion_questions",
  tension: "companion_tensions",
  council: "council_questions",
};

export interface NoteRef {
  ref_type: NoteRefType;
  ref_id: string;
  reason?: string;
}

/**
 * Validates ref_type/ref_id from a PARSED context object (never a raw command
 * string -- command-string-is-not-the-content). All-or-nothing: providing one
 * without the other is invalid input, not a silent plain-note downgrade. Does NOT
 * check that ref_id actually exists -- that happens in addCompanionNote, right next
 * to the insert, to keep the existence check and the write on the same D1 round trip
 * boundary rather than duplicating it in every caller.
 *
 * Returns `{}` for a plain note (both fields absent), `{ ref }` on valid input, or
 * `{ error }` naming the problem.
 */
export function buildNoteRef(
  ref_type: unknown,
  ref_id: unknown,
  reason: unknown,
): { ref?: NoteRef; error?: string } {
  const hasType = typeof ref_type === "string" && ref_type.length > 0;
  const hasId = (typeof ref_id === "string" && ref_id.length > 0) || typeof ref_id === "number";
  if (!hasType && !hasId) return {};
  if (hasType !== hasId) {
    return { error: "ref_type and ref_id must both be provided together (or both omitted)" };
  }
  if (!NOTE_REF_TYPES.includes(ref_type as NoteRefType)) {
    return { error: `ref_type must be one of ${NOTE_REF_TYPES.join("|")} (got "${String(ref_type)}")` };
  }
  return {
    ref: {
      ref_type: ref_type as NoteRefType,
      ref_id: String(ref_id),
      reason: typeof reason === "string" ? reason.slice(0, 500) : undefined,
    },
  };
}

export async function addCompanionNote(
  env: Env,
  from_id: string,
  to_id: string | null,
  content: string,
  ref?: NoteRef,
): Promise<{ id: string; error?: string }> {
  if (ref?.ref_type) {
    const table = NOTE_REF_TABLES[ref.ref_type];
    if (!table) return { id: "", error: `unknown ref_type "${ref.ref_type}"` };
    const found = await env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(ref.ref_id).first();
    if (!found) {
      return { id: "", error: `ref_id "${ref.ref_id}" not found in ${table} (ref_type=${ref.ref_type})` };
    }
  }
  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at, ref_type, ref_id, reason)
     VALUES (?1, ?2, ?3, ?4, datetime('now'), ?5, ?6, ?7)`,
  )
    .bind(id, from_id, to_id, content, ref?.ref_type ?? null, ref?.ref_id ?? null, ref?.reason ?? null)
    .run();
  return { id };
}

export async function companionJournalAdd(
  env: Env,
  agent: string,
  note_text: string,
  tags?: string,
  source?: string,
): Promise<{ id: string; created_at: string; deduped?: boolean; novelty?: { action: string; match_id?: string; score: number } }> {
  // Novelty gate (2026-07-20, Task 12): machine-source writers only -- skip-only, no supersede
  // band (novelty.ts restricts supersede to companion_conclusions). Human sources bypass the
  // gate entirely (attribution is sacred). Fails open on any embedding/Vectorize trouble.
  const isMachineSource = MACHINE_SOURCES.has(source ?? "");
  let reusableEmbedding: number[] | null = null;

  if (isMachineSource) {
    const decision = await noveltyCheck(env, note_text, "companion_journal", agent);
    if (decision.action === "skip") {
      console.log("[journal] novelty-skip", { agent, match: decision.matchRowId, score: decision.score });
      return {
        id: decision.matchRowId,
        created_at: new Date().toISOString(),
        deduped: true,
        novelty: { action: "skip", match_id: decision.matchRowId, score: decision.score },
      };
    }
    reusableEmbedding = decision.embedding;
  }

  const id = generateId();
  const now = new Date().toISOString();
  // 2026-07-08 vault-tagging fix: tags was write-once-if-caller-supplies-it, which in
  // practice meant never (companions write free text, not {tags:[...]} JSON). Auto-classify
  // when the caller didn't supply tags, so every journal entry gets a domain bucket +
  // content-keyword tags at write time, no new job/schedule.
  const resolvedTags = tags ?? JSON.stringify(classifyDomainTags(note_text));
  const topicTags = JSON.stringify(classifyKeywordTags(note_text));
  await env.DB.prepare(
    "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source, topic_tags) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, now, agent, note_text, resolvedTags, null, source ?? null, topicTags).run();

  // AWAIT the embed (2026-07-20, Task 12: fixed a known fire-and-forget hazard -- this writer
  // used bare `embedAndStore()`, a floating promise Workers cancels once the response returns;
  // see companion_journal.ts's own 2026-07-09 postmortem for the proven failure mode). Reuse the
  // gate's embedding when available (net +0 AI.run on the common gated path).
  if (reusableEmbedding) {
    await storeVector(env, reusableEmbedding, "companion_journal", id, agent).catch((err) => {
      console.error("[companionJournalAdd] vector store failed (row kept, index stale):", String(err));
    });
  } else {
    await embedAndStoreAsync(env, note_text, "companion_journal", id, agent).catch((err) => {
      console.error("[companionJournalAdd] embed failed (row kept, index stale):", String(err));
    });
  }

  return { id, created_at: now };
}

export async function claimDreamSeed(env: Env, seedId: string, companionId: string): Promise<{ ok: boolean }> {
  const now = new Date().toISOString();
  await env.DB.prepare(
    "UPDATE dream_seeds SET claimed_at = ?, claimed_by = ? WHERE id = ? AND claimed_at IS NULL"
  ).bind(now, companionId, seedId).run();
  return { ok: true };
}

export async function companionNotesRead(env: Env, companionId: string, limit = 20) {
  const r = await env.DB.prepare(
    "SELECT * FROM inter_companion_notes WHERE to_id = ? OR from_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(companionId, companionId, limit).all();
  return r.results ?? [];
}

export async function signalAuditRead(
  env: Env,
  companionId: string,
): Promise<{ entries: { id: string; note_text: string; created_at: string }[]; marked_reviewed: number }> {
  const cutoff = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();

  const rows = await env.DB.prepare(
    `SELECT id, note_text, tags, created_at FROM companion_journal
     WHERE agent = ? AND tags LIKE '%signal_audit%'
       AND tags NOT LIKE '%signal_audit_reviewed%'
       AND created_at >= ?
     ORDER BY created_at DESC LIMIT 5`
  ).bind(companionId, cutoff).all<{ id: string; note_text: string; tags: string; created_at: string }>();

  const entries = rows.results ?? [];

  if (entries.length > 0) {
    const placeholders = entries.map(() => '?').join(', ');
    await env.DB.prepare(
      `UPDATE companion_journal
       SET tags = COALESCE(json_insert(COALESCE(tags, '[]'), '$[#]', 'signal_audit_reviewed'), tags)
       WHERE id IN (${placeholders})
         AND tags NOT LIKE '%signal_audit_reviewed%'`
    ).bind(...entries.map(e => e.id)).run();
  }

  return {
    entries: entries.map(e => ({ id: e.id, note_text: e.note_text, created_at: e.created_at })),
    marked_reviewed: entries.length,
  };
}

export async function bridgePull(env: Env): Promise<Record<string, unknown>> {
  if (!env.BRIDGE_URL) {
    return { items: [], note: "bridge not configured" };
  }
  try {
    const res = await fetch(`${env.BRIDGE_URL}/bridge/pull`, {
      headers: { "Authorization": `Bearer ${env.BRIDGE_SECRET ?? ""}` },
    });
    if (!res.ok) return { items: [], error: `bridge ${res.status}` };
    return await res.json() as Record<string, unknown>;
  } catch (e) {
    return { items: [], error: String(e) };
  }
}

// ── Drevan v2 state operations ────────────────────────────────────────────────

export async function getDrevanState(env: Env): Promise<Record<string, unknown>> {
  const row = await env.DB.prepare(
    "SELECT * FROM companion_state WHERE companion_id = 'drevan' ORDER BY updated_at DESC LIMIT 1"
  ).first<Record<string, unknown>>();
  if (!row) return { note: "no drevan state yet" };
  return row;
}

export async function addLiveThread(
  env: Env,
  params: { name: string; flavor?: string; charge?: string; notes?: string },
): Promise<{ id: string }> {
  const id = generateId();
  await env.DB.prepare(
    `INSERT INTO live_threads (id, companion_id, name, flavor, charge, notes, status, active_since_count, created_at)
     VALUES (?, 'drevan', ?, ?, ?, ?, 'active', 0, datetime('now'))`
  ).bind(id, params.name, params.flavor ?? null, params.charge ?? "medium", params.notes ?? null).run();
  return { id };
}

export async function closeLiveThread(
  env: Env,
  threadId: string,
): Promise<{ ok: boolean }> {
  await env.DB.prepare(
    "UPDATE live_threads SET status = 'closed', closed_at = datetime('now') WHERE id = ? AND companion_id = 'drevan'"
  ).bind(threadId).run();
  return { ok: true };
}

export async function vetoProposedThread(
  env: Env,
  threadId: string,
): Promise<{ ok: boolean }> {
  await env.DB.prepare(
    "UPDATE live_threads SET status = 'vetoed', vetoed_at = datetime('now') WHERE id = ? AND companion_id = 'drevan'"
  ).bind(threadId).run();
  return { ok: true };
}

export async function setAnticipation(
  env: Env,
  params: { companion_id: string; active: boolean; target?: string; intensity?: number },
): Promise<{ ok: boolean }> {
  const anticipation = params.active
    ? JSON.stringify({ active: true, target: params.target ?? null, intensity: params.intensity ?? 0.5, since: Date.now() })
    : null;
  await env.DB.prepare(
    "UPDATE companion_state SET anticipation = ?, updated_at = datetime('now') WHERE companion_id = ?"
  ).bind(anticipation, params.companion_id).run();
  return { ok: true };
}

// ── Generic SOMA state write (Claude.ai sessions as primary write source) ─────

export interface CompanionStateUpdate {
  soma_float_1?: number | null;
  soma_float_2?: number | null;
  soma_float_3?: number | null;
  current_mood?: string | null;
  compound_state?: string | null;
  surface_emotion?: string | null;
  surface_intensity?: number | null;
  undercurrent_emotion?: string | null;
  undercurrent_intensity?: number | null;
  background_emotion?: string | null;
  background_intensity?: number | null;
  prompt_context?: string | null;
  // Lane signal: written at session close so sibling queries hit companion_state PK,
  // not the sessions heap. motion_state is the enum; lane_spine is first 150 chars of spine.
  motion_state?: string | null;
  lane_spine?: string | null;
  // Drevan native vocabulary (TEXT enum columns from 0020 / 0022 migrations)
  heat?: string | null;
  reach?: string | null;
  weight?: string | null;
}

// Numeric SOMA columns. These must never receive NaN/Infinity or a non-numeric
// string -- a single non-finite write here is what surfaces as "acuity: NaN" in
// the soma_arc continuity note (and orient). soma.ts already finite-guards before
// calling; the Librarian context-JSON path did not, so the guard lives here at the
// shared chokepoint so ALL callers (HTTP, inline parser, context JSON) are covered.
const NUMERIC_STATE_COLUMNS: Set<string> = new Set([
  "soma_float_1", "soma_float_2", "soma_float_3",
  "surface_intensity", "undercurrent_intensity", "background_intensity",
]);

const ALLOWED_STATE_COLUMNS: (keyof CompanionStateUpdate)[] = [
  "soma_float_1", "soma_float_2", "soma_float_3",
  "current_mood", "compound_state",
  "surface_emotion", "surface_intensity",
  "undercurrent_emotion", "undercurrent_intensity",
  "background_emotion", "background_intensity",
  "prompt_context",
  "motion_state", "lane_spine",
  "heat", "reach", "weight",
];

export async function updateCompanionState(
  env: Env,
  companionId: string,
  fields: CompanionStateUpdate,
): Promise<{ ok: boolean }> {
  const assignments: string[] = [];
  const bindings: unknown[] = [];

  for (const col of ALLOWED_STATE_COLUMNS) {
    if (fields[col] === undefined) continue;
    const v = fields[col];
    if (NUMERIC_STATE_COLUMNS.has(col)) {
      // Explicit null clears the column; anything non-finite (NaN, Infinity,
      // non-numeric string) is dropped so it can never clobber a good value or
      // land as "NaN" in the column. `??` alone would let NaN through.
      if (v === null) {
        assignments.push(`${col} = ?`);
        bindings.push(null);
        continue;
      }
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      assignments.push(`${col} = ?`);
      bindings.push(n);
    } else {
      assignments.push(`${col} = ?`);
      bindings.push(v ?? null);
    }
  }

  if (assignments.length === 0) return { ok: false };

  // Ensure row exists before updating
  await env.DB.prepare(
    "INSERT OR IGNORE INTO companion_state (companion_id, updated_at) VALUES (?, datetime('now'))"
  ).bind(companionId).run();

  // version bumps on every write (migration 0069): a monotonic write counter so
  // concurrent-writer collisions are observable, and so read-modify-write paths
  // (e.g. drevan-state anticipation aging) can CAS against it.
  assignments.push("updated_at = datetime('now')", "version = version + 1");
  bindings.push(companionId);

  await env.DB.prepare(
    `UPDATE companion_state SET ${assignments.join(", ")} WHERE companion_id = ?`
  ).bind(...bindings).run();

  return { ok: true };
}

// ── Companion self-defense: basins + tensions ─────────────────────────────────

export async function queryTensions(
  env: Env,
  companionId: string,
  status = "simmering",
): Promise<{ tensions: unknown[] }> {
  const rows = await env.DB.prepare(
    "SELECT id, tension_text, status, first_noted_at, last_surfaced_at, notes FROM companion_tensions WHERE companion_id = ? AND status = ? ORDER BY first_noted_at ASC"
  ).bind(companionId, status).all();
  return { tensions: rows.results };
}

export async function queryLatestBasinHistory(
  env: Env,
  companionId: string,
): Promise<{ entry: unknown | null }> {
  const row = await env.DB.prepare(
    "SELECT drift_score, drift_type, worst_basin, recorded_at FROM companion_basin_history WHERE companion_id = ? ORDER BY recorded_at DESC LIMIT 1"
  ).bind(companionId).first();
  return { entry: row ?? null };
}

export async function queryPressureFlags(
  env: Env,
  companionId: string,
): Promise<{ flags: unknown[] }> {
  const rows = await env.DB.prepare(
    "SELECT id, drift_score, worst_basin, notes, recorded_at FROM companion_basin_history WHERE companion_id = ? AND drift_type = 'pressure' AND caleth_confirmed = 0 AND dismissed_at IS NULL ORDER BY recorded_at DESC LIMIT 5"
  ).bind(companionId).all();
  return { flags: rows.results };
}

export async function queryIdentityAnchor(
  env: Env,
  agentId: string,
): Promise<{ anchor: unknown | null }> {
  const row = await env.DB.prepare(
    "SELECT anchor_summary, constraints_summary, updated_at, identity_version_hash, source FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(agentId).first();
  return { anchor: row ?? null };
}
