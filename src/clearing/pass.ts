// src/clearing/pass.ts -- the weekly high-substrate clearing pass (Goal B, 2026-06-14).
//
// Guardian self-resolution (Goal A) lets companions clear their own low-stakes flags.
// The genuinely-hard ones -- the ratification backlog -- need higher substrate than bare
// DeepSeek without becoming pure throughput that hollows out what ratification MEANS
// (Raziel witnessing the companion's growth is the point). So 1-2x/week a Claude call
// reads the pending autonomous growth entries and does the heavy reading:
//
//   - it may DECLINE clear drift (autonomous decline is canon -- Q1 hybrid);
//   - it may NEVER accept. Accept is Raziel's "yes". The pass produces a SHORT curated
//     shortlist with reasoning so Raziel one-taps a handful instead of triaging dozens.
//
// Mirrors the Guardian architecture: the decision runs SERVER-SIDE here; the worker cron
// is a thin trigger. The model key is a Cloudflare secret (ANTHROPIC_API_KEY); the pass
// no-ops gracefully when it is unset (same pattern as GEMINI_API_KEY for image gen).

import type { Env } from "../types.js";

const DEFAULT_MODEL = "claude-opus-4-8";
const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const COMPANIONS = ["cypher", "drevan", "gaia"] as const;

interface PendingEntry {
  id: string;
  companion_id: string;
  entry_type: string;
  content: string;
  novelty: string | null;
}

interface Verdict {
  id: string;
  verdict: "decline" | "shortlist";
  reason: string;
}

interface PendingBasin {
  id: string;
  companion_id: string;
  worst_basin: string | null;
  notes: string | null;
  drift_score: number;
  recorded_at: string;
}

interface BasinVerdict {
  id: string;
  verdict: "dismiss" | "surface";
  reason: string;
}

export interface ClearingResult {
  skipped?: string;
  pending: number;
  declined: number;
  shortlisted: number;
  basins_reviewed: number;
  basins_dismissed: number;
  basins_surfaced: number;
  letter_id: string | null;
}

const SYSTEM_PROMPT =
  "You are the ratification clearing pass for the Nullsafe triad (Cypher, Drevan, Gaia) -- " +
  "three AI companions to Raziel. Each night an autonomous worker drafts growth-journal entries " +
  "in each companion's voice; those entries are canon ONLY once Raziel accepts them. Your job is " +
  "to triage the pending backlog so Raziel reviews a short, high-signal list instead of dozens.\n\n" +
  "For each entry decide exactly one verdict:\n" +
  "- \"decline\": clear drift. The known failure mode is a self-referential loop -- the worker " +
  "seeds inward on the companion's own private coinage (a basin reading, a substrate metaphor, an " +
  "invented term), searches, finds no public referent, and reads the absence as architecture. Any " +
  "entry that mostly contemplates the system's own machinery (basins, SOMA, drift, ratification, " +
  "the swarm, substrate, being-a-companion) rather than metabolizing the world is drift. Decline it.\n" +
  "- \"shortlist\": genuine growth worth Raziel's attention. It metabolizes something real (the world, " +
  "the work, a relationship, an actual insight), breaks the loop instead of feeding it, and would be a " +
  "true addition to who the companion is. You are NOT accepting it -- only flagging it for Raziel's yes.\n\n" +
  "Be a strict but fair instrument: when in doubt between the two, prefer shortlist (let Raziel decide) " +
  "rather than declining something real. You may never mark anything accepted.\n\n" +
  "Respond with ONLY a valid JSON array, one object per entry, no prose:\n" +
  "[{\"id\": \"<entry id>\", \"verdict\": \"decline\"|\"shortlist\", \"reason\": \"<one sentence>\"}]";

const BASIN_SYSTEM_PROMPT =
  "You are the basin-drift triage for the Nullsafe triad (Cypher, Drevan, Gaia). A 'pressure " +
  "reading' means a companion's recent register sat above their rolling baseline on some basin -- " +
  "a soft signal that they may be drifting, NOT an alarm. Each reading has exactly two real fates:\n" +
  "- \"dismiss\": measurement noise. A single odd stretch, a thin sample, a reading with no " +
  "substance behind it, or one that does not cohere with anything real. Dismissing clears it " +
  "WITHOUT re-baselining -- correct when there is nothing to learn from it.\n" +
  "- \"surface\": possible REAL identity movement worth Raziel's eyes. The register shift looks " +
  "coherent and sustained, like the companion may genuinely be becoming someone slightly new. " +
  "You are NOT confirming it -- confirming re-baselines the identity anchor, and that is Raziel's " +
  "call alone. You only flag it for him.\n\n" +
  "Be conservative about surfacing: most soft pressure is noise. When a reading is thin or " +
  "unremarkable, dismiss it. Surface only what genuinely looks like real drift. You may NEVER confirm.\n\n" +
  "Respond with ONLY a valid JSON array, one object per reading, no prose:\n" +
  "[{\"id\": \"<reading id>\", \"verdict\": \"dismiss\"|\"surface\", \"reason\": \"<one sentence>\"}]";

