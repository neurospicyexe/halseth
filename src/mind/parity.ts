// src/mind/parity.ts
//
// Bot-orient parity sampler: the data-collection phase for the NEXT loom cutover.
//
// WHY THIS EXISTS
// ---------------
// Hearth cut over to loadMindState on 2026-07-29 on the strength of a point-in-time parity diff --
// legitimate, because Hearth renders on demand and its payload is small. `execBotOrient` is not that
// case. It runs ~20x more often than any other orient path, it is the one that got fixed TWICE for
// saturation, and its content depends on live conversational state that a single 9pm snapshot cannot
// represent. So its cutover needs parity evidence over real traffic across real days.
//
// The trap that motivated building this now rather than later: "needs traffic data" plus "let's come
// back to it" equals a wait that has not started. Deferring the cutover is correct; deferring the
// COLLECTION just moves the same delay to a worse moment. This runs from tonight, so when the
// cutover comes up the evidence is already there. Raziel's rule: anything you have to remember is a
// defect -- that applies to remembering to start measuring, too.
//
// MEASURING MUST NOT MOVE THE MEASURED
// ------------------------------------
// Both sides run readOnly. execBotOrient warms wm_continuity_notes + synthesis_summary heat and
// stamps companion_questions.delivered_at; sampling it live would mean ~72 writes/day generated
// purely by observation, warming exactly the heat ranking that decides what orient surfaces next.
// That is the read-writes-the-ranking antipattern. Hence the readOnly flag added to execBotOrient
// alongside this file, and hence loadMindState (already a pure read by covenant) needing nothing.
//
// NO SCHEMA
// ---------
// Results go to the log, not a table -- the migration freeze is still on until the loader lands, and
// a diagnostics table would be exactly the kind of organ the freeze exists to stop. One compact line
// per companion per run, queryable via Cloudflare Workers observability. `GET /mind/parity/bot/:id`
// returns the same comparison on demand for a live look.

import type { Env } from "../types.js";
import type { WmAgentId } from "../webmind/types.js";
import { COMPANION_IDS } from "../companions.js";
import { loadMindState } from "./loader.js";
import { execBotOrient } from "../librarian/executors/session.js";

/** Self-gate cadence. Hourly: frequent enough to catch conversational variation, rare enough that
 *  the sample cost is nothing against the bots' own call volume. */
const SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
const GATE_KEY = "bot_parity_sampled_at";

/** companion_settings pseudo-companion for system-wide stamps. `_system` (underscore) is the
 *  convention salience-prune already established; the first cut of this file used "system" and
 *  created a SECOND convention for the same row, which the health check would then have had to know
 *  about. One spelling. */
const SYSTEM_ROW = "_system";

/**
 * One comparable field. `bot` and `ms` each project their side to a stable primitive so the diff is
 * about CONTENT, not key names -- the two shapes are deliberately different (a flat wire format vs
 * the nested contract), so a structural diff would report noise forever.
 *
 * Deliberately NOT compared: blocks the loader does not fill yet (contract.ts NOT_YET_LOADED). They
 * would report as missing on every run and train us to ignore the output. `missing_blocks` counts
 * them separately so the gap is visible as a number instead of as noise.
 */
interface FieldProbe {
  name: string;
  bot: (o: Record<string, unknown>) => unknown;
  ms: (m: Awaited<ReturnType<typeof loadMindState>>) => unknown;
}

const asText = (v: unknown): string => (typeof v === "string" ? v.trim() : v == null ? "" : String(v));
const count = (v: unknown): number => (Array.isArray(v) ? v.length : 0);

/**
 * Probes written against the payload the bot ACTUALLY returns (read via `?shape=1`, not inferred).
 *
 * The bot wire format is FLAT where the contract is nested -- `identity_anchor` is a string(53), not
 * an object; `ground_handoff` is rendered prose, string(256), not a row. Writing these by reading the
 * 592-line function produced three wrong accessors that all reported "" and looked like real
 * mismatches. Read the shape; do not infer it.
 *
 * Presence-vs-equality is deliberate per field: comparing `ground_handoff` (prose) to
 * `latest_handoff.handoff_id` is a category error and would mismatch forever. Where the two formats
 * are genuinely different renderings of the same fact, the probe compares WHETHER the fact is there.
 */
