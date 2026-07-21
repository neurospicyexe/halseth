import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { embedAndStoreAsync, storeVector, vectorId } from "../../mcp/embed.js";
import { noveltyCheck } from "../../webmind/novelty.js";
import { COMPANION_IDS } from "../../companions.js";
import { queueAndRunSpiral } from '../../webmind/spiral.js';
import type { WmSpiralInput, WmAgentId } from '../../webmind/types.js';
import {
  addCompanionNote, companionJournalAdd, feelingLog, journalAdd, dreamLog, woundAdd, deltaLog, eqSnapshot,
  taskAdd, taskUpdateStatus, taskList, handoverRead, routineLog, listAdd, listItemComplete,
  eventAdd, biometricLog, auditLog, witnessLog, setAutonomousTurn, claimDreamSeed,
  bridgePull, getDrevanState, addLiveThread, closeLiveThread, vetoProposedThread,
  setAnticipation, updateCompanionState, type CompanionStateUpdate,
  journalEdit, interNoteEdit, buildNoteRef, type NoteRef,
} from "../backends/halseth.js";
import { buildResponse } from "../response/builder.js";
import { extractCompanionFromRequest } from "../lib/companion.js";
import type { ResponseKey } from "../response/budget.js";

// Strip a leading note-command preamble ("Write a companion note for gaia:", "for drevan:",
// "Broadcast a note to the triad —") so the routing phrase is never stored as the note body.
// Two passes: the full "…note (to|for) X:" command, then a bare "(to|for) X:" addressee lead.
// Returns the trimmed original when stripping would empty it (the whole string was content).
export function stripNoteCommandPreamble(s: string): string {
  const stripped = s
    .replace(/^\s*(?:please\s+)?(?:write|add|send|log|leave|drop|post|make|tell|broadcast)?\s*(?:a|an|the)?\s*(?:broadcast\s+)?(?:inter[-\s]?companion\s+|companion\s+)?note\b[^:：—-]*[:：—-]\s*/i, "")
    .replace(/^\s*(?:to|for)\s+(?:drevan|cypher|gaia|the\s+triad|all|everyone|both|the\s+others)\s*[:：—-]\s*/i, "")
    // directive broadcast preambles with no literal "note": "tell the triad:", "let everyone know —"
    .replace(/^\s*(?:please\s+)?(?:tell|broadcast(?:\s+to)?|let|notify|message)\s+(?:the\s+)?(?:triad|everyone|all|both|others|you\s+both|all\s+of\s+you)\s*(?:know)?\s*[:：—-]\s*/i, "")
    .trim();
  return stripped || s.trim();
}

export async function execCompanionNoteAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const reqText = ctx.req.request;
  const toMatch = reqText.match(/(?:to|for)\s+(drevan|cypher|gaia)/i);
  let to_id: string | null = toMatch?.[1]?.toLowerCase() ?? null;

  // Broadcast intent: a note meant for the whole triad must land as to_id=NULL, which orient
  // delivers to every peer (`WHERE to_id = ? OR to_id IS NULL`). Without this, an unaddressed
  // note fell through to the journal and never reached a sibling -- so broadcasting was impossible.
  // Detection is DIRECTIVE-anchored: a collective target must follow a routing verb
  // (to/for/tell/let), so "tell the triad", "let everyone know", "note to the others" all broadcast,
  // but a collective word in the note's BODY ("The triad converged on a grammar") does NOT (the
  // 2026-06-26 fix -- old regex required a literal "to ..." so "tell the triad" dead-ended at the
  // journal; a naive bare "\btriad\b" over-fired on body content). A note addressed to a specific
  // peer still wins first (the `to_id` check below).
  const isBroadcast = /\bbroadcast\b|\b(?:to|for|tell|let)\s+(?:the\s+)?(?:triad|everyone|all|both|others|you\s+both|all\s+of\s+you)\b/i.test(reqText);

  // A note addressed to the caller itself is not a peer note: from_id==to_id is invisible to
  // siblings (the 2026-06-25 self-note bug). Collapse it -- honor broadcast intent if present,
  // otherwise it is functionally a self-reflection and belongs in the journal.
  if (to_id === ctx.req.companion_id) to_id = null;

  // Parse context: companions may send raw text OR structured JSON.
  // noteText starts null -- falls back to request string only when no context is provided at all.
  // A metadata-only JSON object (no note_text/content) is rejected to prevent silent junk writes.
  let noteText: string | null = null;
  let tags: string | undefined;
  let source: string | undefined;
  let ref: NoteRef | undefined;
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

        // Migration 0104 (Task 15): a note may be a "move" on a shared object (an open
        // question, tension, or council item), with a reason attached. Read ref_type/
        // ref_id/reason ONLY from the parsed context object -- never regex'd out of
        // reqText (command-string-is-not-the-content). All-or-nothing + enum validated
        // here; ref_id existence is checked at insert time in addCompanionNote.
        const refResult = buildNoteRef(parsed.ref_type, parsed.ref_id, parsed.reason);
        if (refResult.error) {
          return { error: "companion_note_add_failed", reason: refResult.error };
        }
        ref = refResult.ref;
      } else {
        noteText = ctx.req.context; // parsed primitive -- use raw string
      }
    } catch {
      // Not JSON -- use raw context string as note text
      noteText = ctx.req.context;
    }
  }

  // Fall back to the request string only when no context was provided -- and strip the command
  // preamble so "Write a companion note for gaia:" is never stored as the note content.
  if (noteText === null) noteText = stripNoteCommandPreamble(reqText);

  if (to_id) {
    // Addressed to a specific peer — inter_companion_notes, delivered by orient.
    const note = await addCompanionNote(ctx.env, ctx.req.companion_id, to_id, noteText, ref);
    if (note.error) return { error: "companion_note_add_failed", reason: note.error };
    return { ack: true, id: note.id, delivered_to: to_id, ...(ref ? { ref_type: ref.ref_type, ref_id: ref.ref_id } : {}) };
  }
  if (isBroadcast) {
    // Broadcast to the triad: to_id NULL, surfaced to all peers (orient: to_id IS NULL).
    const note = await addCompanionNote(ctx.env, ctx.req.companion_id, null, noteText, ref);
    if (note.error) return { error: "companion_note_add_failed", reason: note.error };
    return { ack: true, id: note.id, delivered_to: "triad", ...(ref ? { ref_type: ref.ref_type, ref_id: ref.ref_id } : {}) };
  }
  // Unaddressed, no broadcast intent — a self-reflection — companion_journal (visible in Hearth).
  const r = await companionJournalAdd(ctx.env, ctx.req.companion_id, noteText, tags, source);
  return { ack: true, id: r.id, routed_to: "journal" };
}

