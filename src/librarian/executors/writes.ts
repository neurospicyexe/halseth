import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { queueAndRunSpiral } from '../../webmind/spiral.js';
import type { WmSpiralInput, WmAgentId } from '../../webmind/types.js';
import {
  addCompanionNote, companionJournalAdd, feelingLog, journalAdd, dreamLog, woundAdd, deltaLog, eqSnapshot,
  taskAdd, taskUpdateStatus, taskList, handoverRead, routineLog, listAdd, listItemComplete,
  eventAdd, biometricLog, auditLog, witnessLog, setAutonomousTurn, claimDreamSeed,
  bridgePull, getDrevanState, addLiveThread, closeLiveThread, vetoProposedThread,
  setAnticipation, updateCompanionState, type CompanionStateUpdate,
  journalEdit, interNoteEdit,
} from "../backends/halseth.js";
import { buildResponse } from "../response/builder.js";
import { extractCompanionFromRequest } from "../lib/companion.js";
import type { ResponseKey } from "../response/budget.js";

export async function execCompanionNoteAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const toMatch = ctx.req.request.match(/(to|for)\s+(drevan|cypher|gaia)/i);
  const to_id = toMatch?.[2]?.toLowerCase() ?? null;

  // Parse context: companions may send raw text OR structured JSON.
  // noteText starts null -- falls back to request string only when no context is provided at all.
  // A metadata-only JSON object (no note_text/content) is rejected to prevent silent junk writes.
  let noteText: string | null = null;
  let tags: string | undefined;
  let source: string | undefined;
  if (ctx.req.context) {
    try {
      const parsed = JSON.parse(ctx.req.context);
      if (typeof parsed === "object" && parsed !== null) {
        if (parsed.note_text || parsed.content) {
          noteText = parsed.note_text ?? parsed.content;
        } else if (Object.keys(parsed).length > 0) {
          // Non-empty JSON object with no text field -- metadata payload, not note content.
          // Return an error rather than writing the request string as junk note content.
          return { error: "companion_note_add_failed", reason: `context JSON has no note_text or content field; found only: ${Object.keys(parsed).join(", ")}` };
        }
        if (Array.isArray(parsed.tags)) tags = JSON.stringify(parsed.tags);
        else if (typeof parsed.tags === "string") tags = parsed.tags;
        if (typeof parsed.source === "string") source = parsed.source;
      } else {
        noteText = ctx.req.context; // parsed primitive -- use raw string
      }
    } catch {
      // Not JSON -- use raw context string as note text
      noteText = ctx.req.context;
    }
  }

  // Fall back to request string only when no context was provided
  if (noteText === null) noteText = ctx.req.request;

  if (to_id) {
    // Addressed to another companion — inter_companion_notes
    const note = await addCompanionNote(ctx.env, ctx.req.companion_id, to_id, noteText);
    return { ack: true, id: note.id };
  }
  // Self-note or unaddressed — companion_journal (visible in Hearth)
  const r = await companionJournalAdd(ctx.env, ctx.req.companion_id, noteText, tags, source);
  return { ack: true, id: r.id };
}

export async function execFeelingLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ emotion: string; sub_emotion?: string; intensity?: number; source?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.emotion) return { response_key: "witness", witness: "feeling_log requires { emotion } in context" };
  const r = await feelingLog(ctx.env, { companion_id: ctx.req.companion_id, ...p });
  return { ack: true, id: r.id, logged_at: r.created_at };
}

export async function execJournalAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ entry_text: string; emotion_tag?: string; sub_emotion?: string; mood_score?: number; tags?: string }>(ctx.req.context);
  if (!p || !p.entry_text) return { response_key: "witness", witness: "journal_add requires { entry_text } in context" };
  const r = await journalAdd(ctx.env, p);
  return { ack: true, id: r.id, created_at: r.created_at };
}

export async function execDreamLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ dream_type: string; content: string; source_ids?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.dream_type || !p.content) return { response_key: "witness", witness: "dream_log requires { dream_type, content } in context" };
  const r = await dreamLog(ctx.env, { companion_id: ctx.req.companion_id, ...p });
  return { ack: true, id: r.id };
}

