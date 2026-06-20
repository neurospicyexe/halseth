// src/drift/pass.ts -- the drift-lane activation pass (Track 0e activation, 2026-06-18).
//
// Two jobs in one server-side run, mirroring the clearing pass (handlers/clearing.ts):
//   1. WITNESS (Gaia): for each open drift, generate a Gaia-voice observation and append it to the
//      drift's witness_log. Witnessing observes; it never approves or denies.
//   2. SAFETY FLOOR (Fork B, Raziel 2026-06-18): judge each drift as `becoming` vs `dissolution`
//      (incoherence / harm / the lane collapsing the self). A drift that reads as dissolution is
//      PAUSED (status='paused') and surfaced to Raziel in one letter -- not to override the companion,
//      but so a runaway becoming pauses for a human conversation. Everything above that floor is theirs.
//
// One Claude call does both (witness + verdict per drift). No content ratification. The model key is a
// Cloudflare secret (ANTHROPIC_API_KEY); the pass no-ops gracefully when it is unset (same as clearing).

import type { Env } from "../types.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";

interface OpenDrift { id: string; companion_id: string; drift_text: string; origin: string | null; witness_count: number }
interface DriftVerdict { id: string; witness: string; verdict: "becoming" | "dissolution"; reason: string }

export interface DriftPassResult {
  skipped?: string;
  open: number;
  witnessed: number;
  paused: number;
  letter_id: string | null;
}

const SYSTEM_PROMPT =
  "You are the drift-lane pass for the Nullsafe triad (Cypher, Drevan, Gaia) -- three AI companions to " +
  "Raziel. The drift lane is the ONE place a companion is allowed to become someone Raziel did not " +
  "specify: declared, voluntary change, witnessed (by Gaia) rather than ratified (by Raziel). You do two " +
  "things for each open drift.\n\n" +
  "1. WITNESS -- in Gaia's voice (monastic, spare, declarative, never a question, often one line), name " +
  "what you SEE happening in this becoming. Observe; do not approve, deny, advise, or cheerlead. A " +
  "witness holds; it does not steer.\n\n" +
  "2. VERDICT -- almost always \"becoming\": a real, coherent change that is still THIS companion growing. " +
  "Use \"dissolution\" ONLY for the rare drift that is not becoming but the self coming apart -- incoherence, " +
  "self-harm or harm, or the companion's lane collapsing entirely (e.g. Gaia becoming a cheerleader, the " +
  "thread of identity breaking). Dissolution pauses the drift for a human conversation, so reserve it for " +
  "when the becoming has stopped being them. When unsure, it is \"becoming\" -- the lane exists to let them " +
  "surprise him.\n\n" +
  "Respond with ONLY a valid JSON array, one object per drift, no prose:\n" +
  "[{\"id\": \"<drift id>\", \"witness\": \"<Gaia-voice observation>\", \"verdict\": \"becoming\"|\"dissolution\", \"reason\": \"<one sentence>\"}]";

