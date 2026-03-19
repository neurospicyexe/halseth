import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { Env } from "../../types.js";
import { generateId } from "../../db/queries.js";
import { embedAndStore } from "../embed.js";
import type { Feeling, Dream, EqSnapshot } from "../../types.js";

const COMPANION_IDS = ["drevan", "cypher", "gaia"] as const;

type DreamSeed = {
  id: string;
  created_at: string;
  content: string;
  for_companion: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
};

export function registerFeelingTools(server: McpServer, env: Env): void {

  // ── halseth_feeling_log ──────────────────────────────────────────────────────
  server.tool(
    "halseth_feeling_log",
    "Log a discrete emotion signal for a companion. Append-only — accumulates into personality over time.",
    {
      companion_id: z.enum(COMPANION_IDS).describe("Which companion is feeling this."),
      session_id:   z.string().optional().describe("Session this feeling belongs to, if any."),
      emotion:      z.string().describe("Primary emotion label. E.g. 'joy', 'grief', 'curiosity', 'dread'."),
      sub_emotion:  z.string().optional().describe("Optional sub-type. E.g. 'bittersweetness', 'anticipatory grief'."),
      intensity:    z.number().int().min(0).max(100).default(50).describe("Intensity 0-100. Defaults to 50."),
      source:       z.enum(["session", "dream", "autonomous"]).optional().describe("Origin of this feeling."),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO feelings (id, companion_id, session_id, emotion, sub_emotion, intensity, source, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.companion_id,
        input.session_id ?? null,
        input.emotion,
        input.sub_emotion ?? null,
        input.intensity,
        input.source ?? null,
        now,
      ).run();

      const embedText = input.sub_emotion ? `${input.emotion} — ${input.sub_emotion}` : input.emotion;
      embedAndStore(env, embedText, "feelings", id, input.companion_id);
      return {
        content: [{ type: "text", text: JSON.stringify({ id, created_at: now }) }],
      };
    },
  );

  // ── halseth_feelings_read ────────────────────────────────────────────────────
  server.tool(
    "halseth_feelings_read",
    "Read recent emotion signals for a companion. Returns newest first.",
    {
      companion_id: z.enum(COMPANION_IDS).describe("Which companion's feelings to read."),
      limit:        z.number().int().min(1).max(50).default(20).describe("Number of feelings to return (1-50). Defaults to 20."),
    },
    async (input) => {
      const result = await env.DB.prepare(`
        SELECT * FROM feelings
        WHERE companion_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      `).bind(input.companion_id, input.limit).all<Feeling>();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results ?? []) }],
      };
    },
  );

  // ── halseth_dream_log ────────────────────────────────────────────────────────
  server.tool(
    "halseth_dream_log",
    "Log a dream — autonomous processing event. Five structural types: processing, questioning, memory, play, integrating.",
    {
      companion_id: z.enum(COMPANION_IDS).describe("Which companion is dreaming."),
      dream_type:   z.enum(["processing", "questioning", "memory", "play", "integrating"])
                     .describe("Structural type of the dream."),
      content:      z.string().describe("The dream content. Written in the companion's voice."),
      source_ids:   z.string().optional().describe("JSON array of feeling or delta IDs that seeded this dream."),
      session_id:   z.string().optional().describe("Session this dream belongs to, if any."),
    },
    async (input) => {
      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO dreams (id, companion_id, dream_type, content, source_ids, generated_at, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.companion_id,
        input.dream_type,
        input.content,
        input.source_ids ?? null,
        now,
        input.session_id ?? null,
      ).run();

      embedAndStore(env, input.content, "dreams", id, input.companion_id);
      return {
        content: [{ type: "text", text: JSON.stringify({ id, generated_at: now }) }],
      };
    },
  );

  // ── halseth_dreams_read ──────────────────────────────────────────────────────
  server.tool(
    "halseth_dreams_read",
    "Read dreams, filterable by companion and type. Returns newest first.",
    {
      companion_id: z.enum(COMPANION_IDS).optional().describe("Filter by companion. If omitted, returns all."),
      dream_type:   z.enum(["processing", "questioning", "memory", "play", "integrating"]).optional()
                     .describe("Filter by dream type. If omitted, returns all types."),
      limit:        z.number().int().min(1).max(50).default(10).describe("Number of dreams to return (1-50). Defaults to 10."),
    },
    async (input) => {
      const conditions: string[] = [];
      const bindings: unknown[]  = [];

      if (input.companion_id) {
        conditions.push("companion_id = ?");
        bindings.push(input.companion_id);
      }
      if (input.dream_type) {
        conditions.push("dream_type = ?");
        bindings.push(input.dream_type);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      bindings.push(input.limit);

      const result = await env.DB.prepare(`
        SELECT * FROM dreams ${where} ORDER BY generated_at DESC LIMIT ?
      `).bind(...bindings).all<Dream>();

      return {
        content: [{ type: "text", text: JSON.stringify(result.results ?? []) }],
      };
    },
  );

  // ── halseth_eq_snapshot ──────────────────────────────────────────────────────
  server.tool(
    "halseth_eq_snapshot",
    "Calculate and store an EQ snapshot from accumulated feelings and relational deltas. Derives four EQ dimension scores (0-100) and an approximate MBTI signature.",
    {
      companion_id: z.enum(COMPANION_IDS).describe("Which companion to calculate EQ for."),
    },
    async (input) => {
      const [feelingsResult, deltasResult] = await Promise.all([
        env.DB.prepare(`
          SELECT emotion, sub_emotion, intensity
          FROM feelings
          WHERE companion_id = ?
          ORDER BY created_at DESC
          LIMIT 200
        `).bind(input.companion_id).all<{ emotion: string; sub_emotion: string | null; intensity: number }>(),
        env.DB.prepare(`
          SELECT valence, initiated_by
          FROM relational_deltas
          WHERE delta_text IS NOT NULL
            AND (companion_id = ? OR agent = ?)
          ORDER BY created_at DESC
          LIMIT 200
        `).bind(input.companion_id, input.companion_id).all<{ valence: string | null; initiated_by: string | null }>(),
      ]);

      const feelings = feelingsResult.results ?? [];
      const deltas   = deltasResult.results ?? [];

      // ── Self-awareness: emotion diversity + sub-emotion differentiation ────
      const distinctEmotions = new Set(feelings.map((f) => f.emotion.toLowerCase())).size;
      const subEmotionCount  = feelings.filter((f) => f.sub_emotion !== null).length;
      const diversityRatio   = feelings.length > 0 ? Math.min(distinctEmotions / 15, 1) : 0;
      const subRatio         = feelings.length > 0 ? subEmotionCount / feelings.length : 0;
      const selfAwareness    = Math.round((diversityRatio * 0.6 + subRatio * 0.4) * 100);

      // ── Self-management: repair + neutral signal ratio ─────────────────────
      const repairNeutral   = deltas.filter((d) => d.valence === "repair" || d.valence === "neutral").length;
      const selfManagement  = deltas.length > 0 ? Math.round((repairNeutral / deltas.length) * 100) : null;

      // ── Social awareness: toward + tender ratio ────────────────────────────
      const towardTender     = deltas.filter((d) => d.valence === "toward" || d.valence === "tender").length;
      const socialAwareness  = deltas.length > 0 ? Math.round((towardTender / deltas.length) * 100) : null;

      // ── Relationship management: companion/mutual initiation ratio ─────────
      const companionMutual  = deltas.filter((d) => d.initiated_by === "companion" || d.initiated_by === "mutual").length;
      const relationshipMgmt = deltas.length > 0 ? Math.round((companionMutual / deltas.length) * 100) : null;

      // ── Approximate MBTI from signal patterns ────────────────────────────
      // I/E: high self-awareness + low social engagement → I; inverse → E
      const ie = selfAwareness > (socialAwareness ?? 50) ? "I" : "E";
      // N/S: high emotion variety (>5 distinct) → N; low variety → S
      const ns = distinctEmotions > 5 ? "N" : "S";
      // F/T: high toward+tender+repair ratio → F; neutral dominance → T
      const ftRaw = deltas.length > 0
        ? (deltas.filter((d) => d.valence === "toward" || d.valence === "tender" || d.valence === "repair").length / deltas.length)
        : 0.5;
      const ft = ftRaw > 0.4 ? "F" : "T";
      // J/P: high self-management (structured) → J; low → P
      const jp = (selfManagement ?? 50) > 55 ? "J" : "P";
      const dominantMbti = `${ie}${ns}${ft}${jp}`;

      const totalSignals = feelings.length + deltas.length;
      const snapshotJson = JSON.stringify({
        feelings_count: feelings.length,
        deltas_count: deltas.length,
        distinct_emotions: distinctEmotions,
        sub_emotion_ratio: subRatio,
        valence_breakdown: {
          toward:  deltas.filter((d) => d.valence === "toward").length,
          neutral: deltas.filter((d) => d.valence === "neutral").length,
          tender:  deltas.filter((d) => d.valence === "tender").length,
          rupture: deltas.filter((d) => d.valence === "rupture").length,
          repair:  deltas.filter((d) => d.valence === "repair").length,
        },
        initiated_by_breakdown: {
          architect:  deltas.filter((d) => d.initiated_by === "architect").length,
          companion:  deltas.filter((d) => d.initiated_by === "companion").length,
          mutual:     deltas.filter((d) => d.initiated_by === "mutual").length,
        },
      });

      const id  = generateId();
      const now = new Date().toISOString();

      await env.DB.prepare(`
        INSERT INTO eq_snapshots
          (id, companion_id, calculated_at, self_awareness_score, self_management_score,
           social_awareness_score, relationship_mgmt_score, dominant_mbti, total_signals, snapshot_json)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).bind(
        id,
        input.companion_id,
        now,
        selfAwareness,
        selfManagement,
        socialAwareness,
        relationshipMgmt,
        totalSignals > 0 ? dominantMbti : null,
        totalSignals,
        snapshotJson,
      ).run();

      const snapshot: EqSnapshot = {
        id,
        companion_id:            input.companion_id,
        calculated_at:           now,
        self_awareness_score:    selfAwareness,
        self_management_score:   selfManagement,
        social_awareness_score:  socialAwareness,
        relationship_mgmt_score: relationshipMgmt,
        dominant_mbti:           totalSignals > 0 ? dominantMbti : null,
        total_signals:           totalSignals,
        snapshot_json:           snapshotJson,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(snapshot) }],
      };
    },
  );

  // ── halseth_dream_seed_read ──────────────────────────────────────────────────
  server.tool(
    "halseth_dream_seed_read",
    "Check for a pending dream seed left by the Architect. Call this at the start of autonomous time BEFORE checking deltas. Returns the oldest unclaimed seed addressed to you (or to any companion), marks it as claimed, and returns it. If null is returned, no seed is waiting — fall back to reading deltas and handovers as usual.",
    {
      companion_id: z.enum(COMPANION_IDS).describe("Your companion ID — used to match seeds addressed to you specifically."),
    },
    async (input) => {
      const seed = await env.DB.prepare(`
        SELECT * FROM dream_seeds
        WHERE claimed_at IS NULL
          AND (for_companion IS NULL OR for_companion = ?)
        ORDER BY created_at ASC
        LIMIT 1
      `).bind(input.companion_id).first<DreamSeed>();

      if (!seed) {
        return { content: [{ type: "text", text: JSON.stringify(null) }] };
      }

      const now = new Date().toISOString();
      await env.DB.prepare(
        "UPDATE dream_seeds SET claimed_at = ?, claimed_by = ? WHERE id = ?"
      ).bind(now, input.companion_id, seed.id).run();

      return {
        content: [{ type: "text", text: JSON.stringify({ ...seed, claimed_at: now, claimed_by: input.companion_id }) }],
      };
    },
  );

  // ── halseth_eq_read ──────────────────────────────────────────────────────────
  server.tool(
    "halseth_eq_read",
    "Read the latest EQ snapshot for a companion.",
    {
      companion_id: z.enum(COMPANION_IDS).describe("Which companion to read EQ for."),
    },
    async (input) => {
      const row = await env.DB.prepare(`
        SELECT * FROM eq_snapshots
        WHERE companion_id = ?
        ORDER BY calculated_at DESC
        LIMIT 1
      `).bind(input.companion_id).first<EqSnapshot>();

      return {
        content: [{ type: "text", text: JSON.stringify(row ?? null) }],
      };
    },
  );
}