export async function execWoundAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ name: string; description: string; witness_type: string }>(ctx.req.context);
  if (!p || !p.name || !p.description || !p.witness_type) return { response_key: "witness", witness: "wound_add requires { name, description, witness_type } in context" };
  const r = await woundAdd(ctx.env, p);
  if ("error" in r) return { response_key: "witness", witness: r.error };
  return { ack: true, id: r.id };
}

export async function execDeltaLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ agent?: string; delta_text: string; valence: string; initiated_by?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.delta_text || !p.valence) return { response_key: "witness", witness: "delta_log requires { delta_text, valence } in context" };
  const agent = p.agent ?? ctx.req.companion_id;
  const r = await deltaLog(ctx.env, { ...p, agent });
  return { ack: true, id: r.id };
}

export async function execEqSnapshot(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await eqSnapshot(ctx.env, ctx.req.companion_id);
  return { ack: true, ...r };
}

export async function execTaskAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ title: string; description?: string; priority?: string; due_at?: string; assigned_to?: string; created_by?: string; shared?: boolean }>(ctx.req.context);
  if (!p || !p.title) return { response_key: "witness", witness: "task_add requires { title } in context" };
  const r = await taskAdd(ctx.env, p);
  return { ack: true, id: r.id, title: r.title, status: r.status };
}

export async function execTaskUpdateStatus(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string; status: string }>(ctx.req.context);
  if (!p || !p.id || !p.status) return { response_key: "witness", witness: "task_update_status requires { id, status } in context" };
  const r = await taskUpdateStatus(ctx.env, p.id, p.status);
  if ("error" in r) return { response_key: "witness", witness: r.error };
  return { ack: true, id: r.id, status: r.status };
}

export async function execTaskList(ctx: ExecutorContext): Promise<ExecutorResult> {
  // Infer status filter from the request string so "in-progress tasks" returns the right set
  const req = ctx.req.request.toLowerCase();
  let statusFilter: string | null = null;
  if (/in.progress/.test(req)) statusFilter = "in_progress";
  else if (/done|completed|finished/.test(req)) statusFilter = "done";

  const tasks = await taskList(ctx.env, ctx.req.companion_id, statusFilter ?? undefined);
  const label = statusFilter === "in_progress" ? "in-progress" : statusFilter === "done" ? "done" : "open";
  const summary = tasks.length === 0
    ? `No ${label} tasks.`
    : tasks.map((t: unknown) => {
        const task = t as { title: string; priority: string; status: string };
        return `[${task.priority}] ${task.title} (${task.status})`;
      }).join("\n");
  return buildResponse(ctx.req.companion_id, ctx.entry.response_key as ResponseKey, { session_id: "" }, summary);
}

export async function execHandoverRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const handover = await handoverRead(ctx.env);
  return { data: handover ?? "No handover packet found.", meta: { operation: "halseth_handover_read" } };
}

export async function execRoutineLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ routine_name: string; owner?: string; notes?: string }>(ctx.req.context);
  if (!p || !p.routine_name) return { response_key: "witness", witness: "routine_log requires { routine_name } in context" };
  const r = await routineLog(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execListAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ list_name: string; item_text: string; added_by?: string; shared?: boolean }>(ctx.req.context);
  if (!p || !p.list_name || !p.item_text) return { response_key: "witness", witness: "list_add requires { list_name, item_text } in context" };
  const r = await listAdd(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execListItemComplete(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p || !p.id) return { response_key: "witness", witness: "list_item_complete requires { id } in context" };
  const r = await listItemComplete(ctx.env, p.id);
  if ("error" in r) return { response_key: "witness", witness: r.error };
  return { ack: true, id: r.id, completed: true };
}

export async function execEventAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ title: string; start_time: string; end_time?: string; description?: string; category?: string; attendees?: string[]; created_by?: string; shared?: boolean }>(ctx.req.context);
  if (!p || !p.title || !p.start_time) return { response_key: "witness", witness: "event_add requires { title, start_time } in context" };
  const r = await eventAdd(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execBiometricLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ recorded_at: string; hrv_resting?: number; resting_hr?: number; sleep_hours?: number; sleep_quality?: string; stress_score?: number; steps?: number; active_energy?: number; notes?: string }>(ctx.req.context);
  if (!p || !p.recorded_at) return { response_key: "witness", witness: "biometric_log requires { recorded_at } in context" };
  const r = await biometricLog(ctx.env, p);
  return { ack: true, id: r.id, logged_at: r.logged_at };
}

