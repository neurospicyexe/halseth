// src/handlers/health.ts
//
// GET /admin/health -- the DATA half of the standing health check (Phase 1 item 5,
// docs/PLAN-2026-08-to-12-solid-by-december.md; December criterion 6: "Raziel can ask 'is everything
// okay?' and get an answer in one command").
//
// WHAT THIS DELIBERATELY DOES NOT DO
// ----------------------------------
// It does not re-detect data problems. Guardian already does that -- starved_organ, dead_writer,
// ratification_backlog, loop_stuck, burnout, basin_pressure, orphan_memory, echo_chamber -- daily at
// 08:00, writing guardian_flags. Writing a second set of detectors here would be a second authority
// on the same question, which is the exact duplication this whole phase exists to remove. So this
// SUMMARIZES guardian's findings and adds only what guardian cannot see: whether the machinery that
// produces those findings is itself still running.
//
// It also does not check processes (pm2, systemd, the hermes gateways). A liveness check inside its
// own subject is theater: this endpoint cannot report "Halseth is down". That half lives outside, on
// the VPS, and calls this one over HTTP -- so a Halseth outage shows up as an unreachable endpoint
// rather than as a silent absence of complaint.
//
// Every check is a SELECT. Read-only by covenant: a health check that mutates state can cause the
// incident it is supposed to report.

import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { COMPANION_IDS } from "../companions.js";

export type Severity = "ok" | "notice" | "warning" | "red";

const RANK: Record<Severity, number> = { ok: 0, notice: 1, warning: 2, red: 3 };

export interface Check {
  name: string;
  severity: Severity;
  detail: string;
  /** Present when the check is a staleness test, so a reader can see the margin, not just the verdict. */
  age_minutes?: number;
  budget_minutes?: number;
}

function worst(checks: Check[]): Severity {
  return checks.reduce<Severity>((acc, c) => (RANK[c.severity] > RANK[acc] ? c.severity : acc), "ok");
}

function minutesSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  // D1 datetime('now') has no zone marker, so a bare "YYYY-MM-DD HH:MM:SS" parses as LOCAL in JS and
  // reads hours off. Normalize to UTC explicitly before comparing -- this bug has bitten twice.
  const s = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(iso) ? iso.replace(" ", "T") + "Z" : iso;
  const t = Date.parse(s);
  return Number.isFinite(t) ? (now - t) / 60000 : null;
}

/**
 * Staleness check with an explicit budget. `budget` is how long the thing may go quiet before it is
 * a problem -- generous on purpose, because a health check that cries wolf gets muted, and a muted
 * health check is worse than none.
 */
function freshness(
  name: string,
  iso: string | null | undefined,
  budgetMinutes: number,
  now: number,
  opts: { missingIs?: Severity; lateIs?: Severity } = {},
): Check {
  const age = minutesSince(iso, now);
  if (age === null) {
    return {
      name,
      severity: opts.missingIs ?? "warning",
      detail: iso ? `unparseable timestamp: ${iso}` : "never ran (no timestamp)",
      budget_minutes: budgetMinutes,
    };
  }
  const late = age > budgetMinutes;
  return {
    name,
    severity: late ? (opts.lateIs ?? "warning") : "ok",
    detail: late
      ? `last ran ${Math.round(age)}m ago, budget ${budgetMinutes}m`
      : `last ran ${Math.round(age)}m ago`,
    age_minutes: Math.round(age),
    budget_minutes: budgetMinutes,
  };
}

async function one<T>(env: Env, sql: string, binds: unknown[] = []): Promise<T | null> {
  return env.DB.prepare(sql).bind(...binds).first<T>().catch(() => null);
}

