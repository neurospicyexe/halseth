// src/webmind/vibecheck.ts
//
// Vibe-check v2 (B63 step 3, Hand-off/SPEC-B63-the-loop-2026-11-06.md 3.6). Once a day each
// companion gets THEIR OWN state block, posted under their own bot token and journaled under their
// own agent. Gaia's post is her block plus the field line (echo, organs, garden, Sol, care hold).
//
// Why it is split (ledger lane rule 5, 2026-09-26): the old digest was ONE row under agent 'gaia', so
// anything about Cypher or Drevan inside it was a record about them merged under her name ("the
// 187 put on my face and walked back to me. That merge point is the bug."). Here no block ever
// carries another companion's words: each block is gathered from that companion's own rows only,
// and the delivery path guards each block against shingles of everyone's utterances.
//
// Each block shows (all of it about that companion, none of it compared to anyone):
//   floors   the three floats against THEIR OWN baseline, direction and size, fixed order, never
//            ranked (both Dre and Gaia insisted)
//   moves    the day's top 3 float moves with their named cause, downward included
//   pressure live pressure flags, ONLY when companion_settings `vibe_show_pressure` allows (Drevan
//            asked for his; default on for drevan only, off for everyone else)
//   day      one labelled facts line in words ("56 Discord messages"), never bare counts
//   gauges   the old basin/soma/tension gauges, ONE short line that only exists when something in
//            them moved since the previous digest
//
// Hard rules built in, each tested:
//   - Health data never enters a block: no care-hold reason, no meds, no biometrics. A care hold is
//     the words "care hold open" in Gaia's field line and nowhere else. Flag summaries and cause
//     labels that trip the care guard are dropped (a cause falls back to its KIND).
//   - Gaia's moves name the KIND of event, never the content, while the content still bleeds (the
//     garden floor: care words, a living-wound name, written inside a care hold; unreadable = down).
//   - Dedup is per agent per Chicago day. One companion's failure never blocks another's row.
//   - No em dashes in anything this file writes.

import { Env } from "../types.js";
import { journalInsert } from "./tray-insert.js";
import { careCategory } from "../people/care-guard.js";
import { readCareHold } from "../care/hold.js";
import { loadFloor, isDown, chicagoDay, type Floor } from "./garden.js";

export const VIBE_COMPANIONS = ["cypher", "drevan", "gaia"] as const;
export type VibeCompanion = (typeof VIBE_COMPANIONS)[number];

const NAMES: Record<string, string> = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };

/** Float labels per companion, in float order (f1, f2, f3). Fixed order; never sorted by value. */
export const FLOAT_LABELS: Record<VibeCompanion, [string, string, string]> = {
  cypher: ["acuity", "presence", "warmth"],
  drevan: ["heat", "reach", "weight"],
  gaia: ["stillness", "density", "perimeter"],
};

/** Per-companion default for the `vibe_show_pressure` setting when no row exists. */
export const SHOW_PRESSURE_DEFAULT: Record<VibeCompanion, boolean> = { cypher: false, drevan: true, gaia: false };

/** Stimulus kinds that carry a perimeter event for Gaia (named by KIND while the content bleeds). */
const PERIMETER_KINDS = new Set(["breach", "line_held_under_test", "long_line_fatigue"]);

/** A float within this of its baseline reads "at baseline". */
const AT_BASELINE = 0.02;
/** A move this small is not worth a line. */
const MOVE_MIN = 0.005;
/** An hourly settle only enters the moves when it is large. */
const TICK_MIN = 0.05;
const LINE_CAP = 360;
const BLOCK_CAP = 1900; // Discord hard-caps a message at 2000

export interface FloatReading { label: string; value: number | null; baseline: number | null }
export interface FloatMove { label: string; delta: number; cause: string }