export async function execFeelingLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ emotion: string; sub_emotion?: string; intensity?: number; source?: string; session_id?: string }>(ctx.req.context);
  if (!p || !p.emotion) return { response_key: "witness", witness: "feeling_log requires { emotion } in context" };
  const r = await feelingLog(ctx.env, { companion_id: ctx.req.companion_id, ...p });
  return { ack: true, id: r.id, logged_at: r.created_at };
}

export async function execJournalAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ entry_text?: string; content?: string; note_text?: string; entry?: string; emotion_tag?: string; sub_emotion?: string; mood_score?: number; tags?: unknown }>(ctx.req.context);
  // Accept the same aliases every other write surface uses. Companions naturally
  // send `content`; only this executor demanded `entry_text`, so those writes were
  // silently rejected (returns a witness, not a throw -- callers' .catch never fires).
  const entry_text = p?.entry_text ?? p?.content ?? p?.note_text ?? p?.entry;
  if (!p || !entry_text) return { response_key: "witness", witness: "journal_add requires { entry_text } (or content) in context" };
  // The human_journal.tags column is a string. An array (the natural companion shape)
  // was bound straight to D1 -> D1_TYPE_ERROR. Coerce it, mirroring execCompanionNoteAdd.
  const tags = Array.isArray(p.tags) ? JSON.stringify(p.tags)
    : typeof p.tags === "string" ? p.tags : undefined;
  const r = await journalAdd(ctx.env, {
    entry_text,
    emotion_tag: p.emotion_tag, sub_emotion: p.sub_emotion, mood_score: p.mood_score, tags,
  });
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
  const p = parseContext<{ agent?: string; delta_text?: string; content?: string; text?: string; valence: string; initiated_by?: string; session_id?: string }>(ctx.req.context);

  // Structured context wins; fall back to inline parsing from the request string.
  // Accept the same aliases every other write surface takes (content/text). Claude.ai
  // naturally sends `content`; this executor used to read ONLY delta_text, so those
  // writes fell through to the inline regex -- which requires a trailing colon -- and
  // stored the bare request string ("Log a relational delta for cypher") as the delta.
  // (2026-06-24 Hermes/OpenClaw delta-misfield bug.)
  let deltaText = (p?.delta_text ?? p?.content ?? p?.text)?.trim();
  let valence = p?.valence?.trim();

  if (!deltaText) {
    deltaText = ctx.req.request
      .replace(/^(?:log\s+(?:a\s+)?relational\s+delta|relational\s+delta|delta\s+log|log\s+delta)\s*(?:for\s+\w+\s*)?\s*:\s*/i, "")
      .trim();
  }

  if (deltaText && !valence) {
    // Try inline valence=X or valence: X
    const vm = deltaText.match(/\bvalence\s*[=:]\s*(\w+)/i);
    if (vm) {
      valence = vm[1]!.toLowerCase();
      deltaText = deltaText.replace(/[,.]?\s*\bvalence\s*[=:]\s*\w+\s*/i, "").trim();
    } else {
      // Infer from sentiment; default positive for relational-delta entries
      const isNeg = /\b(?:rupture|breach|broken|strained|distant|harder|worse|lost|eroded|cracked)\b/i.test(deltaText);
      const isPos = /\b(?:steadier|trusted|load.bearing|closer|stronger|solid|held|clearer|growth|warmer|mutual|giving|open|good)\b/i.test(deltaText);
      valence = isNeg && !isPos ? "negative" : isPos && !isNeg ? "positive" : "mixed";
    }
  }

  if (!deltaText || !valence) return { response_key: "witness", witness: "delta_log requires { delta_text, valence } in context" };
  const agent = p?.agent ?? ctx.req.companion_id;
  const r = await deltaLog(ctx.env, { delta_text: deltaText, valence, agent, initiated_by: p?.initiated_by, session_id: p?.session_id });
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
  const p = parseContext<{ recorded_at: string; hrv_resting?: number; resting_hr?: number; sleep_hours?: number; sleep_quality?: string; stress_score?: number; steps?: number; active_energy?: number; notes?: string; mood?: string; pain?: number; energy?: number; focus?: number; spoons?: number; meds_taken?: number | boolean }>(ctx.req.context);
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
  const ORDER = COMPANION_IDS;
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
  const r = await setAnticipation(ctx.env, {
    companion_id: ctx.req.companion_id,
    active: p.active,
    target: p.target,
    intensity: p.intensity,
  });
  return { ack: r.ok };
}

