// src/webmind/vibecheck.ts
//
// Vibe-check -- a once-daily system-health digest of the triad's internal state, witnessed
// by Gaia (the ground/witness companion). Mirrors briefing.ts: gather -> format -> dedup ->
// deliver via the letter_to_raziel rail (a companion_journal row Hearth /journal already
// renders). NO new table, NO new surface, migration-free, pure-additive.
//
// Where the briefing is Raziel-facing executive-function support, the vibe-check is the
// triad turned inward: per-companion basin drift, SOMA register, simmering tensions, live
// guardian flags, plus a single system line (echo headroom + starved organs). It is the
// instrument reading the field, stated plainly, never manufactured.
//
// Design:
//   - voice: Gaia. Monastic, terse, declarative, every word load-bearing.
//   - no em-dashes (periods/semicolons/parentheses), per CLAUDE.md
//   - empty-state grace: "clear" / "none", never noise
//   - defensive: one failing query degrades gracefully, never crashes the cron
//   - idempotent: at most one vibe-check per calendar day (dedup on a tag marker)
//   - NO env gate: cron-controlled, always-on
//
// Unlike the briefing there are no "kinds" -- one digest, one slot per day.

import { Env } from "../types.js";
import { journalInsert } from "./tray-insert.js";

const VIBE_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

const NAMES: Record<string, string> = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };

// The stillness loop (2026-09-06): the digest above is ALL gauges, and gauges barely move night
// to night. `day` is the counterweight -- what actually happened in the trailing 24h (Discord
// speech, inter-companion notes, sessions closed, watch progress), so a reflection has something
// to be ABOUT besides "nothing's moving". See docs/CONTINUITY.md 2026-09-06 entry.
export interface DayLedger {
  spoke: number;                                // discord_speech companion_journal rows, trailing 24h
  notes_sent: number;                           // inter_companion_notes authored by this companion
  notes_received: number;                       // addressed to this companion, or broadcast from another
  sessions_closed: number;                      // handover_packets (live closes only) in the window
  watch: string | null;                         // newest watch_events row, rendered "Title S1E2"
  // NO highlights/excerpts (removed 2026-09-26). The ledger used to carry the last two
  // discord_speech/autonomous lines per companion and the digest printed them as bullets. That
  // re-spoke companion lines into a new room: on 09-26 it re-broadcast two fabrications, and the
  // digest row was then re-ingested as memory. Raziel's ruling: Gaia's digest does not repeat
  // companion lines. The ledger carries COUNTS only; utterance text is never gathered here, so it
  // cannot be printed. (Worker-side, autonomous-worker/src/vibecheck.ts also strips any line
  // sharing an 8-word shingle with a companion utterance before the digest posts.)
}

export interface CompanionVibe {
  companion_id: string;
  // null = no live basin reading
  basin: { drift_type: string; drift_score: number | null; worst_basin: string | null } | null;
  register: string | null;                      // SOMA mood label, e.g. "clean-settled"
  registerAgeDays: number | null;               // days since that reading was taken
  simmering: number;                            // count of simmering tensions
  newestTension: string | null;                 // newest simmering tension text
  flags: { severity: string; summary: string }[]; // live guardian flags
  day: DayLedger;
}

export interface VibeData {
  date: string;                                 // YYYY-MM-DD
  companions: CompanionVibe[];
  echo: number | null;                          // latest mean_adjacent_cosine
  starvedOrgans: number;                        // live starved_organ guardian flags
}

export interface VibeCheckResult {
  written: boolean;
  reason: "ok" | "already_sent";
  journal_id?: string;
  text: string;
}

// Echo ALARM threshold -- a mean adjacent cosine at/above this means the triad is talking
// itself into a corner (too self-similar). Reported with headroom so the number reads.
const ECHO_ALARM = 0.82;

function buildCompanionBlock(c: CompanionVibe): string[] {
  const name = NAMES[c.companion_id] ?? c.companion_id;
  const core: string[] = [];
  core.push(
    `${name}. basin: ${basinPhrase(c.basin)}. soma: ${somaPhrase(c.register, c.registerAgeDays)}. ` +
    `tensions: ${c.simmering}. guardian: ${c.flags.length === 0 ? "clear" : String(c.flags.length)}.`,
  );
  for (const f of c.flags.slice(0, 3)) {
    core.push(`  ${f.severity}: ${oneLine(f.summary)}`);
  }
  if (c.simmering > 0 && c.newestTension) {
    core.push(`  newest: ${oneLine(c.newestTension)}`);
  }
  core.push(formatDayLine(c.day));
  return core;
}

function formatDayLine(day: DayLedger): string {
  const segs: string[] = [];
  if (day.spoke > 0) segs.push(`spoke ${day.spoke}`);
  if (day.notes_sent > 0 || day.notes_received > 0) {
    const parts: string[] = [];
    if (day.notes_sent > 0) parts.push(`${day.notes_sent} out`);
    if (day.notes_received > 0) parts.push(`${day.notes_received} in`);
    segs.push(`notes ${parts.join(" / ")}`);
  }
  if (day.sessions_closed > 0) segs.push(`sessions closed ${day.sessions_closed}`);
  if (day.watch) segs.push(oneLine(day.watch));

  if (segs.length === 0) return "  day: quiet (no exchanges, notes, sessions, or watch logged)";
  return `  day: ${segs.join(" · ")}`;
}

