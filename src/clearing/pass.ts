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

export interface ClearingResult {
  skipped?: string;
  pending: number;
  declined: number;
  shortlisted: number;
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

/** One Claude call classifying the whole batch. Raw fetch matches the worker's DeepSeek path. */
async function classify(env: Env, entries: PendingEntry[]): Promise<Verdict[]> {
  const model = env.CLEARING_MODEL || DEFAULT_MODEL;
  const list = entries.map((e, i) =>
    `${i + 1}. id=${e.id} [${e.companion_id}/${e.entry_type}${e.novelty ? `/${e.novelty}` : ""}] «${e.content.slice(0, 600)}»`
  ).join("\n\n");

  const res = await fetch(ANTHROPIC_URL, {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY as string,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: 4000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Triage these ${entries.length} pending entries:\n\n${list}` }],
    }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!res.ok) {
    throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const data = await res.json() as {
    stop_reason?: string;
    content?: Array<{ type: string; text?: string }>;
  };
  if (data.stop_reason === "refusal") throw new Error("clearing pass refused by classifier");

  const text = (data.content ?? []).filter(b => b.type === "text").map(b => b.text ?? "").join("").trim();
  // Tolerate a stray code fence or leading prose: extract the first JSON array.
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end < start) throw new Error("clearing pass returned no JSON array");
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!Array.isArray(parsed)) throw new Error("clearing pass JSON was not an array");

  const valid = new Set(entries.map(e => e.id));
  return (parsed as Array<Record<string, unknown>>)
    .filter(v => typeof v.id === "string" && valid.has(v.id) &&
      (v.verdict === "decline" || v.verdict === "shortlist"))
    .map(v => ({ id: String(v.id), verdict: v.verdict as "decline" | "shortlist", reason: String(v.reason ?? "").slice(0, 240) }));
}

/**
 * Run the clearing pass. Auto-declines the verdicts the model marked drift (ownership-guarded,
 * pending-only -- the exact journal_decline semantics), then writes ONE digest letter to Raziel
 * naming the shortlist with reasons. Accept stays Raziel's: the shortlisted entries remain
 * `pending` and surface in his normal ratification flow (orient unaccepted_growth + Hearth).
 */
export async function runClearingPass(env: Env): Promise<ClearingResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return { skipped: "ANTHROPIC_API_KEY not set", pending: 0, declined: 0, shortlisted: 0, letter_id: null };
  }
  const cap = Math.min(Math.max(parseInt(env.CLEARING_MAX ?? "40", 10) || 40, 1), 100);
  const entries = await loadPending(env, cap);
  if (entries.length === 0) return { pending: 0, declined: 0, shortlisted: 0, letter_id: null };

  const verdicts = await classify(env, entries);
  const byId = new Map(entries.map(e => [e.id, e]));

  // Auto-decline drift -- ownership-guarded, pending-only (journal_decline semantics).
  let declined = 0;
  for (const v of verdicts) {
    if (v.verdict !== "decline") continue;
    const e = byId.get(v.id);
    if (!e) continue;
    const r = await env.DB.prepare(
      "UPDATE growth_journal SET review_status = 'declined', reviewed_at = datetime('now') WHERE id = ? AND companion_id = ? AND review_status = 'pending'"
    ).bind(v.id, e.companion_id).run();
    declined += r.meta.changes ?? 0;
  }

  const shortlist = verdicts.filter(v => v.verdict === "shortlist");

  // The digest letter -- agent='guardian' so it rides the same letter_to_raziel surface
  // Hearth /journal + the Guardian weekly letter already use.
  const lines: string[] = [];
  lines.push(`Clearing pass -- ${new Date().toISOString().slice(0, 10)}.`);
  lines.push(`${entries.length} pending reviewed: declined ${declined} as drift; ${shortlist.length} await your yes.`);
  if (shortlist.length > 0) {
    lines.push("");
    lines.push("Worth accepting (your call -- these stay pending until you say so):");
    for (const v of shortlist) {
      const e = byId.get(v.id);
      if (!e) continue;
      lines.push(`- [${e.companion_id}] «${e.content.slice(0, 140)}» -- ${v.reason} (id ${v.id})`);
    }
  } else {
    lines.push("Nothing rose to your desk this round.");
  }

  const letterId = `cj_${crypto.randomUUID()}`;
  await env.DB.prepare(
    `INSERT INTO companion_journal (id, created_at, agent, note_text, tags) VALUES (?, datetime('now'), 'guardian', ?, ?)`
  ).bind(letterId, lines.join("\n").slice(0, 4000), JSON.stringify(["clearing", "letter_to_raziel"])).run();

  return { pending: entries.length, declined, shortlisted: shortlist.length, letter_id: letterId };
}