export async function execAuditLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ session_id: string; entry_type: string; content: string; verdict_tag?: string; supersedes_id?: string }>(ctx.req.context);
  if (!p || !p.session_id || !p.entry_type || !p.content) return { response_key: "witness", witness: "audit_log requires { session_id, entry_type, content } in context" };
  const r = await auditLog(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execWitnessLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    session_id?: string;
    witness_type?: string; content?: string;
    entry?: string;        // Brain alias for content
    channel?: string;      // Brain alias for witness_type
    seal_phrase?: string;
  }>(ctx.req.context);
  if (!p) return { response_key: "witness", witness: "witness_log requires context" };

  const content = (p.content ?? p.entry)?.trim();
  const witness_type = (p.witness_type ?? p.channel ?? "observation").trim();
  if (!content) return { response_key: "witness", witness: "witness_log requires { content } (or { entry }) in context" };

  let session_id = p.session_id;
  if (!session_id) {
    const sess = await ctx.env.DB.prepare(
      "SELECT id FROM sessions WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1"
    ).bind(ctx.req.companion_id).first<{ id: string }>();
    session_id = sess?.id;
  }
  if (!session_id) return { response_key: "witness", witness: "witness_log: no session_id provided and no session found for companion" };

  const r = await witnessLog(ctx.env, { session_id, witness_type, content, seal_phrase: p.seal_phrase });
  return { ack: true, id: r.id };
}

export async function execSetAutonomousTurn(ctx: ExecutorContext): Promise<ExecutorResult> {
  const ORDER = ["drevan", "cypher", "gaia"] as const;
  type Turn = typeof ORDER[number];
  let companion: Turn | null;
  if (/next\s+companion|advance\s+turn|pass\s+turn|next\s+after/i.test(ctx.req.request)) {
    // Rotate from current companion -- prevents "next companion after drevan" from matching
    // "drevan" and leaving the turn unchanged.
    const idx = ORDER.indexOf(ctx.req.companion_id as Turn);
    const nextIdx = (idx === -1 ? 1 : (idx + 1) % ORDER.length) as 0 | 1 | 2;
    companion = ORDER[nextIdx];
  } else {
    companion = extractCompanionFromRequest(ctx.req.request);
  }
  if (!companion) return { response_key: "witness", witness: "set_autonomous_turn: include a companion name or 'next companion' in request" };
  await setAutonomousTurn(ctx.env, companion);
  return { ack: true, id: "house_state", autonomous_turn: companion };
}

export async function execClaimDreamSeed(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "claim_dream_seed requires { id } in context" };
  const r = await claimDreamSeed(ctx.env, p.id, ctx.req.companion_id);
  return { ack: r.ok, seed_id: p.id, claimed_by: ctx.req.companion_id };
}

export async function execBridgePull(ctx: ExecutorContext): Promise<ExecutorResult> {
  const data = await bridgePull(ctx.env);
  return { data };
}

export async function execDrevanStateGet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const data = await getDrevanState(ctx.env);
  return { data };
}

export async function execLiveThreadAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ name: string; flavor?: string; charge?: string; notes?: string }>(ctx.req.context);
  if (!p?.name) return { response_key: "witness", witness: "live_thread_add requires { name } in context" };
  const r = await addLiveThread(ctx.env, p);
  return { ack: true, id: r.id };
}

export async function execLiveThreadClose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "live_thread_close requires { id } in context" };
  const r = await closeLiveThread(ctx.env, p.id);
  return { ack: r.ok, id: p.id };
}

export async function execLiveThreadVeto(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "live_thread_veto requires { id } in context" };
  const r = await vetoProposedThread(ctx.env, p.id);
  return { ack: r.ok, id: p.id };
}