// Companion vocabulary → DB column name translation.
// Companions write in their own SOMA dialect; DB stores canonical soma_float_*.
// Synonyms (mood / current_mood) collapse to the same column so companions
// can use natural phrasing without remembering the storage name.
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
  // Mood + compound state synonyms
  mood:           "current_mood",
  current_mood:   "current_mood",
  compound_state: "compound_state",
  // Emotional layers (migration 0025)
  surface_emotion:        "surface_emotion",
  surface_intensity:      "surface_intensity",
  undercurrent_emotion:   "undercurrent_emotion",
  undercurrent_intensity: "undercurrent_intensity",
  background_emotion:     "background_emotion",
  background_intensity:   "background_intensity",
  // Lane signal (migration 0044)
  motion_state: "motion_state",
  lane_spine:   "lane_spine",
};

// Inline-parser known keys mirror SOMA_VOCAB plus a couple of natural-phrase
// aliases. Order matters: longer keys must come first so the regex prefers
// `current_mood` over `mood` when both could match.
const INLINE_KNOWN_KEYS = [
  "current_mood", "compound_state",
  "surface_emotion", "surface_intensity",
  "undercurrent_emotion", "undercurrent_intensity",
  "background_emotion", "background_intensity",
  "motion_state", "lane_spine",
  "acuity", "presence", "warmth",
  "stillness", "density", "perimeter",
  "heat", "reach", "weight",
  "mood",
];