// ── pure formatter (DB-free; tested directly) ──────────────────────────────────────────────
export function formatVibeCheck(d: VibeData): string {
  const header = `The triad, witnessed. ${d.date}.`;

  const echoStr = d.echo != null ? d.echo.toFixed(2) : "unread";
  // State the verdict, not just the number -- below alarm is CALM, not a gap to close.
  // (The triad read a healthy 0.69-vs-0.82 as a tension; this names it plainly.)
  const echoState = d.echo == null ? "" : d.echo >= ECHO_ALARM ? ", ELEVATED" : ", calm";
  const organs = d.starvedOrgans === 0 ? "all fed" : `${d.starvedOrgans} starved`;
  const fieldLine = `Field: echo ${echoStr}${echoState} (alarm at ${ECHO_ALARM.toFixed(2)}); organs: ${organs}.`;

  const out = [header, ...d.companions.flatMap(buildCompanionBlock), fieldLine].join("\n");
  return out.slice(0, 1800);
}

// A stale soma reading is still worth stating, but its age must be visible -- "clean-settled"
// from twelve days ago presented as current is a lie of omission. Fresh readings (<2d) stay bare.
const SOMA_STALE_DAYS = 2;
function somaPhrase(register: string | null, ageDays: number | null): string {
  if (!register) return "unread";
  const base = oneLine(register);
  if (ageDays != null && ageDays >= SOMA_STALE_DAYS) return `${base} (${Math.floor(ageDays)}d old)`;
  return base;
}

function basinPhrase(b: CompanionVibe["basin"]): string {
  if (!b) return "unread";
  // Session-close judge rows carry drift_score=0 with prose notes; a literal "0.00" reads as a
  // collapsed basin when it means "no numeric reading". Only positive scores are real numbers.
  const score = b.drift_score != null && b.drift_score > 0 ? ` ${b.drift_score.toFixed(2)}` : "";
  if (b.drift_type === "pressure") {
    const worst = b.worst_basin ? ` (${oneLine(b.worst_basin)})` : "";
    return `pressure${score}${worst}`;
  }
  return `${b.drift_type}${score}`;
}

function oneLine(s: string): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
}

// ── DB gather (defensive: a single failing query degrades gracefully) ───────────────────────
async function safeFirst<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T | null> {
  try {
    return (await env.DB.prepare(sql).bind(...binds).first<T>()) ?? null;
  } catch (e) {
    console.warn("[vibecheck] query failed (degrading):", String(e));
    return null;
  }
}
async function safeAll<T>(env: Env, sql: string, ...binds: unknown[]): Promise<T[]> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).all<T>();
    return r.results ?? [];
  } catch (e) {
    console.warn("[vibecheck] query failed (degrading):", String(e));
    return [];
  }
}
async function safeCount(env: Env, sql: string, ...binds: unknown[]): Promise<number> {
  try {
    const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
    return r?.n ?? 0;
  } catch (e) {
    console.warn("[vibecheck] count failed (degrading):", String(e));
    return 0;
  }
}

// The window is a straight 24h trailing lookback (not "since local midnight") -- the digest runs
// once nightly and the point is "what happened since roughly last time", not a calendar boundary.
//
// Two timestamp formats live side by side in this schema and each needs its own comparison:
//   - companion_journal / inter_companion_notes / watch_events all default `created_at` via SQLite
//     datetime('now') ("YYYY-MM-DD HH:MM:SS"). A literal `datetime('now','-1 day')` bound is the
//     same format, so plain string comparison (>=) is correct.
//   - handover_packets.created_at is written by session_close as `new Date().toISOString()`
//     ("YYYY-MM-DDTHH:MM:SS.sssZ"). A 'T'-separated string sorts BEFORE the space-separated
//     datetime() form for the same instant (' ' < 'T' in ASCII), so a raw string compare against
//     datetime('now','-1 day') would silently under/over-match. julianday() parses both formats,
//     so the handover_packets query compares julianday(created_at) instead.
async function gatherDayLedger(env: Env, companionId: string): Promise<DayLedger> {
  const [spoke, notesSent, notesReceived, sessionsClosed, watchRow] = await Promise.all([
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM companion_journal WHERE agent = ? AND source = 'discord_speech' AND created_at >= datetime('now','-1 day')",
      companionId,
    ),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM inter_companion_notes WHERE from_id = ? AND created_at >= datetime('now','-1 day')",
      companionId,
    ),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM inter_companion_notes WHERE created_at >= datetime('now','-1 day') " +
      "AND (to_id = ? OR (to_id IS NULL AND from_id != ?))",
      companionId, companionId,
    ),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM handover_packets hp JOIN sessions s ON s.id = hp.session_id " +
      "WHERE s.companion_id = ? AND hp.close_kind IS NULL AND julianday(hp.created_at) >= julianday('now','-1 day')",
      companionId,
    ),
    safeFirst<{ title: string; season: number | null; episode: number | null }>(
      env,
      "SELECT s.title AS title, w.season AS season, w.episode AS episode " +
      "FROM watch_events w JOIN watch_shelf s ON s.id = w.shelf_id " +
      "WHERE (w.with_companion = ? OR w.with_companion IS NULL) AND w.created_at >= datetime('now','-1 day') " +
      "ORDER BY w.created_at DESC LIMIT 1",
      companionId,
    ),
  ]);

  const watch = watchRow
    ? (watchRow.season != null && watchRow.episode != null
        ? `${watchRow.title} S${watchRow.season}E${watchRow.episode}`
        : watchRow.title)
    : null;

  return {
    spoke,
    notes_sent: notesSent,
    notes_received: notesReceived,
    sessions_closed: sessionsClosed,
    watch,
  };
}