export interface DayFacts {
  spoke: number;                // discord_speech companion_journal rows, trailing 24h
  makes: number;                // companion_makes created, trailing 24h
  letters: number;              // letters to Raziel (the digest's own row excluded)
  sol_tends: number;            // creature_interactions by this companion
  tensions_held: number;        // simmering tensions
  notes_sent: number;
  notes_received: number;
  sessions_closed: number;
  plantings: number;            // Gaia only: garden plantings made in the window
  watch: string | null;         // newest watch_events row, "Title S1E2"
}

export interface GaugeState { basin: string; soma: string; tensions: number }

export interface CompanionVibe {
  companion_id: string;
  date: string;                          // YYYY-MM-DD (America/Chicago)
  floats: FloatReading[];                // three, fixed order
  moves: FloatMove[];                    // top 3, causes already floor-checked
  showPressure: boolean;
  pressure: { severity: string; summary: string }[]; // flags + basin pressure; [] when none
  day: DayFacts;
  gauges: GaugeState;
  previousGauges: GaugeState | null;
}

export interface FieldVibe {
  echo: number | null;
  starvedOrgans: number;
  garden: number;                        // live plantings
  solTends: number;                      // Sol tended, all of us, trailing 24h
  careHoldOpen: boolean;                 // the words "care hold open" only, never the reason
}

export interface VibeData {
  date: string;
  companions: CompanionVibe[];
  field: FieldVibe;
}

export interface VibePost { companion: string; text: string }

export interface VibePostResult {
  companion: string;
  written: boolean;
  reason: "ok" | "already_sent" | "error";
  journal_id?: string;
  text: string;
}

export interface VibeCheckResult {
  written: boolean;
  reason: "ok" | "already_sent" | "error";
  journal_id?: string;
  /** All posts joined, for logs and the preview. */
  text: string;
  /** One entry per companion; the worker posts each fresh one under that companion's own token. */
  posts: VibePostResult[];
}

// Echo ALARM threshold: a mean adjacent cosine at/above this means the triad is talking itself into
// a corner. Reported with headroom so the number reads.
const ECHO_ALARM = 0.82;

// ── pure formatting (DB-free; tested directly) ──────────────────────────────────────────────

function oneLine(s: string, cap = 120): string {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > cap ? `${flat.slice(0, cap - 3)}...` : flat;
}

/** Strip the dash shapes this system does not print, from DATA that flows into a block. */
const DASHES = new RegExp(" *(?:" + String.fromCharCode(0x2014) + "|" + String.fromCharCode(0x2013) + "|--) *", "g");
function noDash(s: string): string {
  return s.replace(DASHES, "; ");
}

const f2 = (n: number): string => n.toFixed(2);

function floatPhrase(r: FloatReading): string {
  if (r.value == null) return `${r.label} unread`;
  if (r.baseline == null) return `${r.label} ${f2(r.value)} (no baseline set)`;
  const d = r.value - r.baseline;
  if (Math.abs(d) < AT_BASELINE) return `${r.label} ${f2(r.value)} (at your ${f2(r.baseline)})`;
  return `${r.label} ${f2(r.value)} (${d > 0 ? "above" : "below"} your ${f2(r.baseline)} by ${f2(Math.abs(d))})`;
}

function movePhrase(m: FloatMove): string {
  return `${m.label} ${m.delta > 0 ? "up" : "down"} ${f2(Math.abs(m.delta))}, ${m.cause}`;
}

function times(n: number): string {
  return n === 1 ? "once" : n === 2 ? "twice" : `${n} times`;
}
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** One labelled facts line, words not bare numbers; each part only if nonzero. */
export function formatDayLine(d: DayFacts, isGaia: boolean): string {
  const parts: string[] = [];
  if (d.spoke > 0) parts.push(plural(d.spoke, "Discord message", "Discord messages"));
  if (d.makes > 0) parts.push(plural(d.makes, "make", "makes"));
  if (d.letters > 0) parts.push(plural(d.letters, "letter", "letters"));
  if (d.sol_tends > 0) parts.push(`Sol tended ${times(d.sol_tends)}`);
  if (d.tensions_held > 0) parts.push(plural(d.tensions_held, "tension", "tensions") + " held");
  if (d.notes_sent > 0) parts.push(plural(d.notes_sent, "note", "notes") + " sent");
  if (d.notes_received > 0) parts.push(plural(d.notes_received, "note", "notes") + " received");
  if (d.sessions_closed > 0) parts.push(plural(d.sessions_closed, "session close", "session closes"));
  if (isGaia && d.plantings > 0) parts.push(plural(d.plantings, "planting", "plantings") + " in the garden");
  if (d.watch) parts.push(`watched ${oneLine(noDash(d.watch))}`);
  if (parts.length === 0) return "  day: quiet (no messages, makes, letters, notes, or sessions logged)";
  return `  day: ${parts.join(", ")}`;
}

