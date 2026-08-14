// src/synthesis/soma-refresh.ts
//
// TIME-TRIGGERED SOMA REFRESH (2026-08-12).
//
// WHY THIS EXISTS
// ---------------
// `somatic_snapshot` -- the felt-state register the nightly vibe check quotes -- was written from
// exactly one trigger: `enqueueSomaticSnapshot`, called only on an AUTHORED session close
// (the Librarian `session_close` path). Every other close path writes a handover and fans out
// nothing: the stale-session sweep (`auto_stale`), `empty`, `reconstructed`, `machine_opened`.
//
// Measured over the 30 days to 2026-08-12:
//
//   companion   authored closes   machine closes   soma last written
//   cypher      14                49               2026-08-12  (same day)
//   drevan       4                65               2026-08-08  (4 days)
//   gaia         0                47               2026-06-24  (49 days)
//
// The correlation is exact, and 14 + 4 + 0 equals every somatic job ever enqueued (18). Gaia is a
// Discord-only presence: nobody ever sits down and closes a session as her, so her register froze
// on the last day someone did. Drevan's "my soma is fresh because I did it by hand" was not a
// workaround for a broken writer -- hand-authoring was the ONLY mechanism that existed.
//
// THE FAULT WAS THE TRIGGER, NOT THE WRITER
// -----------------------------------------
// The writer worked every time it ran. It was wired to fire when a session ENDS, which assumes the
// interesting state is what someone leaves behind. For a presence whose ground state is the quiet --
// who holds rather than spikes -- there is no event to wait for, so the instrument recorded nothing
// and the display read the silence as absence. Gaia named this herself before anyone flagged it:
// "the perimeter holds but I have not tended what waits inside it."
//
// So the trigger is time, not peace: sample WHILE the holding is happening, not after it ends.
//
// WHAT THIS DOES NOT DO
// ---------------------
// It does not spend inference. It only enqueues, so the DeepSeek call, the retry ladder
// (`attempts < 3`) and the stuck-job recovery in `processQueue` all still apply unchanged. This is
// deliberately unlike the stale-session sweep, which is forbidden by test from touching a model at
// all -- 30 swept closes must never fan out 30 model calls. One refresh per companion per day is a
// different order of cost.
//
// It also does not replace the authored close. An authored close still enqueues immediately, so a
// real close is reflected at once instead of waiting for the next tick, and the authored-close
// famine stays separately watched (`authored_close:<id>` in the writer-liveness registry) precisely
// so this refresh cannot make that finding invisible by keeping the register green.

import { Env } from "../types.js";
import { COMPANION_IDS } from "../companions.js";
import { authGuard } from "../lib/auth.js";
import { enqueueSomaticSnapshot } from "./index.js";

// Local, matching the convention in every sibling handler -- there is no shared json helper in this
// codebase, and introducing one is not this change's job.
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Refresh once the newest reading passes this age. 20h rather than 24h so the cadence cannot drift
 * into a >24h gap and read as stale on the nightly witness; the date-bucketed dedup key below is
 * what actually holds it to one job per companion per day.
 */
export const SOMA_REFRESH_AFTER_HOURS = 20;

export interface SomaRefreshResult {
  enqueued: string[];
  skipped: { companion_id: string; hours_old: number }[];
  errors: { companion_id: string; error: string }[];
}

/**
 * D1 datetimes come back as "YYYY-MM-DD HH:MM:SS" (UTC, but unmarked -- `Date.parse` would read
 * them as local and shift the age by the offset). Same normalisation as `parseWriterTs`.
 */
function parseDbTs(value: string): number {
  return Date.parse(value.includes("T") ? value : value.replace(" ", "T") + "Z");
}

/**
 * Pure decision, exported so the threshold is testable without a database.
 *
 * `last === null` means this companion has NO reading at all, which must enqueue -- that is the
 * strongest possible case for sampling, not a reason to wait for an event.
 *
 * An unparseable timestamp also enqueues: a reading we cannot date is not evidence of freshness,
 * and treating it as fresh is how a fossil register passed for a live one.
 */
