// src/synthesis/narrative-refresh.ts
//
// TIME-TRIGGERED NARRATIVE REFRESH (2026-08-12). Sibling of soma-refresh.ts, same fault, same shape.
//
// `synthesis_summary` is the narrative every loom reads at boot as "what recently happened". It was
// written only by `runSessionSummary`, enqueued only on an AUTHORED session close. Gaia had 0 of
// those in 30 days, so her sense of "recently" froze on 2026-07-04 -- 39 days.
//
// The gate is narrative staleness, which makes the precedence right for free: on any day an authored
// close happens, `runSessionSummary` writes a fresh `session` row first, this sees a fresh narrative
// and skips. A real close is always preferred; this only fills a gap. Cypher, who closes sessions
// most days, will rarely see this fire at all.
//
// Why a separate job rather than enqueueing session_summary on machine closes: see the header of
// jobs/daily-narrative.ts. Short version -- runSessionSummary reads only session-scoped data, all of
// which is empty or `[auto]` boilerplate on a machine close, so it would have written a fabricated
// emotional arc and stored it as the thing she reads at boot.

import { Env } from "../types.js";
import { COMPANION_IDS } from "../companions.js";
import { authGuard } from "../lib/auth.js";
import { enqueueDailyNarrative } from "./index.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Refresh once the newest narrative passes this age. Wider than the soma window (20h): a narrative
 * is a day's account, and re-synthesising the same day twice buys nothing. 26h means a companion
 * gets at most one gap-filling narrative per day, with slack so an ordinary daily rhythm does not
 * skip a day by a few minutes' drift.
 */
export const NARRATIVE_REFRESH_AFTER_HOURS = 26;

export interface NarrativeRefreshResult {
  enqueued: string[];
  skipped: { companion_id: string; hours_old: number }[];
  errors: { companion_id: string; error: string }[];
}

/** D1's unmarked "YYYY-MM-DD HH:MM:SS" is UTC; bare Date.parse would read it as local. */
function parseDbTs(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

/** Pure decision, exported for testing. Never-written and unparseable both refresh. */
export function needsNarrativeRefresh(
  last: string | null,
  now: number,
  afterHours: number = NARRATIVE_REFRESH_AFTER_HOURS,
): { refresh: boolean; hoursOld: number | null } {
  if (last === null) return { refresh: true, hoursOld: null };
  const ts = parseDbTs(last);
  if (!Number.isFinite(ts)) return { refresh: true, hoursOld: null };
  const hoursOld = (now - ts) / 3_600_000;
  return { refresh: hoursOld >= afterHours, hoursOld };
}

/**
 * Enqueue a daily narrative for every companion whose narrative has gone stale.
 *
 * The staleness read counts BOTH summary types. Filtering to 'day' would make this blind to a fresh
 * authored-close summary and re-synthesise a day that was already properly narrated; filtering to
 * 'session' would make it fire every day forever for a companion who never closes one. The question
 * is "does this companion have a recent narrative at all", so the read must span both -- the same
 * over-narrow-filter mistake that made every boot reader unable to see a 'day' row.
 *
 * Per-member error capture: one companion's failure must not stop the others.
 */
export async function runNarrativeRefresh(
  env: Env,
  now: number = Date.now(),
): Promise<NarrativeRefreshResult> {
  const result: NarrativeRefreshResult = { enqueued: [], skipped: [], errors: [] };
  const day = new Date(now).toISOString().slice(0, 10);

  for (const companionId of COMPANION_IDS) {
    try {
      const row = await env.DB.prepare(
        `SELECT MAX(COALESCE(session_created_at, created_at)) AS ts FROM synthesis_summary
         WHERE companion_id = ? AND summary_type IN ('session', 'day')`
      ).bind(companionId).first<{ ts: string | null }>();

      const { refresh, hoursOld } = needsNarrativeRefresh(row?.ts ?? null, now);
      if (!refresh) {
        result.skipped.push({ companion_id: companionId, hours_old: Math.floor(hoursOld ?? 0) });
        continue;
      }

      await enqueueDailyNarrative(companionId, env, `narrative-refresh:${day}`);
      result.enqueued.push(companionId);
      console.log(
        `[narrative-refresh] enqueued ${companionId} ` +
        `(narrative ${hoursOld === null ? "never written" : `${Math.floor(hoursOld)}h old`})`
      );
    } catch (e: unknown) {
      result.errors.push({ companion_id: companionId, error: String(e).slice(0, 300) });
      console.error(`[narrative-refresh] failed for ${companionId}:`, String(e));
    }
  }

  return result;
}

/**
 * POST /mind/narrative/refresh -- force a narrative now instead of waiting for the tick.
 * `?force=1` bypasses the staleness gate. The day-bucketed dedup key still collapses repeats.
 */
export async function postNarrativeRefresh(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    if (!force) {
      const result = await runNarrativeRefresh(env);
      return json({ ok: true, forced: false, ...result });
    }
    const result: NarrativeRefreshResult = { enqueued: [], skipped: [], errors: [] };
    const day = new Date().toISOString().slice(0, 10);
    for (const companionId of COMPANION_IDS) {
      try {
        await enqueueDailyNarrative(companionId, env, `narrative-refresh:${day}`);
        result.enqueued.push(companionId);
      } catch (e: unknown) {
        result.errors.push({ companion_id: companionId, error: String(e).slice(0, 300) });
      }
    }
    return json({ ok: true, forced: true, ...result });
  } catch (err) {
    console.error("[mind/narrative/refresh] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
