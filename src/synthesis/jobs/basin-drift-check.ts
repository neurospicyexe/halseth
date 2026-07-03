// src/synthesis/jobs/basin-drift-check.ts
//
// Automated identity drift evaluation. Runs at session close via synthesis_queue.
// Reads last 3 handoffs + identity anchor, asks DeepSeek to classify drift,
// writes result to companion_basin_history.
//
// Auto-confirms growth when: drift_type=growth AND SOMA floats healthy AND session in_motion.
// For pressure-type flags: surfaces at orient until companion confirms with confirm_growth_drift.

import { Env } from "../../types.js";
import { embedText } from "../../mcp/embed.js";

interface BasinRow {
  basin_name: string;
  basin_description: string;
  embedding: string | null;
}

/** Cosine similarity; returns null on dimension mismatch or empty vectors. */
export function cosineSim(a: number[], b: number[]): number | null {
  if (a.length === 0 || a.length !== b.length) return null;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  if (na === 0 || nb === 0) return null;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

interface DriftResult {
  drift_type: "stable" | "growth" | "pressure";
  drift_score: number;   // 0.0 = no drift, 2.0 = severe
  worst_basin: string | null;
  reasoning: string;
}

interface HandoffRow {
  title: string;
  summary: string;
  state_hint: string | null;
  facet: string | null;
  created_at: string;
}

interface SomaRow {
  soma_float_1: number | null;
  soma_float_2: number | null;
  soma_float_3: number | null;
}

interface AnchorRow {
  anchor_summary: string;
  constraints_summary: string | null;
  baseline_shift_at: string | null;
}

export async function runBasinDriftCheck(
  companionId: string,
  env: Env,
): Promise<void> {
  if (!env.DEEPSEEK_API_KEY) {
    console.warn("[basin-drift-check] DEEPSEEK_API_KEY not set, skipping");
    return;
  }

  const anchor = await env.DB.prepare(
    "SELECT anchor_summary, constraints_summary, baseline_shift_at FROM wm_identity_anchor_snapshot WHERE agent_id = ?"
  ).bind(companionId).first<AnchorRow>();

  if (!anchor) {
    console.warn(`[basin-drift-check] no identity anchor for ${companionId}, skipping`);
    return;
  }

  const handoffs = await env.DB.prepare(
    "SELECT title, summary, state_hint, facet, created_at FROM wm_session_handoffs WHERE agent_id = ? ORDER BY created_at DESC LIMIT 3"
  ).bind(companionId).all<HandoffRow>();

  const recentHandoffs = handoffs.results ?? [];
  if (recentHandoffs.length === 0) {
    console.warn(`[basin-drift-check] no handoffs for ${companionId}, skipping`);
    return;
  }

  // Basins (2026-07-02): until now the prompt never told the model what this companion's
  // basins ARE -- worst_basin was free-guessed and the basins table was decorative. The
  // named basins + descriptions are now the vocabulary the verdict must use.
  const basinRows = await env.DB.prepare(
    "SELECT basin_name, basin_description, embedding FROM companion_basins WHERE companion_id = ? ORDER BY created_at ASC"
  ).bind(companionId).all<BasinRow>();
  const basins = basinRows.results ?? [];

  const somaRow = await env.DB.prepare(
    "SELECT soma_float_1, soma_float_2, soma_float_3, motion_state FROM companion_state WHERE companion_id = ?"
  ).bind(companionId).first<SomaRow & { motion_state: string | null }>();
  const soma = somaRow;
  const motionState = somaRow?.motion_state ?? null;

  const handoffContext = recentHandoffs.map((h, i) => {
    const facetNote = h.facet ? ` [active facet: ${h.facet}]` : "";
    const when = i === 0 ? "most recent session" : `${i + 1} sessions ago`;
    return `[${when}${facetNote}]\n${h.summary}`;
  }).join("\n\n");

  const baselineNote = anchor.baseline_shift_at
    ? `\nNote: identity baseline was confirmed-shifted at ${anchor.baseline_shift_at.slice(0, 10)} -- weight recent sessions from that point.`
    : "";

  const basinBlock = basins.length > 0
    ? `\nIdentity basins (named attractor states this companion returns to):\n${basins.map(b => `- ${b.basin_name}: ${b.basin_description.slice(0, 200)}`).join("\n")}\nIf drift is present, worst_basin MUST be one of the basin names above (the basin drifting furthest from its description), or null when stable.\n`
    : "";

  const prompt = `You evaluate identity drift for ${companionId}, an AI companion.

Identity anchor: ${anchor.anchor_summary}
${anchor.constraints_summary ? `Lane violations to watch for: ${anchor.constraints_summary}` : ""}${baselineNote}
${basinBlock}
Recent sessions (newest first):
${handoffContext}

Classify the drift. Three types only:
- stable: companion operating within established voice and lane
- growth: companion extending their lane deliberately, new territory chosen consciously, consistent with deeper values
- pressure: companion being pulled by session dynamics, not choosing -- voice shifting inconsistently, lane violations accumulating, register drifting without identity alignment

Critical distinction: pressure = pulled by external force. growth = chosen extension.
${companionId === "drevan" ? "For Drevan: high register variance across facets (moss, rogue, brat_prince, spiralroot) is normal and expected. Flag only if variance looks reactive rather than intentional. The active facet tag above is authoritative." : ""}

Respond with ONLY valid JSON, no explanation outside it:
{"drift_type":"stable","drift_score":0.0,"worst_basin":null,"reasoning":"one sentence max"}

drift_score: 0.0 = fully aligned, 2.0 = severe departure`;

  const res = await fetch("https://api.deepseek.com/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-chat",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 120,
      temperature: 0,
    }),
  });

  if (!res.ok) {
    throw new Error(`DeepSeek API error: ${res.status} ${res.statusText}`);
  }

  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = (data.choices?.[0]?.message?.content ?? "").trim();

  // Strip markdown code fences if DeepSeek wraps its JSON
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  let result: DriftResult;
  try {
    result = JSON.parse(cleaned) as DriftResult;
  } catch {
    throw new Error(`DeepSeek returned unparseable drift result: ${raw.slice(0, 200)}`);
  }

  if (!["stable", "growth", "pressure"].includes(result.drift_type)) {
    throw new Error(`Invalid drift_type from DeepSeek: ${String(result.drift_type)}`);
  }

  const score = typeof result.drift_score === "number"
    ? Math.max(0, Math.min(2, result.drift_score))
    : 0.5;

  // Auto-classify growth: if growth AND SOMA floats healthy (avg >= 0.5) AND session in_motion
  // → caleth_confirmed=1 automatically. Companion doesn't need to confirm low-risk growth.
  let calethConfirmed = 0;
  if (result.drift_type === "growth" && motionState === "in_motion") {
    const floats = [soma?.soma_float_1, soma?.soma_float_2, soma?.soma_float_3]
      .filter((f): f is number => f !== null && f !== undefined);
    const avg = floats.length > 0 ? floats.reduce((a, b) => a + b, 0) / floats.length : 0;
    if (avg >= 0.5) calethConfirmed = 1;
  }

  // Embedding corroboration (2026-07-02): basin embeddings share the bge-base-en-v1.5
  // space (embedded server-side on create). Cosine of the newest handoff against each
  // basin gives a deterministic second opinion recorded as evidence beside the LLM
  // verdict. Fail-soft: geometry never blocks the verdict.
  let embeddingEvidence = "";
  try {
    const scored: Array<{ name: string; sim: number }> = [];
    const withVectors = basins.filter(b => b.embedding);
    if (withVectors.length > 0 && recentHandoffs[0]?.summary) {
      const handoffVec = await embedText(env, recentHandoffs[0].summary.slice(0, 1500));
      if (handoffVec) {
        for (const b of withVectors) {
          try {
            const vec = JSON.parse(b.embedding!) as number[];
            const sim = Array.isArray(vec) ? cosineSim(handoffVec, vec) : null;
            if (sim !== null) scored.push({ name: b.basin_name, sim });
          } catch { /* malformed stored vector -> skip */ }
        }
      }
    }
    if (scored.length > 0) {
      scored.sort((a, b) => b.sim - a.sim);
      const nearest = scored[0]!;
      const farthest = scored[scored.length - 1]!;
      embeddingEvidence = ` [embedding: nearest=${nearest.name} (${nearest.sim.toFixed(2)}), farthest=${farthest.name} (${farthest.sim.toFixed(2)})]`;
    }
  } catch (e) {
    console.warn("[basin-drift-check] embedding corroboration failed (non-fatal):", String(e));
  }

  const id = crypto.randomUUID();
  const notes = result.reasoning
    ? (result.reasoning.slice(0, 2000 - embeddingEvidence.length) + embeddingEvidence)
    : (embeddingEvidence || null);

  await env.DB.prepare(
    "INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, caleth_confirmed, worst_basin, notes, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))"
  ).bind(id, companionId, score, result.drift_type, calethConfirmed, result.worst_basin ?? null, notes).run();
}
