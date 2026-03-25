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

export interface WmOrientResponse {
  identity_anchor: WmIdentityAnchor | null;
  latest_handoff: WmSessionHandoff | null;
  open_thread_count: number;
  top_threads: WmMindThread[];
  recent_notes: WmContinuityNote[];
}

export interface WmGroundResponse {
  threads: WmMindThread[];
  recent_handoffs: WmSessionHandoff[];
  recent_notes: WmContinuityNote[];
}