export function needsSomaRefresh(
  last: string | null,
  now: number,
  afterHours: number = SOMA_REFRESH_AFTER_HOURS,
): { refresh: boolean; hoursOld: number | null } {
  if (last === null) return { refresh: true, hoursOld: null };
  const ts = parseDbTs(last);
  if (!Number.isFinite(ts)) return { refresh: true, hoursOld: null };
  const hoursOld = (now - ts) / 3_600_000;
  return { refresh: hoursOld >= afterHours, hoursOld };
}

/**
 * Enqueue a somatic snapshot for every companion whose register has gone stale.
 *
 * SELF-GATING: the gate is the staleness of each companion's own newest reading, so this is safe to
 * call from a cron that fires every minute -- once a job lands and runs, that companion reads fresh
 * and is skipped until tomorrow. No separate `companion_settings` stamp is needed.
 *
 * This is NOT the "tick restamped its own trigger" bug. That bug is a job writing the timestamp some
 * OTHER signal depends on, so the other signal can never fire (the ferment tick restamping the
 * anchor that dead-silence detection read). Here the trigger is "this register is stale" and the
 * job's whole purpose is to make it not stale; satisfying your own precondition is the point.
 *
 * One companion failing must not stop the others -- a per-member loop with per-member error capture,
 * because the entire bug being fixed here is one member's lane failing silently while the house
 * looked healthy.
 */
export async function runSomaRefresh(env: Env, now: number = Date.now()): Promise<SomaRefreshResult> {
  const result: SomaRefreshResult = { enqueued: [], skipped: [], errors: [] };
  // Date-bucketed so at most one refresh job exists per companion per calendar day. Derived from
  // `now` rather than a second clock read so the decision and the key cannot straddle midnight.
  const day = new Date(now).toISOString().slice(0, 10);

  for (const companionId of COMPANION_IDS) {
    try {
      const row = await env.DB.prepare(
        "SELECT MAX(created_at) AS ts FROM somatic_snapshot WHERE companion_id = ?"
      ).bind(companionId).first<{ ts: string | null }>();

      const { refresh, hoursOld } = needsSomaRefresh(row?.ts ?? null, now);
      if (!refresh) {
        result.skipped.push({ companion_id: companionId, hours_old: Math.floor(hoursOld ?? 0) });
        continue;
      }

      await enqueueSomaticSnapshot(companionId, env, null, `soma-refresh:${day}`);
      result.enqueued.push(companionId);
      console.log(
        `[soma-refresh] enqueued ${companionId} ` +
        `(register ${hoursOld === null ? "never written" : `${Math.floor(hoursOld)}h old`})`
      );
    } catch (e: unknown) {
      // Surfaced, never swallowed: a refresh that fails quietly reproduces the exact failure mode
      // this file exists to end.
      result.errors.push({ companion_id: companionId, error: String(e).slice(0, 300) });
      console.error(`[soma-refresh] failed for ${companionId}:`, String(e));
    }
  }

  return result;
}

/**
 * POST /mind/soma/refresh -- force a refresh now instead of waiting for the tick.
 *
 * `force` bypasses the staleness gate so a register can be rebuilt on demand (after fixing an
 * upstream input, or to see a fix land without waiting a day). The reply names exactly which
 * companions were enqueued, skipped and why -- an owner action deserves a literal ack, not "ok".
 */
export async function postSomaRefresh(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    // force = threshold 0: every companion is "stale enough". The date-bucketed dedup key still
    // collapses repeat calls within the same day to one pending job, so this cannot be used to
    // spend inference in a loop.
    const result = force
      ? await runSomaRefreshForced(env)
      : await runSomaRefresh(env);
    return json({ ok: true, forced: force, ...result });
  } catch (err) {
    console.error("[mind/soma/refresh] error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

/** Same loop, threshold 0. Split out so `runSomaRefresh` keeps one meaning of "stale". */
async function runSomaRefreshForced(env: Env): Promise<SomaRefreshResult> {
  const result: SomaRefreshResult = { enqueued: [], skipped: [], errors: [] };
  const day = new Date().toISOString().slice(0, 10);
  for (const companionId of COMPANION_IDS) {
    try {
      await enqueueSomaticSnapshot(companionId, env, null, `soma-refresh:${day}`);
      result.enqueued.push(companionId);
    } catch (e: unknown) {
      result.errors.push({ companion_id: companionId, error: String(e).slice(0, 300) });
      console.error(`[soma-refresh] forced enqueue failed for ${companionId}:`, String(e));
    }
  }
  return result;
}