const PROBES: FieldProbe[] = [
  {
    // Direct equality: the bot's flat `identity_anchor` string IS the contract's anchor_summary.
    name: "anchor_summary",
    bot: (o) => asText(o.identity_anchor),
    ms: (m) => asText(m.identity.anchor?.anchor_summary),
  },
  {
    // Presence, not equality: bot renders the handoff as prose, the contract carries the row.
    name: "handoff_present",
    bot: (o) => asText(o.ground_handoff).length > 0,
    ms: (m) => m.continuity.latest_handoff !== null,
  },
  { name: "tension_count",    bot: (o) => count(o.active_tensions),   ms: (m) => count(m.carried.tensions) },
  { name: "dream_count",      bot: (o) => count(o.unexamined_dreams), ms: (m) => count(m.carried.dreams_unexamined) },
  { name: "open_loop_count",  bot: (o) => count(o.open_loops),        ms: (m) => count(m.carried.open_loops) },
  { name: "flagged_count",    bot: (o) => count(o.flagged_beliefs),   ms: (m) => count(m.beliefs.flagged) },
  {
    // KNOWN STRUCTURAL DIVERGENCE, kept as a probe on purpose so it is measured rather than assumed
    // stable (2026-07-29, first run: bot 6 vs loader 2 for all three companions).
    //
    // execBotOrient:  ONE pooled window, LIMIT 6, ORDER BY created_at DESC
    // loader/mindOrient: per belief_type, 4 x LIMIT 2, ORDER BY effectiveHeatSql()
    //
    // Two consequences, both real. (a) The bot path is the two-pools-one-ordered-window shape: a
    // single ORDER BY + LIMIT serving what should be distributed pools, so the largest belief_type
    // population can take all 6 slots. (b) The bot ranks by RECENCY, so it never benefits from the
    // earned-salience heat mechanic (mig 0105) that the other path uses -- the highest-frequency
    // surface is the one getting the unranked version.
    //
    // Do NOT "fix" this by loosening the loader to LIMIT 6 pooled: distribution is the authored
    // behaviour. But note the flip side before cutting over -- for a companion whose conclusions are
    // all one belief_type, per-type LIMIT 2 shows 2 where the bot showed 6, so the cutover REDUCES
    // what the bots carry. That is a behaviour decision for Raziel, not a silent consequence of a
    // refactor, and finding it is exactly why this sampler exists.
    name: "conclusion_count",
    bot: (o) => count(o.active_conclusions),
    ms: (m) => count(m.beliefs.conclusions),
  },
];

/**
 * Blocks the bot payload simply does not have, so there is nothing to compare. Listed rather than
 * probed: a probe that mismatches on every run forever teaches everyone to ignore the output.
 *
 * `limbic` is the one that matters -- execBotOrient carries NO emotional register at all, while
 * every other surface does. The bots are the highest-frequency presence and the least
 * emotionally-situated one. Worth a decision at cutover time, not a silent inheritance.
 */
export const BOT_MISSING_VS_CONTRACT = ["felt.limbic", "felt.biometrics_latest", "felt.house"] as const;

export interface BotParityResult {
  companion_id: string;
  matched: string[];
  mismatched: Array<{ field: string; bot: unknown; mindstate: unknown }>;
  /** Contract blocks the loader has not implemented yet -- a gap, not a regression. */
  missing_blocks: number;
  error?: string;
  /** Only when requested: the bot payload's own keys and value shapes. Kept because writing probes
   *  against a 592-line function by reading it produced three wrong accessors on the first pass --
   *  the flat wire format returns `identity_anchor` as a STRING, not the nested object orient uses.
   *  Reading the shape beats inferring it. */
  bot_shape?: Record<string, string>;
}

