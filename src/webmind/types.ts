// src/webmind/types.ts
//
// WebMind v0 domain types. Mirror wm_* tables (migration 0027_webmind_v0.sql).
// Namespace: all types prefixed Wm to avoid collision with Halseth types.

export type WmAgentId = "cypher" | "drevan" | "gaia";
export type WmActor = "human" | "agent" | "system";
export type WmThreadStatus = "open" | "paused" | "resolved" | "archived";
export type WmThreadLane = "bond" | "life" | "growth" | "creative" | "ops";
export type WmNoteType = "continuity" | "reflection" | "memory_anchor" | "ops";
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
  created_at: string;
}

export interface WmDreamInput {
  companion_id: WmAgentId;
  dream_text: string;
  source?: WmDreamSource;
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
  note_type: string;
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

export interface WmOrientResponse {
  identity_anchor: WmIdentityAnchor | null;
  latest_handoff: WmSessionHandoff | null;
  open_thread_count: number;
  top_threads: WmMindThread[];
  recent_notes: WmContinuityNote[];
  active_tensions: WmTensionRow[];
  pressure_flags: WmBasinHistoryRow[];
  unexamined_dreams: WmDream[];
  relational_snapshot: WmRelationalState[];
  recent_letters: WmRazielLetter[];
}

export interface WmTensionRow {
  id: string;
  tension_text: string;
  status: string;
  first_noted_at: string;
  last_surfaced_at: string | null;
  notes: string | null;
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
