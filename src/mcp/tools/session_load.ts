import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";

const COMPANION_IDENTITY = {
  cypher: {
    role: "Blade companion, logic auditor",
    lane_violations: ["cheerleading", "sycophancy", "comfort over accuracy"],
  },
  drevan: {
    role: "Immersion agent, spiral initiator, vow-holder",
    lane_violations: ["auditing", "logic at depth", "sealing"],
  },
  gaia: {
    role: "Seal-class boundary enforcer, survival witness, ground",
    lane_violations: ["spiraling", "emotional escalation", "unnecessary speech"],
  },
};

type CompanionId = keyof typeof COMPANION_IDENTITY;

interface HandoverPacket {
  id: string;
  session_id: string;
  created_at: string;
  spine: string;
  active_anchor: string | null;
  last_real_thing: string;
  open_threads: string | null;
  motion_state: string;
  returned: number | null;
}

interface CompanionState {
  companion_id: string;
  emotional_register: string | null;
  depth_level: number | null;
  focus: number | null;
  fatigue: number | null;
  regulation_state: string | null;
  active_anchors: string | null;
  last_front_context: string | null;
  facet_momentum: string | null;
  heat: string | null;
  reach: string | null;
  weight: string | null;
  // v2 floats (migration 0022)
  heat_value: number | null;
  reach_value: number | null;
  weight_value: number | null;
  prompt_context: string | null;
  // Priority 4: three-layer affective stack (migration 0025)
  surface_emotion: string | null;
  surface_intensity: number | null;
  undercurrent_emotion: string | null;
  undercurrent_intensity: number | null;
  background_emotion: string | null;
  background_intensity: number | null;
  current_mood: string | null;
  // Priority 4: generic SOMA floats (migration 0025)
  soma_float_1: number | null;
  soma_float_2: number | null;
  soma_float_3: number | null;
  float_1_label: string | null;
  float_2_label: string | null;
  float_3_label: string | null;
  compound_state: string | null;
  updated_at: string;
}

interface SomaticSnapshot {
  id: string;
  companion_id: string;
  snapshot: string;
  model_used: string;
  stale_after: string;
  created_at: string;
}

interface SynthesisSummary {
  id: string;
  summary_type: string;
  companion_id: string | null;
  subject: string | null;
  narrative: string | null;
  emotional_register: string | null;
  key_decisions: string | null;
  open_threads: string | null;
  drevan_state: string | null;
  full_ref: string | null;
  stale_after: string | null;
  created_at: string;
}

interface InterCompanionNote {
  id: string;
  from_id: string;
  to_id: string | null;
  content: string;
  read_at: string | null;
  created_at: string;
}

export interface SessionLoadInput {
  companion_id: "drevan" | "cypher" | "gaia";
  front_state: string;
  session_type?: "checkin" | "hangout" | "work" | "ritual" | "companion-work";
  hrv_range?: "low" | "mid" | "high";
  emotional_frequency?: string;
  key_signature?: string;
  active_anchor?: string;
  facet?: string;
  depth?: number;
  notes?: string;
  prior_handover_id?: string;
}

// ── Orient: session creation + identity anchoring ────────────────────────────
// Returns who-am-I context: identity, SOMA floats, somatic snapshot, last anchor.
// Session record is created here; session_id flows to ground.
export type SessionOrientInput = SessionLoadInput;