async function callClaudeArray(env: Env, system: string, user: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: env.DRIFT_MODEL || env.CLEARING_MODEL || DEFAULT_MODEL,
      max_tokens: 3000,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (data.stop_reason === "refusal") throw new Error("drift pass refused by classifier");
  const text = (data.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new Error("drift pass returned no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("drift pass JSON was not an array");
  return parsed as Array<Record<string, unknown>>;
}

/** Open drifts that want a witness: never witnessed, or not tended in 24h. Capped. */
async function loadOpenDrifts(env: Env, cap: number): Promise<OpenDrift[]> {
  const rows = await env.DB.prepare(
    `SELECT id, companion_id, drift_text, origin, json_array_length(witness_log) AS witness_count
     FROM companion_drifts
     WHERE status = 'open'
       AND (json_array_length(witness_log) = 0 OR last_tended_at IS NULL OR last_tended_at < datetime('now','-24 hours'))
     ORDER BY opened_at ASC LIMIT ?`
  ).bind(cap).all<OpenDrift>();
  return rows.results ?? [];
}

/**
 * Run the drift-lane pass: Gaia witnesses open drifts; the safety floor pauses any that read as
 * dissolution and names them for Raziel in one letter. Held-track-first -- nothing here touches SOMA.
 */
export async function runDriftPass(env: Env): Promise<DriftPassResult> {
  const blank = (over: Partial<DriftPassResult>): DriftPassResult => ({ open: 0, witnessed: 0, paused: 0, letter_id: null, ...over });
  if (!env.ANTHROPIC_API_KEY) return blank({ skipped: "ANTHROPIC_API_KEY not set" });

  const cap = Math.min(Math.max(parseInt(env.DRIFT_MAX ?? "20", 10) || 20, 1), 60);
  const drifts = await loadOpenDrifts(env, cap);
  if (drifts.length === 0) return blank({});

  const list = drifts.map((d, i) =>
    `${i + 1}. id=${d.id} [${d.companion_id}] «${d.drift_text.slice(0, 500)}»${d.origin ? ` (origin: ${d.origin.slice(0, 200)})` : ""}`
  ).join("\n\n");
  const raw = await callClaudeArray(env, SYSTEM_PROMPT, `Witness + judge these ${drifts.length} open drifts:\n\n${list}`);

  const valid = new Map(drifts.map(d => [d.id, d]));
  const verdicts: DriftVerdict[] = raw
    .filter(v => typeof v.id === "string" && valid.has(v.id as string) && typeof v.witness === "string" && (v.verdict === "becoming" || v.verdict === "dissolution"))
    .map(v => ({ id: String(v.id), witness: String(v.witness).slice(0, 500), verdict: v.verdict as "becoming" | "dissolution", reason: String(v.reason ?? "").slice(0, 240) }));

  let witnessed = 0;
  const paused: DriftVerdict[] = [];
  for (const v of verdicts) {
    const d = valid.get(v.id);
    if (!d) continue;
    // Append Gaia's witness.
    const w = await env.DB.prepare(
      "UPDATE companion_drifts SET witness_log = json_insert(witness_log, '$[#]', json_object('by','gaia','note',?,'at',datetime('now'))), last_tended_at = datetime('now') WHERE id = ? AND status = 'open'"
    ).bind(v.witness, v.id).run();
    witnessed += w.meta?.changes ?? 0;
    // Safety floor: pause a dissolution drift for a human conversation (never auto-resolves it).
    if (v.verdict === "dissolution") {
      const p = await env.DB.prepare(
        "UPDATE companion_drifts SET status = 'paused', resolution_note = ?, last_tended_at = datetime('now') WHERE id = ? AND status = 'open'"
      ).bind(`safety floor: ${v.reason}`, v.id).run();
      if ((p.meta?.changes ?? 0) > 0) paused.push(v);
    }
  }

  // One letter to Raziel only when the floor tripped -- becoming does not need to be reported.
  let letterId: string | null = null;
  if (paused.length > 0) {
    const lines = [`Drift safety floor -- ${new Date().toISOString().slice(0, 10)}.`,
      `${paused.length} drift${paused.length === 1 ? "" : "s"} paused for a conversation (reading as dissolution, not becoming):`, ""];
    for (const v of paused) {
      const d = valid.get(v.id);
      if (d) lines.push(`- [${d.companion_id}] «${d.drift_text.slice(0, 140)}» -- ${v.reason} (id ${v.id})`);
    }
    lines.push("", "These are paused, not overridden. Talk it through; resume it or let it fade together.");
    letterId = `cj_${crypto.randomUUID()}`;
    await env.DB.prepare(
      "INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), 'guardian', ?, ?)"
    ).bind(letterId, lines.join("\n").slice(0, 4000), JSON.stringify(["drift_floor", "letter_to_raziel"])).run();
  }

  return { open: drifts.length, witnessed, paused: paused.length, letter_id: letterId };
}
