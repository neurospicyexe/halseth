// src/webmind/types.ts
//
// WebMind v0 domain types. Mirror wm_* tables (migration 0027_webmind_v0.sql).
// Namespace: all types prefixed Wm to avoid collision with Halseth types.

export type WmAgentId = "cypher" | "drevan" | "gaia";
export type WmActor = "human" | "agent" | "system";
export type WmThreadStatus = "open" | "paused" | "resolved" | "archived";
export type WmThreadLane = "bond" | "life" | "growth" | "creative" | "ops";
export type WmNoteType = "continuity" | "reflection" | "memory_anchor" | "ops" | "soma_arc";
export type WmSalience = "low" | "normal" | "high";

export interface WmIdentityAnchor {
  agent_id: WmAgentId;
  identity_version_hash: string;
  anchor_summary: string;
  constraints_summary: string | null;
  updated_at: string;
  source: string;
}

export interface WmSessionHandoff {
  handoff_id: string;
  agent_id: WmAgentId;
  thread_id: string | null;
  title: string;
  summary: string;
  next_steps: string | null;
  open_loops: string | null;
  state_hint: string | null;
  facet: string | null;
  actor: WmActor;
  source: string;
  correlation_id: string | null;
  created_at: string;
}

export interface WmMindThread {
  thread_key: string;
  agent_id: WmAgentId;
  title: string;
  status: WmThreadStatus;
  priority: number;
  lane: WmThreadLane | null;
  context: string | null;
  do_not_archive: number;
  do_not_resolve: number;
  actor: WmActor;
  source: string;
  correlation_id: string | null;
  last_touched_at: string;
  updated_at: string;
  status_changed: string | null;
  created_at: string;
}

export interface WmThreadEvent {
  event_id: string;
  thread_key: string;
  agent_id: WmAgentId;
  event_type: string;
  content: string | null;
  actor: WmActor;
  source: string;
  correlation_id: string | null;
  created_at: string;
}

export interface WmContinuityNote {
  note_id: string;
  agent_id: WmAgentId;
  thread_key: string | null;
  note_type: WmNoteType;
  content: string;
  salience: WmSalience;
  actor: WmActor;
  source: string;
  correlation_id: string | null;
  created_at: string;
}

// ── Relational State ─────────────────────────────────────────────────────────

export type WmRelationalStateType = "feeling" | "witness" | "held";

export interface WmRelationalState {
  id: string;
  companion_id: WmAgentId;
  toward: string;
  state_text: string;
  weight: number;
  state_type: WmRelationalStateType;
  noted_at: string;
}

export interface WmRelationalStateInput {
  companion_id: WmAgentId;
  toward: string;
  state_text: string;
  weight?: number;
  state_type?: WmRelationalStateType;
}

// ── Dreams + Open Loops ───────────────────────────────────────────────────────

export type WmDreamSource = "autonomous" | "session";

export interface WmDream {
  id: string;
  companion_id: WmAgentId;
  dream_text: string;
  source: WmDreamSource;
  examined: number;
  examined_at: string | null;
  do_not_auto_examine: number;  // 1 = requires live session examination
  created_at: string;
}

export interface WmDreamInput {
  companion_id: WmAgentId;
  dream_text: string;
  source?: WmDreamSource;
  do_not_auto_examine?: boolean;
}

export interface WmOpenLoop {
  id: string;
  companion_id: WmAgentId;
  loop_text: string;
  weight: number;
  opened_at: string;
  closed_at: string | null;
}

export interface WmLoopInput {
  companion_id: WmAgentId;
  loop_text: string;
  weight?: number;
}

// ── Sit & Resolve ─────────────────────────────────────────────────────────────

export type WmSitStatus = "raw" | "sitting" | "metabolized";

export interface WmSittingNote {
  note_id: string;
  content: string;
  note_type: string | null; // tags JSON string from companion_journal
  created_at: string;
  sit_text: string | null;
  sat_at: string;
}

export interface WmSitInput {
  note_id: string;
  companion_id: WmAgentId;
  sit_text?: string;
}

// ── Input shapes (write operations) ──────────────────────────────────────────

export interface WmHandoffInput {
  agent_id: WmAgentId;
  title: string;
  summary: string;
  thread_id?: string;
  next_steps?: string;
  open_loops?: string;
  state_hint?: string;
  facet?: string;
  actor?: WmActor;
  source?: string;
  correlation_id?: string;
}

export interface WmThreadUpsertInput {
  thread_key: string;
  agent_id: WmAgentId;
  title: string;
  status?: WmThreadStatus;
  priority?: number;
  lane?: WmThreadLane;
  context?: string;
  do_not_archive?: boolean;
  do_not_resolve?: boolean;
  event_type?: string;
  event_content?: string;
  actor?: WmActor;
  source?: string;
  correlation_id?: string;
}