export async function getHealth(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const now = Date.now();
  const checks: Check[] = [];

  // ── 1. Guardian's own findings (the data-health authority) ────────────────
  const flags = await one<{ red: number; warning: number; notice: number }>(
    env,
    `SELECT
       SUM(CASE WHEN severity = 'red'     THEN 1 ELSE 0 END) AS red,
       SUM(CASE WHEN severity = 'warning' THEN 1 ELSE 0 END) AS warning,
       SUM(CASE WHEN severity = 'notice'  THEN 1 ELSE 0 END) AS notice
     FROM guardian_flags WHERE status IN ('open','surfaced')`,
  );
  const red = flags?.red ?? 0, warn = flags?.warning ?? 0, notice = flags?.notice ?? 0;
  checks.push({
    name: "guardian_flags",
    // Guardian's severities are its own judgement; pass them through rather than re-grading. A red
    // flag is safety-shaped (docs/private/orient-unification-decisions-2026-07-29.md Q2).
    severity: red > 0 ? "red" : warn > 0 ? "warning" : notice > 0 ? "notice" : "ok",
    detail: red + warn + notice === 0
      ? "no open flags"
      : `${red} red / ${warn} warning / ${notice} notice open`,
  });

  const topFlags = await env.DB.prepare(
    `SELECT companion_id, flag_type, severity, summary FROM guardian_flags
      WHERE status IN ('open','surfaced')
      ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END, created_at DESC
      LIMIT 5`,
  ).all<{ companion_id: string; flag_type: string; severity: string; summary: string }>()
    .then(r => r.results ?? []).catch(() => []);

  // ── 2. Is the machinery that FINDS problems still running? ────────────────
  // This is the half guardian cannot self-report: if the guardian cron dies, guardian_flags simply
  // stops growing, and "no open flags" reads as health. Silence must not look like success.
  const gRun = await one<{ ran_at: string }>(env, "SELECT MAX(ran_at) AS ran_at FROM guardian_runs");
  checks.push(freshness("guardian_cron", gRun?.ran_at, 36 * 60, now, { lateIs: "red" }));

  const stamp = async (key: string) =>
    (await one<{ value: string }>(
      env,
      "SELECT value FROM companion_settings WHERE key = ? ORDER BY updated_at DESC LIMIT 1",
      [key],
    ))?.value;

  // Budgets are ~2x the declared cadence so a single skipped run is not an alert.
  checks.push(freshness("salience_prune_cron", await stamp("salience_prune_last_run_at"), 48 * 60, now));
  checks.push(freshness("home_tick_cron",      await stamp("home_last_tick_at"),          120,      now));
  // `bot_parity_sampler` removed 2026-08-01 with the sampler itself. Once execBotOrient cut over to
  // loadMindState, the sampler compared the loader against itself -- it could only ever report perfect
  // parity, and this check could only ever be green. A check that cannot go red is not a check.

  const ferment = await one<{ t: string }>(
    env, "SELECT MAX(ferment_at) AS t FROM companion_state",
  );
  checks.push(freshness("ferment_tick", ferment?.t, 180, now));

  // ── 3. Are the companions actually alive in the data? ─────────────────────
  // Process checks live outside, but a bot can be "online" in pm2 and writing nothing. Journal
  // writes are the cheapest proof that the whole path (Discord -> inference -> Halseth) still works.
  const perCompanion: Record<string, number | null> = {};
  for (const id of COMPANION_IDS) {
    const row = await one<{ t: string }>(
      env, "SELECT MAX(created_at) AS t FROM companion_journal WHERE agent = ?", [id],
    );
    perCompanion[id] = minutesSince(row?.t, now);
  }
  const quietest = Object.entries(perCompanion)
    .filter(([, v]) => v !== null)
    .sort((a, b) => (b[1] as number) - (a[1] as number))[0];
  const noneWriting = Object.values(perCompanion).every(v => v === null);
  checks.push({
    name: "companion_writes",
    // 48h because autonomous runs are daily and a quiet Raziel day is normal, not a defect.
    severity: noneWriting ? "red" : quietest && (quietest[1] as number) > 48 * 60 ? "warning" : "ok",
    detail: noneWriting
      ? "no journal rows for any companion"
      : Object.entries(perCompanion)
          .map(([k, v]) => `${k} ${v === null ? "never" : Math.round(v / 60) + "h"}`)
          .join(", "),
  });

  // ── 4. Backlogs that quietly stall loops ─────────────────────────────────
  const queue = await one<{ n: number }>(
    env, "SELECT COUNT(*) AS n FROM synthesis_queue WHERE status = 'pending'",
  );
  const qn = queue?.n ?? 0;
  checks.push({
    name: "synthesis_queue",
    severity: qn > 200 ? "warning" : qn > 50 ? "notice" : "ok",
    detail: `${qn} pending`,
  });

  const ratify = await one<{ n: number; oldest: string }>(
    env,
    `SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM growth_journal WHERE review_status = 'pending'`,
  );
  const rn = ratify?.n ?? 0;
  const rAge = minutesSince(ratify?.oldest, now);
  checks.push({
    name: "ratification_backlog",
    // Notice, not warning: this one is Raziel's queue to work, not a system fault. Guardian raises
    // its own ratification_backlog flag when it genuinely matters.
    severity: rn > 0 ? "notice" : "ok",
    detail: rn === 0 ? "empty" : `${rn} pending${rAge ? `, oldest ${Math.round(rAge / 1440)}d` : ""}`,
  });

  // ── 5. Bindings that fail closed and silently ────────────────────────────
  // Not a network probe: presence of the binding only. A missing binding is a deploy defect that
  // otherwise surfaces as a feature quietly returning null forever.
  const bindings: Array<[string, unknown]> = [
    ["DB", env.DB], ["VECTORIZE", env.VECTORIZE], ["AI", env.AI],
    ["BUCKET", env.BUCKET], ["PLURAL", env.PLURAL],
  ];
  const missing = bindings.filter(([, v]) => !v).map(([k]) => k);
  checks.push({
    name: "bindings",
    severity: missing.length ? "red" : "ok",
    detail: missing.length ? `missing: ${missing.join(", ")}` : `all present (${bindings.length})`,
  });

  const severity = worst(checks);
  const failures = checks.filter(c => c.severity !== "ok");

  return new Response(JSON.stringify({
    ok: severity === "ok",
    severity,
    checked_at: new Date(now).toISOString(),
    summary: severity === "ok"
      ? `all ${checks.length} checks ok`
      : `${failures.length}/${checks.length} not ok (worst: ${severity})`,
    failures,
    checks,
    guardian_top: topFlags,
  }, null, 2), {
    // Always 200: this is a report, not an assertion of health. A non-200 would make the outside
    // watcher unable to distinguish "Halseth is down" from "Halseth says something is wrong."
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