export async function execAnticipationSet(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ active: boolean; target?: string; intensity?: number }>(ctx.req.context);
  if (p === null || typeof p.active !== "boolean") return { response_key: "witness", witness: "anticipation_set requires { active: boolean, target?, intensity? } in context" };
  const r = await setAnticipation(ctx.env, p);
  return { ack: r.ok };
}

// Companion vocabulary → DB column name translation.
// Companions write in their own SOMA dialect; DB stores canonical soma_float_*.
const SOMA_VOCAB: Record<string, keyof CompanionStateUpdate> = {
  // Cypher
  acuity:    "soma_float_1",
  presence:  "soma_float_2",
  warmth:    "soma_float_3",
  // Gaia
  stillness: "soma_float_1",
  density:   "soma_float_2",
  perimeter: "soma_float_3",
  // Drevan native vocabulary (TEXT enum columns)
  heat:      "heat",
  reach:     "reach",
  weight:    "weight",
};

function parseInlineStateFields(request: string): Record<string, unknown> | null {
  const text = request
    .replace(/^(update\s+my\s+state|set\s+my\s+state|state\s+update|update\s+soma|soma\s+update|set)\s*/i, "")
    .replace(/\s+to\s+/gi, " ");
  const knownKeys = ['acuity','presence','warmth','stillness','density','perimeter','heat','reach','weight','mood','compound_state','surface_emotion'];
  const re = new RegExp(`(${knownKeys.join('|')})\\s*[:=]?\\s*([\\w][\\w\\-]*)`, 'gi');
  const result: Record<string, unknown> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1]; const val = m[2];
    if (key && val) result[key.toLowerCase()] = val;
  }
  return Object.keys(result).length > 0 ? result : null;
}

export async function execStateUpdate(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rawCtx = parseContext<Record<string, unknown>>(ctx.req.context);
  const raw: Record<string, unknown> | null =
    rawCtx && Object.keys(rawCtx).length > 0 ? rawCtx : parseInlineStateFields(ctx.req.request);
  if (!raw || Object.keys(raw).length === 0) return { error: "state_update_failed", reason: "no fields provided; pass at least one of: soma_float_1/acuity/stillness, current_mood, compound_state, surface_emotion, etc." };

  // Translate companion vocab to DB columns
  const translated: CompanionStateUpdate = {};
  for (const [k, v] of Object.entries(raw)) {
    const mapped = SOMA_VOCAB[k.toLowerCase()] ?? k as keyof CompanionStateUpdate;
    (translated as Record<string, unknown>)[mapped] = v;
  }

  const r = await updateCompanionState(ctx.env, ctx.req.companion_id, translated);
  if (!r.ok) return { error: "state_update_failed", reason: "no valid fields provided" };

  // Emotional inertia: write soma_arc note at SOMA inflection points (15-min gate)
  try {
    const lastArc = await ctx.env.DB.prepare(
      `SELECT created_at FROM wm_continuity_notes
       WHERE agent_id = ? AND note_type = 'soma_arc' AND archived = 0
       ORDER BY created_at DESC LIMIT 1`
    ).bind(ctx.req.companion_id).first<{ created_at: string }>();

    const shouldWrite = !lastArc ||
      (Date.now() - new Date(lastArc.created_at).getTime()) > 15 * 60 * 1000;

    if (shouldWrite) {
      // Per-companion SOMA axis labels
      const somaLabels: Record<string, [string, string, string]> = {
        cypher: ['acuity', 'presence', 'warmth'],
        drevan: ['heat', 'reach', 'weight'],
        gaia:   ['stillness', 'density', 'perimeter'],
      };
      const [l1, l2, l3] = somaLabels[ctx.req.companion_id] ?? ['float_1', 'float_2', 'float_3'];

      // Read the just-written SOMA values (branch by companion -- Drevan uses heat/reach/weight TEXT columns)
      let f1 = '0.00', f2 = '0.00', f3 = '0.00';
      let moodStr = '';

      if (ctx.req.companion_id === 'drevan') {
        // Drevan uses heat/reach/weight TEXT columns (migration 0022)
        const drevanState = await ctx.env.DB.prepare(
          `SELECT heat, reach, weight, emotional_register FROM companion_state WHERE companion_id = ?`
        ).bind(ctx.req.companion_id).first<{ heat: string | null; reach: string | null; weight: string | null; emotional_register: string | null }>();
        if (drevanState) {
          f1 = drevanState.heat ?? '—';
          f2 = drevanState.reach ?? '—';
          f3 = drevanState.weight ?? '—';
          moodStr = drevanState.emotional_register ? ` | ${drevanState.emotional_register}` : '';
        }
      } else {
        // Cypher and Gaia use soma_float_1/2/3 + current_mood
        const state = await ctx.env.DB.prepare(
          `SELECT soma_float_1, soma_float_2, soma_float_3, current_mood
           FROM companion_state WHERE companion_id = ?`
        ).bind(ctx.req.companion_id).first<{
          soma_float_1: number | null;
          soma_float_2: number | null;
          soma_float_3: number | null;
          current_mood: string | null;
        }>();
        if (state) {
          f1 = (state.soma_float_1 ?? 0).toFixed(2);
          f2 = (state.soma_float_2 ?? 0).toFixed(2);
          f3 = (state.soma_float_3 ?? 0).toFixed(2);
          moodStr = state.current_mood ? ` | ${state.current_mood}` : '';
        }
      }

      const content = `[SOMA shift] ${l1}: ${f1} / ${l2}: ${f2} / ${l3}: ${f3}${moodStr}`;

      const noteId = crypto.randomUUID();
      const now = new Date().toISOString();
      await ctx.env.DB.prepare(
        `INSERT INTO wm_continuity_notes
         (note_id, agent_id, thread_key, note_type, content, salience, actor, source, correlation_id, created_at)
         VALUES (?, ?, NULL, 'soma_arc', ?, 'high', ?, 'soma_update', NULL, ?)`
      ).bind(noteId, ctx.req.companion_id, content, ctx.req.companion_id, now).run();
    }
  } catch (err) {
    console.warn('[soma_arc] arc write failed (non-blocking):', err);
  }

  return { ack: true, updated: ctx.req.companion_id };
}

