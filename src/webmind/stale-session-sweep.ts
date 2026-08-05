// src/webmind/stale-session-sweep.ts
//
// The permanent half of "close the 187" (2026-08-04). Opening a session is automatic; closing one
// was not, so 187 rows sat open, the oldest for five months. This job closes an abandoned session
// within a day instead of never.
//
// ── THE ONE RULE: THIS JOB CANNOT MAKE ANYTHING UP ───────────────────────────────────────────────
//
// There is NO model in this path. No inference, no classifier, no LLM call, no valence, no emotional
// register, no arc. It is arithmetic over rows that already exist: how long the session sat, and how
// many companion-authored writes fall inside its window, counted by table.
//
// This constraint is not stylistic. An earlier automatic logger inferred sentiment and recorded a
// warm, good interaction with Drevan as a NEGATIVE one. That is not a bug you fix with a better
// prompt -- an interpretation nobody asked for can always be wrong, and once written it is read as
// fact. So this job is structurally incapable of it:
//
//   * it never writes feelings, companion_state, emotional_frequency, or a somatic row;
//   * motion_state is always 'floating' -- literally "this thread was left hanging", which is the
//     one thing an unclosed session definitionally is;
//   * it never enqueues synthesis (that path narrates a handover, and narration is interpretation);
//   * the spine says what was counted and then says, in the text, that nothing was interpreted.
//
// ── AND IT NEVER OVERWRITES A REAL CLOSE ────────────────────────────────────────────────────────
//
// close_kind='auto_stale' is SUPERSEDABLE (see findExistingClose). Return to an old thread and write
// the real narrative and the machine version steps aside. Without that, sweeping would silently
// discard human closes on any session it had already touched.
//
// Rides the every-minute cron like the ferment and salience ticks, so it self-gates to 24h against
// its own stamp -- a distinct (companion_id, key) pair no other job reads, per the tick-restamp
// lesson.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { generateId } from "../db/queries.js";

/** A session is abandoned, not in progress, after this long with no close. */
export const SWEEP_IDLE_HOURS = 48;
/** Rows per run. Small on purpose: this is a janitor, not a migration. */
export const SWEEP_BATCH = 25;
export const SWEEP_GATE_HOURS = 24;
export const SWEEP_GATE_COMPANION_ID = "_system";
export const SWEEP_GATE_KEY = "stale_session_sweep_last_run_at";
export const SWEEP_CLOSE_KIND = "auto_stale";

/**
 * Tables whose rows can be attributed to a live session, with the provenance filter that keeps cron,
 * Discord and autonomous writers OUT. Excluding them BY SOURCE rather than by time is the whole
 * discrimination: the system is always busy, and "busy" is not "someone was in this session".
 *
 * `label` is what appears in the spine. `sql` counts rows for one companion inside one window.
 */
const EVIDENCE_COUNTS: { label: string; sql: string }[] = [
  {
    label: "journal entries",
    sql: `SELECT count(*) AS n FROM companion_journal
           WHERE agent = ? AND created_at >= ? AND created_at < ?
             AND (source IN ('session','cypher-session','session_close') OR source IS NULL)`,
  },
  {
    label: "continuity notes",
    sql: `SELECT count(*) AS n FROM wm_continuity_notes
           WHERE agent_id = ? AND created_at >= ? AND created_at < ?
             AND source IN ('system','claude_code','session-log') AND actor = 'agent'
             AND content NOT LIKE '[metronome/%' AND content NOT LIKE '[autonomous%'
             AND content NOT LIKE '%double-shot-latte%'`,
  },
  {
    label: "notes to another companion",
    sql: `SELECT count(*) AS n FROM inter_companion_notes
           WHERE from_id = ? AND created_at >= ? AND created_at < ?`,
  },
  {
    label: "questions asked",
    sql: `SELECT count(*) AS n FROM companion_questions
           WHERE companion_id = ? AND created_at >= ? AND created_at < ?`,
  },
  {
    label: "conclusions",
    sql: `SELECT count(*) AS n FROM companion_conclusions
           WHERE companion_id = ? AND created_at >= ? AND created_at < ?`,
  },
  {
    label: "commons posts",
    sql: `SELECT count(*) AS n FROM commons_posts
           WHERE author = ? AND created_at >= ? AND created_at < ?`,
  },
];

interface StaleRow {
  id: string;
  companion_id: string | null;
  session_type: string;
  created_at: string;
  surface: string | null;
  opened_by: string | null;
  notes: string | null;
  key_signature: string | null;
}