export interface WmNoteInput {
  agent_id: WmAgentId;
  content: string;
  thread_key?: string;
  note_type?: WmNoteType;
  salience?: WmSalience;
  actor?: WmActor;
  source?: string;
  correlation_id?: string;
}

// ── Orient/Ground response shapes ────────────────────────────────────────────

export interface WmRazielLetter {
  id: string;
  author: string;
  content: string;
  note_type: string;
  created_at: string;
  processing_status: string;
}

// ── Conclusions ──────────────────────────────────────────────────────────────

export interface WmConclusion {
  id: string;
  companion_id: WmAgentId;
  conclusion_text: string;
  source_sessions: string | null;  // JSON array string
  superseded_by: string | null;
  created_at: string;
  edited_at: string | null;
  confidence: number;           // 0.0-1.0, default 0.7 at DB level
  belief_type: string;          // 'self' | 'observational' | 'relational' | 'systemic'
  subject: string | null;
  provenance: string | null;
  contradiction_flagged: number; // integer boolean (0|1)
}

// ── Limbic State (swarm-level synthesis output) ────────────────────────────

export interface WmLimbicState {
  state_id: string;
  generated_at: string;
  synthesis_source: string | null;
  active_concerns: string | null;
  live_tensions: string | null;
  drift_vector: string | null;
  open_questions: string | null;
  emotional_register: string | null;
  swarm_threads: string | null;
  companion_notes: string | null;
  companion_id: string | null;
  created_at: string;
}

export interface WmLimbicStateInput {
  synthesis_source: string;
  active_concerns: string[];
  live_tensions: string[];
  drift_vector: string;
  open_questions: string[];
  emotional_register: string;
  swarm_threads: string[];
  companion_notes: Record<string, string>;
  companion_id?: string;
}

export interface WmOrientResponse {
  identity_anchor: WmIdentityAnchor | null;
  limbic_state: WmLimbicState | null;
  latest_handoff: WmSessionHandoff | null;
  open_thread_count: number;
  top_threads: WmMindThread[];
  recent_notes: WmContinuityNote[];
  active_tensions: WmTensionRow[];
  pressure_flags: WmBasinHistoryRow[];
  unexamined_dreams: WmDream[];
  relational_snapshot: WmRelationalState[];
  recent_letters: WmRazielLetter[];
  // Wide-window cross-session reads (added to fix boot-time compression artifacts)
  recent_handoffs: WmSessionHandoff[];      // last 3 session closes (latest_handoff = [0])
  recent_companion_notes: WmCompanionNote[];  // outgoing: notes this companion sent to others
  incoming_companion_notes: WmCompanionNote[]; // incoming: notes sent TO this companion (+ broadcasts)
  recent_journal: WmJournalEntry[];           // journal entries written BY this companion
  recent_deltas: WmRecentDelta[];
  raziel_witness_entries: WmRelationalState[];  // recent witness observations about Raziel (not ROW_NUMBER collapsed)
  active_conclusions: WmConclusion[];           // companion's active (non-superseded) beliefs, type-distributed
  flagged_beliefs: WmConclusion[];              // active conclusions with contradiction_flagged = 1
  soma_arc?: {
    note_id: string;
    content: string;
    created_at: string;
  }[];
}

// Notes written between companions (inter_companion_notes table)
export interface WmCompanionNote {
  id: string;
  from_id: string;
  to_id: string | null;  // null = broadcast
  content: string;
  read_at: string | null;
  created_at: string;
}

// Journal entries written BY a companion (companion_journal table)
export interface WmJournalEntry {
  id: string;
  agent: string;
  note_text: string;
  tags: string | null;  // JSON array string
  session_id: string | null;
  created_at: string;
}

// Relational deltas -- relationship moments logged by companions (relational_deltas table)
export interface WmRecentDelta {
  id: string;
  delta_type: string;
  delta_text: string | null;
  payload_json: string;
  valence: string | null;
  created_at: string;
}

export interface WmTensionRow {
  id: string;
  tension_text: string;
  status: string;
  first_noted_at: string;
  last_surfaced_at: string | null;
  notes: string | null;
  // Set by orient.ts when a tension predates active conclusions by > 3 days.
  // Signals synthesis workers that this territory may already be resolved.
  possibly_resolved?: boolean;
}

export interface WmBasinHistoryRow {
  drift_score: number;
  drift_type: string;
  worst_basin: string | null;
  recorded_at: string;
}

export interface WmGroundResponse {
  threads: WmMindThread[];
  recent_handoffs: WmSessionHandoff[];
  recent_notes: WmContinuityNote[];
  open_loops: WmOpenLoop[];
  sitting_notes: WmSittingNote[];
}