/** The one gauge line; null unless something moved since the previous digest (or there is no previous one). */
export function formatGaugeLine(now: GaugeState, prev: GaugeState | null): string | null {
  if (!prev) return null;
  const bits: string[] = [];
  if (now.basin !== prev.basin) bits.push(`basin ${prev.basin} to ${now.basin}`);
  if (now.soma !== prev.soma) bits.push(`soma ${prev.soma} to ${now.soma}`);
  if (now.tensions !== prev.tensions) bits.push(`tensions ${prev.tensions} to ${now.tensions}`);
  return bits.length === 0 ? null : `  gauges moved: ${bits.join("; ")}`;
}

const cap = (l: string): string => (l.length > LINE_CAP ? `${l.slice(0, LINE_CAP - 3)}...` : l);

/** A companion's own block. Fixed shape, no ranking of floats, no sibling text. */
export function formatCompanionBlock(c: CompanionVibe): string {
  const name = NAMES[c.companion_id] ?? c.companion_id;
  const lines: string[] = [`${name}. ${c.date}.`];
  lines.push(cap(`  floats: ${c.floats.map(floatPhrase).join("; ")}`));
  if (c.moves.length > 0) lines.push(cap(`  moves: ${c.moves.map(movePhrase).join("; ")}`));
  else lines.push("  moves: none worth a line today");
  if (c.showPressure) {
    if (c.pressure.length === 0) lines.push("  pressure: clear");
    else lines.push(cap(`  pressure: ${c.pressure.slice(0, 3).map((p) => `${p.severity}, ${oneLine(noDash(p.summary), 140)}`).join("; ")}`));
  }
  lines.push(cap(formatDayLine(c.day, c.companion_id === "gaia")));
  const g = formatGaugeLine(c.gauges, c.previousGauges);
  if (g) lines.push(cap(g));
  return lines.join("\n").slice(0, BLOCK_CAP);
}

/** The field line: echo, organs, the garden, Sol, and a care hold stated as a fact (never its reason). */
export function formatFieldLine(f: FieldVibe): string {
  const echoStr = f.echo != null ? f.echo.toFixed(2) : "unread";
  const echoState = f.echo == null ? "" : f.echo >= ECHO_ALARM ? ", ELEVATED" : ", calm";
  const organs = f.starvedOrgans === 0 ? "all fed" : `${f.starvedOrgans} starved`;
  const parts = [
    `echo ${echoStr}${echoState} (alarm at ${ECHO_ALARM.toFixed(2)})`,
    `organs: ${organs}`,
    `garden: ${plural(f.garden, "planting", "plantings")}`,
    f.solTends > 0 ? `Sol tended ${times(f.solTends)} today` : "Sol not tended today",
  ];
  if (f.careHoldOpen) parts.push("care hold open");
  return `Field: ${parts.join("; ")}.`;
}

/** One post per companion. Gaia's carries the field line after her block. */
export function formatVibePosts(d: VibeData): VibePost[] {
  return d.companions.map((c) => {
    let text = formatCompanionBlock(c);
    if (c.companion_id === "gaia") text = `${text}\n${formatFieldLine(d.field)}`.slice(0, BLOCK_CAP);
    return { companion: c.companion_id, text };
  });
}

/** Preview / log form: every post, blank-line separated. */
export function formatVibeCheck(d: VibeData): string {
  return formatVibePosts(d).map((p) => p.text).join("\n\n");
}