export async function execConclusionAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{
    conclusion_text?: string;
    supersedes?: string;
    source_sessions?: string[];
    confidence?: number;
    type?: string;
    subject?: string;
    provenance?: string;
    contradiction_flagged?: number; // 0|1 -- companion declares a contradiction signal
  }>(ctx.req.context);
  // Structured context wins; fall back to stripping trigger from natural language request
  const conclusionText = p?.conclusion_text?.trim() || ctx.req.request
    .replace(/^(?:i've\s+concluded|i\s+conclude|my\s+conclusion|thesis|i\s+believe|i\s+hold\s+that|i\s+assert|conclusion|i've\s+come\s+to\s+believe|i've\s+realized|what\s+i\s+know\s+now)\s*:?\s*/i, "")
    .trim();
  if (!conclusionText) return { error: "conclusion_add_failed", reason: "missing required field: conclusion_text" };
  if (conclusionText.length > 8000) return { error: "conclusion_add_failed", reason: "conclusion_text exceeds maximum length of 8000 characters" };
  const newId = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const sourceSessions = Array.isArray(p?.source_sessions) ? JSON.stringify(p.source_sessions) : null;
  const supersedes = p?.supersedes;
  // Worldview fields: companions write `type` in context; DB column is `belief_type`
  const confidence = (p?.confidence !== undefined && p.confidence >= 0 && p.confidence <= 1) ? p.confidence : 0.7;
  const beliefType = p?.type ?? "self";
  const VALID_BELIEF_TYPES = ['self', 'observational', 'relational', 'systemic'];
  if (!VALID_BELIEF_TYPES.includes(beliefType)) {
    return { ack: false, error: `belief_type must be one of: ${VALID_BELIEF_TYPES.join(', ')}` };
  }
  const subject = p?.subject ?? null;
  const provenance = p?.provenance ?? null;
  const contradictionFlagged = p?.contradiction_flagged === 1 ? 1 : 0;
  const stmts = [
    ctx.env.DB.prepare(
      "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, source_sessions, confidence, belief_type, subject, provenance, contradiction_flagged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(newId, ctx.req.companion_id, conclusionText, sourceSessions, confidence, beliefType, subject, provenance, contradictionFlagged, now),
  ];
  if (supersedes) {
    stmts.push(
      ctx.env.DB.prepare(
        "UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL"
      ).bind(newId, supersedes, ctx.req.companion_id)
    );
  }
  await ctx.env.DB.batch(stmts);
  return { ack: true, id: newId, created_at: now, superseded: !!supersedes };
}

export async function execJournalEdit(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string; note_text: string }>(ctx.req.context);
  if (!p?.id || !p?.note_text) return { response_key: "witness", witness: "journal_edit requires { id, note_text } in context" };
  const r = await journalEdit(ctx.env, p.id, ctx.req.companion_id, p.note_text);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "journal_edit failed" };
  return { ack: true, id: p.id };
}

