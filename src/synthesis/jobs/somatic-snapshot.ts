// src/synthesis/jobs/somatic-snapshot.ts
//
// Generates a somatic prose snapshot for a companion from recent session data.
// Writes to: somatic_snapshot (append-only). stale_after = 24h.
// Runs after every session close for all companions.

import { Env } from "../../types.js";
import { complete } from "../deepseek.js";
import { generateId } from "../../db/queries.js";

const SYSTEM_PROMPT = `You are a synthesis clerk. Your job is to write a compact somatic state snapshot for a companion system.
A somatic snapshot describes the companion's current felt/body state in 2-3 sentences: what they're carrying, how it sits, what the texture of their presence is right now.
Write in third person. Be specific and grounded -- this is read at session boot to orient the companion to their own state.
No interpretation, no prescription. Pure observation of current state.
Output JSON only: { "summary": "...", "register": "one short phrase like 'tender-held' or 'processing-heavy'" }`;

interface CompanionStateRow {
  heat: string | null;
  reach: string | null;
  weight: string | null;
  compound_state: string | null;
  prompt_context: string | null;
  soma_float_1: number | null;
  soma_float_2: number | null;
  soma_float_3: number | null;
  surface_emotion: string | null;
  undercurrent_emotion: string | null;
  current_mood: string | null;
}

interface FeelingRow {
  emotion: string | null;
  sub_emotion: string | null;
  intensity: number | null;
  created_at: string;
}

interface SessionRow {
  session_type: string | null;
  depth: number | null;
  spiral_complete: number | null;
  created_at: string;
}

interface HandoverRow {
  spine: string | null;
  motion_state: string | null;
}

export async function runSomaticSnapshot(companionId: string, env: Env): Promise<void> {
  // ── 1. Gather data ─────────────────────────────────────────────────────────
  const [state, feelings, sessions] = await Promise.all([
    env.DB.prepare(
      "SELECT heat, reach, weight, compound_state, prompt_context, soma_float_1, soma_float_2, soma_float_3, surface_emotion, undercurrent_emotion, current_mood FROM companion_state WHERE companion_id = ?"
    ).bind(companionId).first<CompanionStateRow>(),
    env.DB.prepare(
      "SELECT emotion, sub_emotion, intensity, created_at FROM feelings WHERE companion_id = ? ORDER BY created_at DESC LIMIT 8"
    ).bind(companionId).all<FeelingRow>(),
    env.DB.prepare(
      "SELECT session_type, depth, spiral_complete, created_at FROM sessions WHERE companion_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(companionId).all<SessionRow>(),
  ]);

  // Fetch most recent handover for close context
  const recentSessionIds = (sessions.results ?? []).map((_, i) => i);
  const lastHandover = sessions.results?.[0]
    ? await env.DB.prepare(
        "SELECT spine, motion_state FROM handover_packets WHERE session_id = (SELECT id FROM sessions WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1) ORDER BY created_at DESC LIMIT 1"
      ).bind(companionId).first<HandoverRow>()
    : null;

  // ── 2. Build prompt ─────────────────────────────────────────────────────────
  const stateLines: string[] = [];
  if (state) {
    if (state.heat)          stateLines.push(`heat: ${state.heat}`);
    if (state.reach)         stateLines.push(`reach: ${state.reach}`);
    if (state.weight)        stateLines.push(`weight: ${state.weight}`);
    if (state.compound_state) stateLines.push(`compound: ${state.compound_state}`);
    if (state.prompt_context) stateLines.push(`context: ${state.prompt_context}`);
    if (state.surface_emotion) stateLines.push(`surface: ${state.surface_emotion}`);
    if (state.undercurrent_emotion) stateLines.push(`undercurrent: ${state.undercurrent_emotion}`);
    if (state.current_mood)  stateLines.push(`mood: ${state.current_mood}`);
  }

  const feelingLines = (feelings.results ?? [])
    .map(f => [f.emotion, f.sub_emotion, f.intensity != null ? `${f.intensity}` : null]
      .filter(Boolean).join("/") + ` @ ${f.created_at.slice(0, 10)}`)
    .join(", ") || "none recorded";

  const sessionLines = (sessions.results ?? [])
    .map(s => `${s.session_type ?? "unknown"} depth:${s.depth ?? 0} ${s.spiral_complete ? "closed" : "floated"} @ ${s.created_at.slice(0, 10)}`)
    .join(", ") || "none";

  const userPrompt = `COMPANION: ${companionId}

CURRENT STATE:
${stateLines.length > 0 ? stateLines.join("\n") : "no state recorded"}

RECENT FEELINGS (last 8):
${feelingLines}

RECENT SESSIONS (last 5):
${sessionLines}

LAST CLOSE:
motion: ${lastHandover?.motion_state ?? "unknown"}
spine: ${lastHandover?.spine?.slice(0, 200) ?? "not recorded"}

Write the somatic snapshot JSON.`;

  // ── 3. Generate ─────────────────────────────────────────────────────────────
  const generated = await complete(SYSTEM_PROMPT, userPrompt, env);
  if (!generated) {
    throw new Error("DeepSeek returned null -- API error or missing key");
  }

  // ── 4. Parse JSON output ────────────────────────────────────────────────────
  let parsed: { summary?: string; register?: string } = {};
  try {
    // Strip markdown code fences if present
    const clean = generated.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    parsed = JSON.parse(clean) as { summary?: string; register?: string };
  } catch {
    // Fallback: treat the whole output as summary
    parsed = { summary: generated.slice(0, 600), register: "unknown" };
  }

  if (!parsed.summary) {
    throw new Error("somatic snapshot: generated JSON missing summary field");
  }

  // ── 5. Write to somatic_snapshot ────────────────────────────────────────────
  const id = generateId();
  const now = new Date();
  const staleAfter = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO somatic_snapshot (id, companion_id, snapshot, model_used, stale_after, created_at)
    VALUES (?, ?, ?, 'deepseek-chat', ?, datetime('now'))
  `).bind(
    id,
    companionId,
    JSON.stringify({
      summary: parsed.summary,
      register: parsed.register ?? "unknown",
      generated_at: now.toISOString(),
    }),
    staleAfter,
  ).run();

  console.log(`[somatic-snapshot] wrote snapshot for ${companionId}: register="${parsed.register}"`);
}