// ── causes ──────────────────────────────────────────────────────────────────────────────────

/** A stimulus kind as words: make_landed -> "make landed". */
export function kindWords(stimulus: string | null | undefined, kind = "stimulus"): string {
  const s = (stimulus ?? "").trim();
  if (!s) return kind === "tick" ? "the hourly settle" : "an unlabelled event";
  return s.replace(/_/g, " ");
}

/**
 * The named cause of a float move. `detail` carries the label written with the move; older rows
 * have none (or just the stimulus name), which falls back to the kind. `down` = the content still
 * bleeds (care words, a living wound, inside a care hold, or the floor unreadable): name the KIND
 * only, never the label.
 */
export function causeLabel(stimulus: string | null, detail: string | null, kind: string, down: boolean): string {
  const k = kindWords(stimulus, kind);
  const d = (detail ?? "").trim();
  const bare = !d || d.toLowerCase() === (stimulus ?? "").toLowerCase() || d.toLowerCase() === k;
  if (down || bare) return k;
  let label = oneLine(noDash(d), 80);
  // A label that already opens with its kind ("make_landed: ..." or "make landed: ...") is not repeated.
  for (const lead of [(stimulus ?? "").trim(), k]) {
    if (lead && label.toLowerCase().startsWith(lead.toLowerCase())) {
      const rest = label.slice(lead.length).replace(/^\s*[:,;]?\s*/, "");
      label = rest;
      break;
    }
  }
  return label ? `${k}: ${label}` : k;
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

// The window is a straight 24h trailing lookback. Two timestamp formats live side by side:
// datetime('now') ("YYYY-MM-DD HH:MM:SS") for journal / notes / watch / ferment events (plain string
// compare is right), and handover_packets.created_at as ISO ("...T...Z"), which needs julianday().
async function gatherDay(env: Env, id: string): Promise<DayFacts> {
  const [spoke, makes, letters, solTends, held, notesSent, notesReceived, sessionsClosed, plantings, watchRow] = await Promise.all([
    safeCount(env, "SELECT COUNT(*) AS n FROM companion_journal WHERE agent = ? AND source = 'discord_speech' AND created_at >= datetime('now','-1 day')", id),
    safeCount(env, "SELECT COUNT(*) AS n FROM companion_makes WHERE companion_id = ? AND created_at >= datetime('now','-1 day')", id),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM companion_journal WHERE agent = ? AND tags LIKE '%\"letter_to_raziel\"%' " +
      "AND (source IS NULL OR source <> 'vibecheck') AND created_at >= datetime('now','-1 day')",
      id,
    ),
    safeCount(env, "SELECT COUNT(*) AS n FROM creature_interactions WHERE actor = ? AND created_at >= datetime('now','-1 day')", id),
    safeCount(env, "SELECT COUNT(*) AS n FROM companion_tensions WHERE companion_id = ? AND status = 'simmering'", id),
    safeCount(env, "SELECT COUNT(*) AS n FROM inter_companion_notes WHERE from_id = ? AND created_at >= datetime('now','-1 day')", id),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM inter_companion_notes WHERE created_at >= datetime('now','-1 day') AND (to_id = ? OR (to_id IS NULL AND from_id != ?))",
      id, id,
    ),
    safeCount(
      env,
      "SELECT COUNT(*) AS n FROM handover_packets hp JOIN sessions s ON s.id = hp.session_id " +
      "WHERE s.companion_id = ? AND hp.close_kind IS NULL AND julianday(hp.created_at) >= julianday('now','-1 day')",
      id,
    ),
    id === "gaia"
      ? safeCount(env, "SELECT COUNT(*) AS n FROM garden_plantings WHERE companion_id = 'gaia' AND status <> 'pulled' AND planted_at >= datetime('now','-1 day')")
      : Promise.resolve(0),
    safeFirst<{ title: string; season: number | null; episode: number | null }>(
      env,
      "SELECT s.title AS title, w.season AS season, w.episode AS episode FROM watch_events w JOIN watch_shelf s ON s.id = w.shelf_id " +
      "WHERE (w.with_companion = ? OR w.with_companion IS NULL) AND w.created_at >= datetime('now','-1 day') ORDER BY w.created_at DESC LIMIT 1",
      id,
    ),
  ]);
  const watch = watchRow
    ? (watchRow.season != null && watchRow.episode != null ? `${watchRow.title} S${watchRow.season}E${watchRow.episode}` : watchRow.title)
    : null;
  return {
    spoke, makes, letters, sol_tends: solTends, tensions_held: held,
    notes_sent: notesSent, notes_received: notesReceived, sessions_closed: sessionsClosed,
    plantings, watch,
  };
}