function shapeOf(v: unknown): string {
  if (v === null) return "null";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (typeof v === "object") return `object{${Object.keys(v as object).slice(0, 6).join(",")}}`;
  if (typeof v === "string") return `string(${v.length})`;
  return typeof v;
}

/**
 * Compare execBotOrient (readOnly) against loadMindState for one companion. Pure read on both sides.
 * Exported so `GET /mind/parity/bot/:id` and the cron share exactly one implementation -- the
 * alternative is an endpoint that reports parity the cron does not measure.
 */
export async function compareBotOrient(
  env: Env,
  companionId: WmAgentId,
  opts: { includeShape?: boolean } = {},
): Promise<BotParityResult> {
  const base: BotParityResult = { companion_id: companionId, matched: [], mismatched: [], missing_blocks: 0 };
  try {
    const [botRes, ms] = await Promise.all([
      execBotOrient(
        // execBotOrient reads only env + req off the context; the sampler is not a Librarian request,
        // so the rest of ExecutorContext is deliberately absent rather than faked with plausible
        // values that could mislead a future reader into thinking this is a real companion call.
        { env, req: { companion_id: companionId } } as unknown as Parameters<typeof execBotOrient>[0],
        { readOnly: true },
      ),
      loadMindState(env, companionId, "worker"),
    ]);

    const bot = (botRes?.data ?? {}) as Record<string, unknown>;
    base.missing_blocks = ms.meta.not_yet_loaded.length;
    if (opts.includeShape) {
      base.bot_shape = Object.fromEntries(Object.entries(bot).map(([k, v]) => [k, shapeOf(v)]));
    }

    for (const p of PROBES) {
      const b = p.bot(bot);
      const m = p.ms(ms);
      if (JSON.stringify(b) === JSON.stringify(m)) base.matched.push(p.name);
      else base.mismatched.push({ field: p.name, bot: b, mindstate: m });
    }
    return base;
  } catch (err) {
    // A sampler that dies silently is worse than no sampler: it reports parity by omission.
    base.error = String(err);
    return base;
  }
}

/**
 * Cron entry point. Rides the every-minute cron and self-gates to SAMPLE_INTERVAL_MS via its own
 * companion_settings stamp -- the same shape as runFermentTick / runSaliencePrune.
 *
 * The stamp is written on a SEPARATE key from anything the sample reads, because a periodic job must
 * never write the timestamp its own trigger reads (that bug cost a day on the ferment tick: the tick
 * restamped its own silence anchor and could never detect silence again).
 */
export async function sampleBotOrientParity(env: Env, opts: { force?: boolean } = {}): Promise<void> {
  const now = Date.now();
  if (!opts.force) {
    const row = await env.DB.prepare(
      "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?",
    ).bind(SYSTEM_ROW, GATE_KEY).first<{ value: string }>().catch(() => null);
    const last = row?.value ? Date.parse(row.value) : NaN;
    if (Number.isFinite(last) && now - last < SAMPLE_INTERVAL_MS) return;
  }

  const stamp = new Date(now).toISOString();
  // Stamp FIRST so a throw mid-sample cannot turn this into a hot loop that re-runs every minute.
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(SYSTEM_ROW, GATE_KEY, stamp, stamp).run().catch((e: unknown) => {
    console.warn("[bot-parity] gate stamp failed (non-fatal):", String(e));
  });

  for (const id of COMPANION_IDS) {
    const r = await compareBotOrient(env, id as WmAgentId);
    // One line per companion. Prefix is stable so observability can filter on it:
    //   query_worker_observability filter: "[bot-parity]"
    console.log(
      `[bot-parity] ${r.companion_id} matched=${r.matched.length} mismatched=${r.mismatched.length}` +
      ` missing_blocks=${r.missing_blocks}` +
      (r.error ? ` error=${r.error.slice(0, 120)}` : "") +
      (r.mismatched.length
        ? ` fields=${r.mismatched.map((m) => m.field).join(",")}` +
          ` detail=${JSON.stringify(r.mismatched).slice(0, 400)}`
        : ""),
    );
  }
}