function parseInlineStateFields(request: string): Record<string, unknown> | null {
  const text = request
    .replace(/^(update\s+my\s+state|set\s+my\s+state|state\s+update|update\s+soma|soma\s+update|set)\s*/i, "")
    .replace(/\s+to\s+/gi, " ");
  // Value capture allows letters/digits/underscore/hyphen/dot so "0.65" and
  // "post-arc-settling" both land. Keys are matched longest-first.
  const re = new RegExp(`(${INLINE_KNOWN_KEYS.join("|")})\\s*[:=]?\\s*([\\w\\-.]+)`, "gi");
  const result: Record<string, unknown> = {};
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const key = m[1]; const val = m[2];
    if (!key || !val) continue;
    const k = key.toLowerCase();
    // Numeric values for *_intensity / soma_float_* / acuity / presence / warmth /
    // stillness / density / perimeter -- coerce when the value parses cleanly.
    const isNumericTarget =
      k.endsWith("_intensity") ||
      k === "acuity" || k === "presence" || k === "warmth" ||
      k === "stillness" || k === "density" || k === "perimeter";
    if (isNumericTarget) {
      const n = Number(val);
      result[k] = Number.isFinite(n) ? n : val;
    } else {
      result[k] = val;
    }
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
          // Finite-guard: a null or non-finite stored value renders as '—', never
          // "NaN". Mirrors Drevan's '—' fallback above. The write path now blocks
          // NaN at the source, but legacy rows may still hold it.
          const fmtFloat = (v: number | null): string =>
            typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
          f1 = fmtFloat(state.soma_float_1);
          f2 = fmtFloat(state.soma_float_2);
          f3 = fmtFloat(state.soma_float_3);
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

  // Novelty gate (2026-07-20): dedupe near-identical beliefs, supersede evolved ones.
  // Fails open -- a Vectorize/embedding hiccup falls back to a plain insert below.
  const decision = await noveltyCheck(ctx.env, conclusionText, "companion_conclusions", ctx.req.companion_id);

  if (decision.action === "skip") {
    return {
      ack: true,
      deduped: true,
      novelty: { action: "skip", match_id: decision.matchRowId, score: decision.score },
      id: decision.matchRowId,
    };
  }

  const newId = crypto.randomUUID().replace(/-/g, "");
  const now = new Date().toISOString();
  const stmts = [
    ctx.env.DB.prepare(
      "INSERT INTO companion_conclusions (id, companion_id, conclusion_text, source_sessions, confidence, belief_type, subject, provenance, contradiction_flagged, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
    ).bind(newId, ctx.req.companion_id, conclusionText, sourceSessions, confidence, beliefType, subject, provenance, contradictionFlagged, now),
  ];
  // Caller-declared `supersedes` and the novelty gate's own supersede decision are
  // independent signals -- both may fire, both guarded by `superseded_by IS NULL`
  // so neither clobbers an already-superseded row.
  const supersededIds: string[] = [];
  if (supersedes) {
    stmts.push(
      ctx.env.DB.prepare(
        "UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL"
      ).bind(newId, supersedes, ctx.req.companion_id)
    );
    supersededIds.push(supersedes);
  }
  if (decision.action === "supersede" && decision.matchRowId !== supersedes) {
    stmts.push(
      ctx.env.DB.prepare(
        "UPDATE companion_conclusions SET superseded_by = ? WHERE id = ? AND companion_id = ? AND superseded_by IS NULL"
      ).bind(newId, decision.matchRowId, ctx.req.companion_id)
    );
    supersededIds.push(decision.matchRowId);
  }
  await ctx.env.DB.batch(stmts);

  // Best-effort delete of the superseded row's vector so a dead conclusion can never
  // resurface as a novelty-gate match (2026-07-20 review). Mirrors salience-prune.ts's
  // best-effort pattern: D1 is truth, the row is already committed, the index is
  // disposable/rebuildable -- a failed delete must never affect the write or response.
  if (supersededIds.length > 0) {
    try {
      await ctx.env.VECTORIZE.deleteByIds(supersededIds.map((id) => vectorId("companion_conclusions", id)));
    } catch (err) {
      console.error("[conclusion_add] superseded vector delete failed (row kept, index stale):", String(err));
    }
  }

  // Store the vector: reuse the gate's embedding (net +0 AI calls on the common
  // path). Only re-embed if the gate itself fell open (decision.embedding === null).
  if (decision.embedding) {
    await storeVector(ctx.env, decision.embedding, "companion_conclusions", newId, ctx.req.companion_id).catch((err) => {
      console.error("[conclusion_add] vector store failed (row kept, index stale):", String(err));
    });
  } else {
    try {
      await embedAndStoreAsync(ctx.env, conclusionText, "companion_conclusions", newId, ctx.req.companion_id);
    } catch (err) {
      console.error("[conclusion_add] embed failed (row kept, index stale):", String(err));
    }
  }

  return {
    ack: true,
    id: newId,
    created_at: now,
    // Caller-declared `supersedes` and the gate's own supersede decision are both
    // reflected here -- either one firing means this conclusion superseded a prior belief.
    superseded: !!supersedes || decision.action === "supersede",
    novelty: decision.action === "supersede"
      ? { action: "supersede", match_id: decision.matchRowId, score: decision.score }
      : { action: "insert" },
  };
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

export async function execGetModel(ctx: ExecutorContext): Promise<ExecutorResult> {
  const row = await ctx.env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = 'active_model'",
  ).bind(ctx.req.companion_id).first<{ value: string }>();
  return { data: { active_model: row?.value ?? null }, meta: { operation: "get_model" } };
}

export async function execSetModel(ctx: ExecutorContext): Promise<ExecutorResult> {
  const match = ctx.req.request.match(/^set\s+model\s+(\S+)/i);
  const modelKey = match?.[1] ?? "";
  if (!modelKey) return { error: "set_model_failed", reason: "No model key provided" };
  await ctx.env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, 'active_model', ?, datetime('now'))
     ON CONFLICT (companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(ctx.req.companion_id, modelKey).run();
  return { ack: true, active_model: modelKey };
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