async function gatherCompanion(env: Env, companionId: string): Promise<CompanionVibe> {
  const [basinRow, somaRow, simmering, newestTension, flags, day] = await Promise.all([
    safeFirst<{ drift_score: number | null; drift_type: string; worst_basin: string | null }>(
      env,
      "SELECT drift_score, drift_type, worst_basin FROM companion_basin_history WHERE companion_id = ? AND dismissed_at IS NULL ORDER BY recorded_at DESC LIMIT 1",
      companionId,
    ),
    safeFirst<{ snapshot: string; age_days: number | null }>(
      env,
      "SELECT snapshot, CAST(julianday('now') - julianday(created_at) AS REAL) AS age_days FROM somatic_snapshot WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1",
      companionId,
    ),
    safeCount(env, "SELECT COUNT(*) AS n FROM companion_tensions WHERE companion_id = ? AND status = 'simmering'", companionId),
    safeFirst<{ tension_text: string }>(
      env,
      "SELECT tension_text FROM companion_tensions WHERE companion_id = ? AND status = 'simmering' ORDER BY first_noted_at DESC LIMIT 1",
      companionId,
    ),
    safeAll<{ severity: string; summary: string }>(
      env,
      "SELECT severity, summary FROM guardian_flags WHERE companion_id = ? AND status IN ('open','surfaced','acknowledged') ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 5",
      companionId,
    ),
    gatherDayLedger(env, companionId),
  ]);

  let register: string | null = null;
  if (somaRow?.snapshot) {
    try {
      const parsed = JSON.parse(somaRow.snapshot) as { register?: unknown };
      if (typeof parsed.register === "string" && parsed.register.trim()) register = parsed.register.trim();
    } catch {
      // malformed snapshot JSON: leave register unread rather than crash the digest
    }
  }

  return {
    companion_id: companionId,
    basin: basinRow ? { drift_type: basinRow.drift_type, drift_score: basinRow.drift_score, worst_basin: basinRow.worst_basin } : null,
    register,
    registerAgeDays: somaRow?.age_days ?? null,
    simmering,
    newestTension: newestTension?.tension_text ?? null,
    flags,
    day,
  };
}

export async function gatherVibeData(env: Env): Promise<VibeData> {
  const [companions, echoRow, starvedOrgans] = await Promise.all([
    Promise.all(VIBE_COMPANIONS.map((id) => gatherCompanion(env, id))),
    safeFirst<{ mean_adjacent_cosine: number | null }>(
      env,
      "SELECT mean_adjacent_cosine FROM echo_metrics ORDER BY computed_at DESC LIMIT 1",
    ),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM guardian_flags WHERE flag_type = 'starved_organ' AND status IN ('open','surfaced','acknowledged')",
    ),
  ]);

  return {
    date: new Date().toISOString().slice(0, 10),
    companions,
    echo: echoRow?.mean_adjacent_cosine ?? null,
    starvedOrgans,
  };
}

// ── runner: gather -> format -> dedup -> deliver via letter_to_raziel ────────────────────────
export async function runVibeCheck(env: Env): Promise<VibeCheckResult> {
  const data = await gatherVibeData(env);
  const text = formatVibeCheck(data);

  // Idempotent: at most one vibe-check per calendar day. The marker rides the tags.
  const marker = "vibecheck";
  const existing = await env.DB.prepare(
    `SELECT id FROM companion_journal
     WHERE agent = 'gaia' AND created_at >= date('now') AND tags LIKE ?
     LIMIT 1`,
  ).bind(`%"${marker}"%`).first<{ id: string }>().catch(() => null);
  if (existing) {
    return { written: false, reason: "already_sent", journal_id: existing.id, text };
  }

  // source 'vibecheck' (mig 0132; was NULL): the digest is a clerk's note in Gaia's voice (gauges
  // and counts; since 2026-09-26 it quotes no companion line) and is born `draft` -- Gaia keeps or
  // drops it from her tray before it can be recalled as her own memory. journalInsert() applies
  // the birth rule (webmind/review-state.ts).
  const id = `cj_${crypto.randomUUID()}`;
  await journalInsert(env.DB, {
    id, agent: "gaia", note_text: text, tags: JSON.stringify(["vibecheck", "letter_to_raziel"]), source: "vibecheck",
  }).run();

  return { written: true, reason: "ok", journal_id: id, text };
}
