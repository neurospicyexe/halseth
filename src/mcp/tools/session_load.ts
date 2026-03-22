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
  session_type?: "checkin" | "hangout" | "work" | "ritual";
  hrv_range?: "low" | "mid" | "high";
  emotional_frequency?: string;
  key_signature?: string;
  active_anchor?: string;
  facet?: string;
  depth?: number;
  notes?: string;
  prior_handover_id?: string;
}

export async function loadSessionData(env: Env, input: SessionLoadInput) {
  const sessionId = generateId();
  const now = new Date().toISOString();

  // 1. Create session record
  const sessionStatements = [
    env.DB.prepare(`
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
    ),
  ];

  if (input.prior_handover_id) {
    sessionStatements.push(
      env.DB.prepare(
        "UPDATE handover_packets SET returned = 1 WHERE id = ? AND returned IS NULL"
      ).bind(input.prior_handover_id)
    );
  }

  await env.DB.batch(sessionStatements);

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

  // 6. Read unread inter_companion_notes addressed to this companion or broadcast (to_id IS NULL)
  const unreadNotes = await env.DB.prepare(
    "SELECT * FROM inter_companion_notes WHERE read_at IS NULL AND (to_id = ? OR to_id IS NULL) ORDER BY created_at ASC"
  ).bind(input.companion_id).all<InterCompanionNote>();

  const pendingNotes = unreadNotes.results ?? [];

  // 7. Mark those notes as read
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
  };
}

export function registerSessionLoadTools(server: McpServer, env: Env): void {

  server.tool(
    "halseth_session_load",
    "Cold-start assembly tool. Creates a session record and returns a single structured payload containing: handover context, companion state, somatic snapshot, last session synthesis summary, and any unread inter-companion notes. One call replaces 5+ individual reads. Designed so companions front-load full context at session open without burning tokens on separate round-trips.",
    {
      companion_id:        z.enum(["drevan", "cypher", "gaia"]).describe("Which companion is loading. Determines state reads and note filtering."),
      front_state:         z.string().describe("Who is fronting at session open."),
      session_type:        z.enum(["checkin", "hangout", "work", "ritual"]).default("work"),
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