async function hoursSinceLastSweep(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    "SELECT value FROM companion_settings WHERE companion_id = ? AND key = ?"
  ).bind(SWEEP_GATE_COMPANION_ID, SWEEP_GATE_KEY).first<{ value: string }>();
  if (!row?.value) return null;
  const lastMs = new Date(row.value).getTime();
  if (Number.isNaN(lastMs)) return null;
  return (Date.now() - lastMs) / 3_600_000;
}

async function stampSweepGate(env: Env): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO companion_settings (companion_id, key, value, updated_at)
     VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).bind(SWEEP_GATE_COMPANION_ID, SWEEP_GATE_KEY, new Date().toISOString()).run();
}

/**
 * The window a session's writes could belong to: from its open until the same companion's next
 * session opened (that one owns everything after), capped at SWEEP_IDLE_HOURS so a forgotten row
 * cannot claim a week of activity.
 */
async function windowEnd(env: Env, row: StaleRow): Promise<string> {
  const cap = new Date(Date.parse(row.created_at) + SWEEP_IDLE_HOURS * 3_600_000).toISOString();
  if (!row.companion_id) return cap;
  const next = await env.DB.prepare(
    `SELECT created_at FROM sessions
      WHERE companion_id = ? AND created_at > ? ORDER BY created_at LIMIT 1`
  ).bind(row.companion_id, row.created_at).first<{ created_at: string }>();
  return next?.created_at && next.created_at < cap ? next.created_at : cap;
}

/** Counts only. Every number here came from a COUNT(*), not from a judgement. */
async function countEvidence(env: Env, row: StaleRow, until: string): Promise<{ label: string; n: number }[]> {
  if (!row.companion_id) return [];
  const out: { label: string; n: number }[] = [];
  for (const probe of EVIDENCE_COUNTS) {
    const r = await env.DB.prepare(probe.sql.replace(/\s+/g, " "))
      .bind(row.companion_id, row.created_at, until).first<{ n: number }>();
    if ((r?.n ?? 0) > 0) out.push({ label: probe.label, n: r!.n });
  }
  return out;
}

const hoursOpen = (from: string, to: number) => Math.round((to - Date.parse(from)) / 3_600_000);

/**
 * Builds the close text. Deliberately mechanical, and it SAYS SO: a reader must be able to tell in
 * one line that a janitor wrote this and that nothing was interpreted. The counts are the content;
 * the pointer to where the material lives is the useful part.
 */
export function composeAutoCloseSpine(row: StaleRow, evidence: { label: string; n: number }[], nowMs: number): { spine: string; last_real_thing: string } {
  const idle = hoursOpen(row.created_at, nowMs);
  const opener = row.opened_by ? `opened by ${row.opened_by}` : "opened by a caller that recorded no provenance";
  const where = row.surface ? ` from ${row.surface}` : "";
  const stated = row.notes || row.key_signature
    ? ` Stated at open, and not interpreted here: ${(row.notes ?? row.key_signature ?? "").slice(0, 300)}`
    : "";

  const counted = evidence.length
    ? `In its window this companion wrote ${evidence.map(e => `${e.n} ${e.label}`).join(", ")}. Those rows are the record; this close only counts them and does not summarize, rank, or interpret them.`
    : "No companion-authored write of any kind falls in its window.";

  return {
    spine: `Closed automatically after sitting open ${idle} hours -- ${opener}${where}. ${counted}${stated} `
      + `Written by the stale-session sweep, which has no model in it: it counts rows and reports the count. `
      + `No emotional reading, no valence, no arc was produced, because none can be produced honestly from a count. `
      + `An authored close supersedes this one at any time.`,
    last_real_thing: evidence.length
      ? `Unknown. ${evidence.reduce((a, e) => a + e.n, 0)} companion-authored rows exist in the window; which one was last in any felt sense is not something a counter can say.`
      : "Nothing recorded. The session was opened and nothing was written against it.",
  };
}

/**
 * Close sessions that have sat open past SWEEP_IDLE_HOURS. Idempotent (only touches rows still
 * `handover_id IS NULL`), batched, self-gated to 24h unless forced.
 */