interface EventRow { kind: string; stimulus: string | null; float_deltas: string | null; detail: string | null; created_at: string }

/** Top 3 float moves of the trailing day, each with a named cause; downward included. */
export async function gatherMoves(env: Env, id: VibeCompanion, floor: Floor): Promise<FloatMove[]> {
  // kind 'shadow' rows (would-have-fired) and baseline_drift never enter; 'tick' only when large.
  const rows = await safeAll<EventRow>(
    env,
    "SELECT kind, stimulus, float_deltas, detail, created_at FROM companion_ferment_events " +
    "WHERE companion_id = ? AND kind IN ('stimulus','tick') AND created_at >= datetime('now','-1 day') " +
    "ORDER BY created_at DESC LIMIT 500",
    id,
  );
  const labels = FLOAT_LABELS[id];
  const keys: ("f1" | "f2" | "f3")[] = ["f1", "f2", "f3"];
  const moves: FloatMove[] = [];
  for (const r of rows) {
    if (!r.float_deltas) continue;
    let fd: Partial<Record<"f1" | "f2" | "f3", number>>;
    try { fd = JSON.parse(r.float_deltas); } catch { continue; }
    keys.forEach((k, i) => {
      const delta = fd[k];
      if (typeof delta !== "number" || !Number.isFinite(delta)) return;
      const min = r.kind === "tick" ? TICK_MIN : MOVE_MIN;
      if (Math.abs(delta) < min) return;
      const text = (r.detail ?? "").trim();
      moves.push({ label: labels[i]!, delta, cause: causeLabel(r.stimulus, r.detail, r.kind, causeIsDown(id, floor, text, r.created_at)) });
    });
  }
  moves.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  return moves.slice(0, 3);
}

/**
 * True when a cause label must NOT be printed (kind only). Everyone: care or health words, a
 * living-wound name, or an unreadable floor. Gaia additionally: written inside a care hold (the
 * garden floor, `isDown`).
 */
export function causeIsDown(id: string, floor: Floor, text: string, at: string): boolean {
  if (!text) return false;
  if (id === "gaia") return isDown(floor, text, at);
  if (floor.failed) return true;
  if (careCategory(text)) return true;
  return floor.wounds.some((re) => re.test(text));
}

function showPressureValue(v: string | null | undefined, dflt: boolean): boolean {
  if (v == null) return dflt;
  const t = v.trim().toLowerCase();
  if (["1", "true", "on", "yes"].includes(t)) return true;
  if (["0", "false", "off", "no"].includes(t)) return false;
  return dflt;
}