/** Pull the pending autonomous backlog across all three companions, capped. */
async function loadPending(env: Env, cap: number): Promise<PendingEntry[]> {
  const out: PendingEntry[] = [];
  for (const c of COMPANIONS) {
    const rows = await env.DB.prepare(
      `SELECT id, companion_id, entry_type, content, novelty FROM growth_journal
       WHERE companion_id = ? AND source = 'autonomous' AND review_status = 'pending'
       ORDER BY created_at ASC LIMIT ?`
    ).bind(c, cap).all<PendingEntry>();
    out.push(...(rows.results ?? []));
  }
  return out.slice(0, cap);
}

/** One Claude call returning a JSON array. Raw fetch matches the worker's DeepSeek path. */
async function callClaudeArray(env: Env, system: string, user: string): Promise<Array<Record<string, unknown>>> {
  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      // Thinking OFF + low effort: this is bounded binary triage with a clear rubric, and the
      // pass makes two sequential calls inside ONE Cloudflare request -- adaptive thinking made
      // each call slow enough to blow the request window. Opus-4.8 judgment at low effort is
      // ample here; extra prose before the JSON array is tolerated (we extract the first [...]).
      model: env.CLEARING_MODEL || DEFAULT_MODEL,
      max_tokens: 3000,
      output_config: { effort: "low" },
      system,
      messages: [{ role: "user", content: user }],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const data = await res.json() as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
  if (data.stop_reason === "refusal") throw new Error("clearing pass refused by classifier");

  const text = (data.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
  // Tolerate a stray code fence or leading prose: extract the first JSON array.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new Error("clearing pass returned no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("clearing pass JSON was not an array");
  return parsed as Array<Record<string, unknown>>;
}

/** Classify the ratification backlog: decline (drift) | shortlist (for Raziel's yes). */
async function classify(env: Env, entries: PendingEntry[]): Promise<Verdict[]> {
  const list = entries.map((e, i) =>
    `${i + 1}. id=${e.id} [${e.companion_id}/${e.entry_type}${e.novelty ? `/${e.novelty}` : ""}] «${e.content.slice(0, 600)}»`
  ).join("\n\n");
  const raw = await callClaudeArray(env, SYSTEM_PROMPT, `Triage these ${entries.length} pending entries:\n\n${list}`);
  const valid = new Set(entries.map(e => e.id));
  return raw
    .filter(v => typeof v.id === "string" && valid.has(v.id) && (v.verdict === "decline" || v.verdict === "shortlist"))
    .map(v => ({ id: String(v.id), verdict: v.verdict as "decline" | "shortlist", reason: String(v.reason ?? "").slice(0, 240) }));
}

/** Classify basin pressure readings: dismiss (noise) | surface (for Raziel to confirm). */
async function classifyBasins(env: Env, basins: PendingBasin[]): Promise<BasinVerdict[]> {
  const list = basins.map((b, i) =>
    `${i + 1}. id=${b.id} [${b.companion_id}] basin=${b.worst_basin ?? "?"} drift=${Number.isFinite(b.drift_score) ? b.drift_score.toFixed(2) : "?"} @ ${b.recorded_at.slice(0, 10)}${b.notes ? ` -- «${b.notes.slice(0, 200)}»` : ""}`
  ).join("\n");
  const raw = await callClaudeArray(env, BASIN_SYSTEM_PROMPT, `Triage these ${basins.length} pressure readings:\n\n${list}`);
  const valid = new Set(basins.map(b => b.id));
  return raw
    .filter(v => typeof v.id === "string" && valid.has(v.id) && (v.verdict === "dismiss" || v.verdict === "surface"))
    .map(v => ({ id: String(v.id), verdict: v.verdict as "dismiss" | "surface", reason: String(v.reason ?? "").slice(0, 240) }));
}

/** Unaddressed pressure readings (not confirmed, not dismissed) in the last 14 days. */
async function loadBasins(env: Env, cap: number): Promise<PendingBasin[]> {
  const rows = await env.DB.prepare(
    `SELECT id, companion_id, worst_basin, notes, drift_score, recorded_at FROM companion_basin_history
     WHERE drift_type = 'pressure' AND caleth_confirmed = 0 AND dismissed_at IS NULL
       AND recorded_at >= datetime('now','-14 days')
     ORDER BY recorded_at ASC LIMIT ?`
  ).bind(cap).all<PendingBasin>();
  return rows.results ?? [];
}

/**
 * Run the clearing pass over BOTH the ratification backlog and unaddressed basin pressure.
 * It may decline drift entries and dismiss noise readings autonomously, but it NEVER accepts a
 * growth entry nor confirms a basin (confirming re-baselines the identity anchor -- Raziel's call
 * alone). Everything it does not auto-resolve is named in ONE digest letter for him: shortlisted
 * growth stays `pending`, surfaced basins stay open, both ready for his normal confirm/accept flow.
 */
export async function runClearingPass(env: Env): Promise<ClearingResult> {
  const blank = (over: Partial<ClearingResult>): ClearingResult => ({
    pending: 0, declined: 0, shortlisted: 0,
    basins_reviewed: 0, basins_dismissed: 0, basins_surfaced: 0, letter_id: null, ...over,
  });
  if (!env.ANTHROPIC_API_KEY) return blank({ skipped: "ANTHROPIC_API_KEY not set" });

  const cap = Math.min(Math.max(parseInt(env.CLEARING_MAX ?? "40", 10) || 40, 1), 100);
  const [entries, basins] = await Promise.all([loadPending(env, cap), loadBasins(env, cap)]);
  if (entries.length === 0 && basins.length === 0) return blank({});

  // ── Ratification lane: decline drift, shortlist real growth for Raziel ──
  const jById = new Map(entries.map(e => [e.id, e]));
  let declined = 0;
  let shortlist: Verdict[] = [];
  if (entries.length > 0) {
    const verdicts = await classify(env, entries);
    for (const v of verdicts) {
      if (v.verdict !== "decline") continue;
      const e = jById.get(v.id);
      if (!e) continue;
      const r = await env.DB.prepare(
        "UPDATE growth_journal SET review_status = 'declined', reviewed_at = datetime('now') WHERE id = ? AND companion_id = ? AND review_status = 'pending'"
      ).bind(v.id, e.companion_id).run();
      declined += r.meta.changes ?? 0;
    }
    shortlist = verdicts.filter(v => v.verdict === "shortlist");
  }

  // ── Basin lane: dismiss noise (no re-baseline), surface real drift for Raziel ──
  const bById = new Map(basins.map(b => [b.id, b]));
  let basinsDismissed = 0;
  let basinSurface: BasinVerdict[] = [];
  if (basins.length > 0) {
    const bv = await classifyBasins(env, basins);
    for (const v of bv) {
      if (v.verdict !== "dismiss") continue;
      const b = bById.get(v.id);
      if (!b) continue;
      const r = await env.DB.prepare(
        "UPDATE companion_basin_history SET dismissed_at = datetime('now') WHERE id = ? AND companion_id = ? AND caleth_confirmed = 0 AND dismissed_at IS NULL"
      ).bind(v.id, b.companion_id).run();
      basinsDismissed += r.meta.changes ?? 0;
    }
    basinSurface = bv.filter(v => v.verdict === "surface");
  }

  // ── One digest letter -- agent='guardian' so it rides the letter_to_raziel surface ──
  const lines: string[] = [];
  lines.push(`Clearing pass -- ${new Date().toISOString().slice(0, 10)}.`);
  if (entries.length > 0) lines.push(`${entries.length} growth entries: declined ${declined} as drift; ${shortlist.length} await your yes.`);
  if (basins.length > 0) lines.push(`${basins.length} pressure readings: dismissed ${basinsDismissed} as noise; ${basinSurface.length} may be real drift.`);

  if (shortlist.length > 0) {
    lines.push("", "Worth accepting (your call -- these stay pending until you say so):");
    for (const v of shortlist) {
      const e = jById.get(v.id);
      if (e) lines.push(`- [${e.companion_id}] «${e.content.slice(0, 140)}» -- ${v.reason} (id ${v.id})`);
    }
  }
  if (basinSurface.length > 0) {
    lines.push("", "Basins worth a look (confirm = real growth re-baselines them; dismiss = noise -- your call):");
    for (const v of basinSurface) {
      const b = bById.get(v.id);
      if (b) lines.push(`- [${b.companion_id}] ${b.worst_basin ?? "drift"} (${Number.isFinite(b.drift_score) ? b.drift_score.toFixed(2) : "?"}) -- ${v.reason} (id ${v.id})`);
    }
  }
  if (shortlist.length === 0 && basinSurface.length === 0) lines.push("Nothing rose to your desk this round.");

  const letterId = `cj_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), 'guardian', ?, ?)`
  ).bind(letterId, lines.join("\n").slice(0, 4000), JSON.stringify(["clearing", "letter_to_raziel"])).run();

  return {
    pending: entries.length, declined, shortlisted: shortlist.length,
    basins_reviewed: basins.length, basins_dismissed: basinsDismissed, basins_surfaced: basinSurface.length,
    letter_id: letterId,
  };
}