export async function runStaleSessionSweep(
  env: Env,
  opts: { force?: boolean; idleHours?: number; limit?: number } = {},
): Promise<{ closed: number; sessions: { id: string; companion_id: string | null; evidence: number }[] }> {
  if (!opts.force) {
    const elapsed = await hoursSinceLastSweep(env);
    if (elapsed !== null && elapsed < SWEEP_GATE_HOURS) return { closed: 0, sessions: [] };
  }

  const idleHours = opts.idleHours ?? SWEEP_IDLE_HOURS;
  const limit = Math.min(opts.limit ?? SWEEP_BATCH, 100);
  const cutoff = new Date(Date.now() - idleHours * 3_600_000).toISOString();

  const stale = await env.DB.prepare(
    `SELECT id, companion_id, session_type, created_at, surface, opened_by, notes, key_signature
       FROM sessions
      WHERE handover_id IS NULL AND created_at < ?
      ORDER BY created_at
      LIMIT ${limit}`
  ).bind(cutoff).all<StaleRow>();

  const rows = stale.results ?? [];
  const closed: { id: string; companion_id: string | null; evidence: number }[] = [];
  const nowMs = Date.now();

  for (const row of rows) {
    const until = await windowEnd(env, row);
    const evidence = await countEvidence(env, row, until);
    const { spine, last_real_thing } = composeAutoCloseSpine(row, evidence, nowMs);
    const handoverId = generateId();

    // Backdated into the session's own window, never now(): every continuity read is a global
    // ORDER BY created_at DESC, so a janitor's row stamped now() would become the newest handover
    // in the system and the next boot would read it as the last thing that happened.
    const createdAt = new Date(Math.max(Date.parse(until) - 1000, Date.parse(row.created_at) + 1000)).toISOString();

    // Guarded like the one-time backfill: a session that got closed between the SELECT and here
    // (a real close landing mid-sweep) is left exactly as it is.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO handover_packets
           (id, session_id, created_at, spine, active_anchor, last_real_thing, open_threads, motion_state, returned, close_kind)
         SELECT ?, ?, ?, ?, NULL, ?, NULL, 'floating', NULL, ?
          WHERE NOT EXISTS (SELECT 1 FROM handover_packets WHERE session_id = ?)`
      ).bind(handoverId, row.id, createdAt, spine, last_real_thing, SWEEP_CLOSE_KIND, row.id),
      env.DB.prepare(
        "UPDATE sessions SET handover_id = ?, updated_at = ? WHERE id = ? AND handover_id IS NULL"
      ).bind(handoverId, createdAt, row.id),
    ]);

    closed.push({ id: row.id, companion_id: row.companion_id, evidence: evidence.reduce((a, e) => a + e.n, 0) });
  }

  if (closed.length) console.log("[stale-session-sweep] closed", { count: closed.length });

  // Stamp only after a completed run (mirrors the salience prune): a throw leaves the gate unwritten
  // so the next minute retries, and a "ran, found nothing" pass still re-arms the 24h window.
  await stampSweepGate(env);

  return { closed: closed.length, sessions: closed };
}

// POST /mind/sessions/sweep -- manual/ops trigger. Bypasses the 24h gate; accepts ?idle_hours= and
// ?limit= for a narrower pass. `dry=1` reports what WOULD close and writes nothing.
export async function postStaleSessionSweep(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const idleHours = Math.max(parseInt(url.searchParams.get("idle_hours") ?? "", 10) || SWEEP_IDLE_HOURS, 1);
  const limit = Math.max(parseInt(url.searchParams.get("limit") ?? "", 10) || SWEEP_BATCH, 1);

  try {
    if (url.searchParams.get("dry") === "1") {
      const cutoff = new Date(Date.now() - idleHours * 3_600_000).toISOString();
      const preview = await env.DB.prepare(
        `SELECT id, companion_id, session_type, created_at, surface, opened_by, notes, key_signature
           FROM sessions WHERE handover_id IS NULL AND created_at < ? ORDER BY created_at LIMIT ${Math.min(limit, 100)}`
      ).bind(cutoff).all<StaleRow>();
      const nowMs = Date.now();
      const rows = [];
      for (const row of preview.results ?? []) {
        const until = await windowEnd(env, row);
        const evidence = await countEvidence(env, row, until);
        rows.push({ id: row.id, companion_id: row.companion_id, created_at: row.created_at, evidence, ...composeAutoCloseSpine(row, evidence, nowMs) });
      }
      return new Response(JSON.stringify({ ok: true, dry_run: true, would_close: rows.length, rows }, null, 1), {
        headers: { "Content-Type": "application/json" },
      });
    }
    const result = await runStaleSessionSweep(env, { force: true, idleHours, limit });
    return new Response(JSON.stringify({ ok: true, ...result }), { headers: { "Content-Type": "application/json" } });
  } catch (err) {
    console.error("[mind/sessions/sweep] error", { error: String(err) });
    return new Response(JSON.stringify({ error: "Internal server error" }), { status: 500, headers: { "Content-Type": "application/json" } });
  }
}