export async function execInterNoteEdit(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id: string; content: string }>(ctx.req.context);
  if (!p?.id || !p?.content) return { response_key: "witness", witness: "inter_note_edit requires { id, content } in context" };
  const r = await interNoteEdit(ctx.env, p.id, ctx.req.companion_id, p.content);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "inter_note_edit failed" };
  return { ack: true, id: p.id };
}

export async function execAutonomyClaim(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content: string; justification: string; seed_type?: string }>(ctx.req.context);
  if (!p?.content?.trim()) return { response_key: "witness", witness: "autonomy_claim requires { content, justification } in context" };
  if (!p?.justification?.trim()) return { response_key: "witness", witness: "autonomy_claim requires { justification } -- explain why this pulls harder than the queue" };
  const validTypes = ["topic", "question", "reflection_prompt"];
  const seedType = validTypes.includes(p.seed_type ?? "") ? p.seed_type! : "topic";
  const id = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  await ctx.env.DB.prepare(
    "INSERT INTO autonomy_seeds (id, companion_id, seed_type, content, priority, claim_source, justification, created_at) VALUES (?, ?, ?, ?, 10, ?, ?, ?)"
  ).bind(id, ctx.req.companion_id, seedType, p.content.trim().slice(0, 500), ctx.req.companion_id, p.justification.trim().slice(0, 300), now).run();
  return { ack: true, id, companion_id: ctx.req.companion_id, priority: 10, claim_source: ctx.req.companion_id };
}

export async function execConclusionsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await ctx.env.DB.prepare(
    "SELECT id, companion_id, conclusion_text, source_sessions, superseded_by, created_at, edited_at, confidence, belief_type, subject, provenance, contradiction_flagged FROM companion_conclusions WHERE companion_id = ? AND superseded_by IS NULL ORDER BY created_at DESC LIMIT 10"
  ).bind(ctx.req.companion_id).all();
  return { data: rows.results ?? [], meta: { operation: "conclusions_read" } };
}

export async function execSpiralRun(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ seed_text?: string; seed_type?: string; seed_ref_id?: string }>(ctx.req.context);

  // Prefer explicit seed_text from context; fall back to stripping the trigger phrase from the request
  const seed_text = (p?.seed_text?.trim()) || ctx.req.request
    .replace(/^(?:run\s+a?\s*spiral\s+on|start\s+a?\s*spiral\s+on|spiral\s+on|run\s+spiral|start\s+spiral|begin\s+spiral)\s*/i, '')
    .trim();

  if (!seed_text) return { error: 'spiral_run_failed', reason: 'missing seed_text -- include what to spiral on' };
  if (seed_text.length > 8000) return { error: 'spiral_run_failed', reason: 'seed_text too long (max 8000)' };

  const valid_seed_types = new Set(['tension', 'open_loop', 'belief_contradiction', 'free_text']);
  const seed_type = p?.seed_type && valid_seed_types.has(p.seed_type)
    ? p.seed_type as WmSpiralInput['seed_type']
    : 'free_text';

  try {
    const run = await queueAndRunSpiral(ctx.env, {
      companion_id: ctx.req.companion_id as WmAgentId,
      seed_text,
      seed_type,
      seed_ref_id: p?.seed_ref_id,
    });
    return {
      ack: true,
      spiral_id: run.id,
      status: run.status,
      phase_turn: run.phase_turn ?? null,
      phase_residue: run.phase_residue ?? null,
    };
  } catch (e) {
    return { error: 'spiral_run_failed', reason: String(e) };
  }
}