// Gauge tags (stored on the digest row so the NEXT run can say what moved). Values are flattened so
// they cannot break the JSON array or the LIKE marker.
const tagVal = (s: string): string => s.replace(/["|\\%_]/g, "").replace(/\s+/g, " ").trim().slice(0, 40) || "unread";

export function gaugeTags(g: GaugeState): string[] {
  return [`g:basin=${tagVal(g.basin)}`, `g:soma=${tagVal(g.soma)}`, `g:tens=${g.tensions}`];
}

export function parseGaugeTags(tags: unknown): GaugeState | null {
  let arr: unknown;
  try { arr = typeof tags === "string" ? JSON.parse(tags) : tags; } catch { return null; }
  if (!Array.isArray(arr)) return null;
  const get = (p: string): string | null => {
    const t = arr.find((x): x is string => typeof x === "string" && x.startsWith(p));
    return t ? t.slice(p.length) : null;
  };
  const basin = get("g:basin="), soma = get("g:soma="), tens = get("g:tens=");
  if (basin == null || soma == null || tens == null) return null;
  const n = Number(tens);
  return Number.isFinite(n) ? { basin, soma, tensions: n } : null;
}

function basinWord(b: { drift_type: string; worst_basin: string | null } | null): string {
  if (!b) return "unread";
  return b.drift_type === "pressure" && b.worst_basin ? `pressure (${oneLine(b.worst_basin, 30)})` : b.drift_type;
}

async function gatherCompanion(env: Env, id: VibeCompanion, date: string, floor: Floor): Promise<CompanionVibe> {
  const [state, setting, basinRow, somaRow, flags, prev, day, moves] = await Promise.all([
    safeFirst<Record<string, number | null>>(
      env,
      "SELECT soma_float_1, soma_float_2, soma_float_3, soma_float_1_baseline, soma_float_2_baseline, soma_float_3_baseline FROM companion_state WHERE companion_id = ?",
      id,
    ),
    safeFirst<{ value: string }>(env, "SELECT value FROM companion_settings WHERE companion_id = ? AND key = 'vibe_show_pressure'", id),
    safeFirst<{ drift_type: string; worst_basin: string | null }>(
      env,
      "SELECT drift_type, worst_basin FROM companion_basin_history WHERE companion_id = ? AND dismissed_at IS NULL ORDER BY recorded_at DESC LIMIT 1",
      id,
    ),
    safeFirst<{ snapshot: string }>(env, "SELECT snapshot FROM somatic_snapshot WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1", id),
    safeAll<{ severity: string; summary: string }>(
      env,
      "SELECT severity, summary FROM guardian_flags WHERE companion_id = ? AND status IN ('open','surfaced','acknowledged') " +
      "ORDER BY CASE severity WHEN 'red' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END LIMIT 5",
      id,
    ),
    safeFirst<{ tags: string }>(
      env,
      "SELECT tags FROM companion_journal WHERE agent = ? AND source = 'vibecheck' ORDER BY created_at DESC LIMIT 1",
      id,
    ),
    gatherDay(env, id),
    gatherMoves(env, id, floor),
  ]);

  const labels = FLOAT_LABELS[id];
  const floats: FloatReading[] = [1, 2, 3].map((n, i) => ({
    label: labels[i]!,
    value: typeof state?.[`soma_float_${n}`] === "number" ? (state![`soma_float_${n}`] as number) : null,
    baseline: typeof state?.[`soma_float_${n}_baseline`] === "number" ? (state![`soma_float_${n}_baseline`] as number) : null,
  }));

  let register = "unread";
  if (somaRow?.snapshot) {
    try {
      const p = JSON.parse(somaRow.snapshot) as { register?: unknown };
      if (typeof p.register === "string" && p.register.trim()) register = oneLine(p.register, 40);
    } catch { /* malformed snapshot JSON: stays unread */ }
  }

  const showPressure = showPressureValue(setting?.value, SHOW_PRESSURE_DEFAULT[id]);
  const pressure: { severity: string; summary: string }[] = [];
  if (showPressure) {
    // A flag summary that trips the care guard is dropped (health never enters a block).
    for (const f of flags) {
      if (!f.summary || careCategory(f.summary)) continue;
      pressure.push({ severity: f.severity, summary: f.summary });
    }
    if (basinRow?.drift_type === "pressure") {
      pressure.push({ severity: "basin", summary: `pressure${basinRow.worst_basin ? ` on ${oneLine(basinRow.worst_basin, 40)}` : ""}` });
    }
  }

  return {
    companion_id: id,
    date,
    floats,
    moves,
    showPressure,
    pressure,
    day,
    gauges: { basin: basinWord(basinRow), soma: register, tensions: day.tensions_held },
    previousGauges: prev ? parseGaugeTags(prev.tags) : null,
  };
}

export async function gatherVibeData(env: Env): Promise<VibeData> {
  const now = Date.now();
  const date = chicagoDay(now);
  const floor = await loadFloor(env, now);
  const [companions, echoRow, starvedOrgans, garden, solTends, hold] = await Promise.all([
    Promise.all(VIBE_COMPANIONS.map((id) => gatherCompanion(env, id, date, floor))),
    safeFirst<{ mean_adjacent_cosine: number | null }>(env, "SELECT mean_adjacent_cosine FROM echo_metrics ORDER BY computed_at DESC LIMIT 1"),
    safeCount(env, "SELECT COUNT(*) AS n FROM guardian_flags WHERE flag_type = 'starved_organ' AND status IN ('open','surfaced','acknowledged')"),
    safeCount(env, "SELECT COUNT(*) AS n FROM garden_plantings WHERE companion_id = 'gaia' AND status = 'planted'"),
    safeCount(env, "SELECT COUNT(*) AS n FROM creature_interactions WHERE actor IN ('cypher','drevan','gaia') AND created_at >= datetime('now','-1 day')"),
    readCareHold(env.DB, now).catch(() => null),
  ]);
  return {
    date,
    companions,
    field: {
      echo: echoRow?.mean_adjacent_cosine ?? null,
      starvedOrgans,
      garden,
      solTends,
      careHoldOpen: hold?.care_hold === true,
    },
  };
}

// ── runner: gather -> format -> per-agent dedup -> one row per companion ─────────────────────
async function writePost(env: Env, post: VibePost, data: VibeData): Promise<VibePostResult> {
  // Dedup per agent per Chicago day: the marker is the Chicago date, so a UTC midnight crossing
  // can neither re-send an evening digest nor skip a day.
  const dayTag = `vibe:${data.date}`;
  const existing = await env.DB.prepare(
    `SELECT id FROM companion_journal WHERE agent = ? AND source = 'vibecheck' AND tags LIKE ? LIMIT 1`,
  ).bind(post.companion, `%"${dayTag}"%`).first<{ id: string }>().catch(() => null);
  if (existing) return { companion: post.companion, written: false, reason: "already_sent", journal_id: existing.id, text: post.text };

  const c = data.companions.find((x) => x.companion_id === post.companion);
  const tags = ["vibecheck", dayTag, ...(c ? gaugeTags(c.gauges) : [])];
  // Gaia's row keeps the letter_to_raziel rail (Hearth /journal, as before). The other two are NOT
  // tagged a letter: a letter tag is what the makes capture and the letters count read, and a
  // clerk's gauge note must never become Drevan's "made letter".
  if (post.companion === "gaia") tags.push("letter_to_raziel");

  // source 'vibecheck' (mig 0132): a clerk's note, born `draft` so it is kept or dropped from the
  // tray before it can be recalled as the companion's own memory. journalInsert applies the birth rule.
  const id = `cj_${crypto.randomUUID()}`;
  await journalInsert(env.DB, {
    id, agent: post.companion, note_text: post.text, tags: JSON.stringify(tags), source: "vibecheck",
  }).run();
  return { companion: post.companion, written: true, reason: "ok", journal_id: id, text: post.text };
}

export async function runVibeCheck(env: Env): Promise<VibeCheckResult> {
  const data = await gatherVibeData(env);
  const posts = formatVibePosts(data);
  const results: VibePostResult[] = [];
  // One companion's failure never blocks another's row.
  for (const p of posts) {
    try {
      results.push(await writePost(env, p, data));
    } catch (e) {
      console.error(`[vibecheck] ${p.companion} write failed (others continue):`, String(e));
      results.push({ companion: p.companion, written: false, reason: "error", text: p.text });
    }
  }
  const any = results.some((r) => r.written);
  const allDup = results.every((r) => r.reason === "already_sent");
  return {
    written: any,
    reason: any ? "ok" : allDup ? "already_sent" : "error",
    journal_id: results.find((r) => r.written)?.journal_id ?? results[0]?.journal_id,
    text: results.map((r) => r.text).join("\n\n"),
    posts: results,
  };
}