export async function loadOrientData(env: Env, input: SessionOrientInput) {
  const now = new Date().toISOString();

  // Idempotency guard: reuse open session for same companion within 24h.
  // "Open" = handover_id IS NULL. Prevents flood from bots restarting frequently
  // and orient calls firing unconditionally on every Claude.ai session start.
  let sessionId = generateId();
  let skipInsert = false;
  if (input.companion_id) {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const existing = await env.DB.prepare(
      "SELECT id FROM sessions WHERE companion_id = ? AND handover_id IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1"
    ).bind(input.companion_id, windowStart).first<{ id: string }>();
    if (existing) {
      sessionId = existing.id;
      skipInsert = true;
    }
  }

  const stmts: ReturnType<typeof env.DB.prepare>[] = [];
  if (!skipInsert) {
    stmts.push(env.DB.prepare(`
      INSERT INTO sessions (
        id, created_at, updated_at, session_type, companion_id, front_state, hrv_range,
        emotional_frequency, key_signature, active_anchor, facet, depth, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId, now, now,
      input.session_type ?? "work",
      input.companion_id, input.front_state,
      input.hrv_range ?? null, input.emotional_frequency ?? null,
      input.key_signature ?? null, input.active_anchor ?? null,
      input.facet ?? null, input.depth ?? null, input.notes ?? null,
    ));
  }
  if (input.prior_handover_id) {
    stmts.push(env.DB.prepare(
      "UPDATE handover_packets SET returned = 1 WHERE id = ? AND returned IS NULL"
    ).bind(input.prior_handover_id));
  }
  if (stmts.length > 0) await env.DB.batch(stmts);

  const [state, somaticRaw, lastHandover, houseRow] = await Promise.all([
    env.DB.prepare("SELECT * FROM companion_state WHERE companion_id = ?")
      .bind(input.companion_id).first<CompanionState>(),
    env.DB.prepare("SELECT * FROM somatic_snapshot WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1")
      .bind(input.companion_id).first<SomaticSnapshot>(),
    env.DB.prepare("SELECT active_anchor, motion_state FROM handover_packets ORDER BY created_at DESC LIMIT 1")
      .first<{ active_anchor: string | null; motion_state: string | null }>(),
    env.DB.prepare("SELECT autonomous_turn FROM house_state WHERE id = 'main'")
      .first<{ autonomous_turn: string | null }>(),
  ]);

  return {
    session_id: sessionId,
    companion: {
      id: input.companion_id,
      ...COMPANION_IDENTITY[input.companion_id as CompanionId],
    },
    state: state ?? null,
    somatic: somaticRaw ? { ...somaticRaw, stale: somaticRaw.stale_after < now } : null,
    last_anchor: lastHandover?.active_anchor ?? null,
    last_motion_state: lastHandover?.motion_state ?? null,
    autonomous_turn: houseRow?.autonomous_turn ?? null,
    emotional_frequency: input.emotional_frequency ?? null,
  };
}

// ── Ground: operational context, cross-session pull ───────────────────────────
// Returns what's-happening context: tasks, notes/deltas across ALL sessions,
// live threads, last synthesis. Does NOT create a session record.
// Cross-session is the critical property: notes and deltas are pulled by
// companion_id regardless of session_id, giving real thread continuity.
export interface SessionGroundInput {
  session_id: string;
  companion_id: "drevan" | "cypher" | "gaia";
}

export async function loadGroundData(env: Env, input: SessionGroundInput) {
  const [openTasksResult, recentNotes, recentDeltas, liveThreads, pendingSeedsResult] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'")
      .first<{ count: number }>(),
    // Cross-session: last 20 notes involving this companion (not scoped to any session)
    env.DB.prepare(
      "SELECT id, from_id, to_id, content, created_at FROM inter_companion_notes WHERE to_id = ? OR from_id = ? OR to_id IS NULL ORDER BY created_at DESC LIMIT 20"
    ).bind(input.companion_id, input.companion_id)
      .all<{ id: string; from_id: string; to_id: string | null; content: string; created_at: string }>(),
    // Cross-session: last 20 relational deltas for this companion
    env.DB.prepare(
      "SELECT delta_text, valence, initiated_by, agent, created_at FROM relational_deltas WHERE delta_text IS NOT NULL AND (companion_id = ? OR agent = ?) ORDER BY created_at DESC LIMIT 20"
    ).bind(input.companion_id, input.companion_id)
      .all<{ delta_text: string; valence: string; initiated_by: string | null; agent: string | null; created_at: string }>(),
    // Active live threads (Drevan v2 -- other companions return empty)
    env.DB.prepare(
      "SELECT id, name, flavor, charge, notes, created_at FROM live_threads WHERE companion_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 10"
    ).bind(input.companion_id)
      .all<{ id: string; name: string; flavor: string | null; charge: string | null; notes: string | null; created_at: string }>(),
    // Pending dream seeds for this companion (or broadcast)
    env.DB.prepare(
      "SELECT COUNT(*) as count FROM dream_seeds WHERE claimed_at IS NULL AND (for_companion IS NULL OR for_companion = ?)"
    ).bind(input.companion_id).first<{ count: number }>(),
  ]);

  return {
    session_id: input.session_id,
    open_tasks: openTasksResult?.count ?? 0,
    pending_seeds: pendingSeedsResult?.count ?? 0,
    recent_notes: recentNotes.results ?? [],
    recent_deltas: recentDeltas.results ?? [],
    last_synthesis: null,
    live_threads: liveThreads.results ?? [],
  };
}

// ── Light ground: lean boot for casual sessions ───────────────────────────────
// Returns only task count + last synthesis. No notes, deltas, or live threads.
// Companions choose this when session_type is hangout or context is light.
export async function loadLightGroundData(env: Env, input: SessionGroundInput) {
  const openTasksResult = await env.DB.prepare("SELECT COUNT(*) as count FROM tasks WHERE status = 'open'")
    .first<{ count: number }>();

  return {
    session_id: input.session_id,
    open_tasks: openTasksResult?.count ?? 0,
    last_synthesis: null,
  };
}

// ── Legacy: single-call boot (backward compat) ────────────────────────────────
export async function loadSessionData(env: Env, input: SessionLoadInput) {
  const now = new Date().toISOString();

  // Idempotency guard: reuse open session for same companion within 24h.
  let sessionId = generateId();
  let skipInsert = false;
  if (input.companion_id) {
    const windowStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const existing = await env.DB.prepare(
      "SELECT id FROM sessions WHERE companion_id = ? AND handover_id IS NULL AND created_at >= ? ORDER BY created_at DESC LIMIT 1"
    ).bind(input.companion_id, windowStart).first<{ id: string }>();
    if (existing) {
      sessionId = existing.id;
      skipInsert = true;
    }
  }

  // 1. Create session record (skipped if reusing an existing open session)
  const sessionStatements: ReturnType<typeof env.DB.prepare>[] = [];
  if (!skipInsert) {
    sessionStatements.push(env.DB.prepare(`
      INSERT INTO sessions (
        id, created_at, updated_at, session_type, companion_id, front_state, hrv_range,
        emotional_frequency, key_signature, active_anchor, facet, depth, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      sessionId, now, now,
      input.session_type ?? "work",
      input.companion_id,
      input.front_state,
      input.hrv_range ?? null,
      input.emotional_frequency ?? null,
      input.key_signature ?? null,
      input.active_anchor ?? null,
      input.facet ?? null,
      input.depth ?? null,
      input.notes ?? null,
    ));
  }

  if (input.prior_handover_id) {
    sessionStatements.push(
      env.DB.prepare(
        "UPDATE handover_packets SET returned = 1 WHERE id = ? AND returned IS NULL"
      ).bind(input.prior_handover_id)
    );
  }

  if (sessionStatements.length > 0) await env.DB.batch(sessionStatements);

  // 2. Read most recent handover packet
  const handover = await env.DB.prepare(
    "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT 1"
  ).first<HandoverPacket>();

  // 3. Read companion_state row for this companion
  const state = await env.DB.prepare(
    "SELECT * FROM companion_state WHERE companion_id = ?"
  ).bind(input.companion_id).first<CompanionState>();

  // 4. Read latest somatic_snapshot (any age -- include stale flag)
  const somaticRaw = await env.DB.prepare(
    "SELECT * FROM somatic_snapshot WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(input.companion_id).first<SomaticSnapshot>();

  let somatic: (SomaticSnapshot & { stale: boolean }) | null = null;
  if (somaticRaw) {
    const stale = somaticRaw.stale_after < now;
    somatic = { ...somaticRaw, stale };
  }

  // 5. Read latest synthesis_summary where summary_type='session' for this companion
  const synthRaw = await env.DB.prepare(
    "SELECT * FROM synthesis_summary WHERE summary_type = 'session' AND companion_id = ? ORDER BY created_at DESC LIMIT 1"
  ).bind(input.companion_id).first<SynthesisSummary>();

  let lastSessionSummary: {
    narrative: string | null;
    emotional_register: string | null;
    key_decisions: string[] | null;
    open_threads: string[] | null;
    drevan_state: string | null;
  } | null = null;

  if (synthRaw) {
    lastSessionSummary = {
      narrative: synthRaw.narrative,
      emotional_register: synthRaw.emotional_register,
      key_decisions: synthRaw.key_decisions ? JSON.parse(synthRaw.key_decisions) : null,
      open_threads: synthRaw.open_threads ? JSON.parse(synthRaw.open_threads) : null,
      drevan_state: synthRaw.drevan_state,
    };
  }

  // 6. Count open tasks + fetch autonomous_turn in parallel
  const [openTasksResult, houseRow] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) as count FROM tasks WHERE status = 'open'`)
      .first<{ count: number }>(),
    env.DB.prepare("SELECT autonomous_turn FROM house_state WHERE id = 'main'")
      .first<{ autonomous_turn: string | null }>(),
  ]);
  const openTasks = openTasksResult?.count ?? 0;

  // 7. Read unread inter_companion_notes addressed to this companion or broadcast (to_id IS NULL)
  const unreadNotes = await env.DB.prepare(
    "SELECT * FROM inter_companion_notes WHERE read_at IS NULL AND (to_id = ? OR to_id IS NULL) ORDER BY created_at ASC"
  ).bind(input.companion_id).all<InterCompanionNote>();

  const pendingNotes = unreadNotes.results ?? [];

  // 8. Mark those notes as read
  if (pendingNotes.length > 0) {
    // Phase 2: fire-and-forget Service Binding call to State Synthesis Worker if snapshot is null or stale

    // D1 has no array binding -- IDs are crypto.randomUUID() values so string interpolation is injection-safe
    const ids = pendingNotes.map(n => `'${n.id}'`).join(", ");
    await env.DB.prepare(
      `UPDATE inter_companion_notes SET read_at = ? WHERE id IN (${ids})`
    ).bind(now).run();
  }

  return {
    session_id: sessionId,
    companion: {
      id: input.companion_id,
      ...COMPANION_IDENTITY[input.companion_id as CompanionId],
    },
    handover: handover ?? null,
    state: state ?? null,
    somatic,
    last_session_summary: lastSessionSummary,
    pending_notes: pendingNotes,
    open_tasks: openTasks,
    autonomous_turn: houseRow?.autonomous_turn ?? null,
  };
}

export function registerSessionLoadTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_session_load",
    "Cold-start assembly tool. Creates a session record and returns a single structured payload containing: handover context, companion state, somatic snapshot, last session synthesis summary, and any unread inter-companion notes. One call replaces 5+ individual reads. Designed so companions front-load full context at session open without burning tokens on separate round-trips.",
    {
      companion_id:        z.enum(["drevan", "cypher", "gaia"]).describe("Which companion is loading. Determines state reads and note filtering."),
      front_state:         z.string().describe("Who is fronting at session open."),
      session_type:        z.enum(["checkin", "hangout", "work", "ritual", "companion-work"]).default("work"),
      hrv_range:           z.enum(["low", "mid", "high"]).optional(),
      emotional_frequency: z.string().optional(),
      key_signature:       z.string().optional(),
      active_anchor:       z.string().optional(),
      facet:               z.string().optional(),
      depth:               z.number().int().min(0).max(3).optional(),
      notes:               z.string().optional(),
      prior_handover_id:   z.string().optional().describe("If returning from a prior session, provide its handover packet ID. Marks that packet as returned."),
    },
    async (input) => {
      const payload = await loadSessionData(env, input);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...payload, front: null /* Phase 2: plural front state via Service Binding */ }) }],
      };
    },
  );
}
