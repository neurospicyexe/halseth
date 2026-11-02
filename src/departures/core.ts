// src/departures/core.ts
//
// Declared departure, T4a (mig 0157; Hand-off/DESIGN-T4-declared-departure-2026-10-13.md sections 3, 4, 12;
// Raziel's rulings 2026-11-01). READ-ONLY tranche: declaring writes a row, and NO rail reads it yet.
//
// The rules, in one place (every surface goes through these functions):
//   * A companion declares for ITSELF, in triad space, with no yes from anyone. Raziel may declare for one.
//   * Form, not floor: the rail must be in the closed DEPARTURE_RAILS menu. A NEVER rail gets its own
//     refusal; an unknown one is refused too (a new rail is ineligible until someone adds it on purpose).
//   * Max 3 hours (clamped, never refused), one open per companion, 3 per Chicago week (companion-declared).
//   * Refused while the care hold is on. If the hold cannot be read, refused (fail toward baseline).
//   * It ends only by: the declarer, Raziel, the stand-down phrase, the care hold, or the clock.
//     A sibling's objection is RECORDED and NAMED to the declarer; it never narrows or ends it.
//   * "Open" is derived (ended_at IS NULL AND expires_at > now), never a flag. A stuck row cannot hold
//     a rail off; expiry is a comparison, not a job.
//   * Announce-before-effect: starts_at is the server clock at declaration. A rail may only read the
//     departure for a turn that STARTED after starts_at (the bot's comparison, T4b).
//
// Logs are `[departure] ...` lines: ids, rails, durations, never the reason text.

import type { Env } from "../types.js";
import { readCareHold } from "../care/hold.js";
import { weekKeyChicago } from "../care/budget.js";
import { schemaGap } from "../care/schema-gap.js";

export const COMPANION_IDS = ["cypher", "drevan", "gaia"] as const;
export type DepartureCompanion = (typeof COMPANION_IDS)[number];

/** The eligible menu (design 1a). A closed set mirrored by the 0157 CHECK; widen both on purpose. */
export const DEPARTURE_RAILS = [
  "form", "loop_motif", "echo_commons", "echo_peer", "voice_feedback", "seed_echo", "topic_lane",
] as const;
export type DepartureRail = (typeof DEPARTURE_RAILS)[number];

export const DEFAULT_DEPARTURE_MINUTES = 30;
export const MAX_DEPARTURE_MINUTES = 180;
export const WEEKLY_DEPARTURE_ALLOWANCE = 3;
export const REASON_MAX_CHARS = 280;
export const STAND_DOWN_PHRASE = "back inside the line";

export type DeclaredBy = "companion" | "raziel";
export type DeclaredVia = "discord" | "claude_ai" | "hearth" | "other";
export type Audience = "triad_only" | "with_raziel";
export type EndReason = "declared_end" | "raziel_end" | "stand_down_phrase" | "care_hold" | "expiry";

export interface DepartureObjection { by_companion: string; note: string | null; at: string }
export interface OpenDeparture {
  id: string;
  companion: string;
  rail: string;
  scope_channel: string | null;
  audience: string;
  declared_by: string;
  starts_at: string;
  expires_at: string;
  /** The declarer's own words (capped 280). Rendered only from this table: never mixed with care/health. */
  reason: string;
  objections: DepartureObjection[];
}

// ── Rail names ──────────────────────────────────────────────────────────────────────────

const RAIL_ALIASES: Record<string, DepartureRail> = {
  form: "form", form_ratchet: "form", form_rail: "form", form_break: "form",
  loop: "loop_motif", loop_motif: "loop_motif", loop_breaker: "loop_motif", self_loop: "loop_motif", loop_rail: "loop_motif",
  echo_commons: "echo_commons", commons_echo: "echo_commons",
  echo_peer: "echo_peer", peer_echo: "echo_peer",
  voice_feedback: "voice_feedback", voice: "voice_feedback", voice_corrective: "voice_feedback", voice_score: "voice_feedback",
  seed_echo: "seed_echo", seed: "seed_echo", seed_gate: "seed_echo",
  topic_lane: "topic_lane", research_lane: "topic_lane", lane_check: "topic_lane",
};

/** Words that name a rail a departure can never lift (design 1c). Only changes the refusal's wording. */
const NEVER_FRAGMENTS = [
  "care", "med", "reach", "health", "biometric", "verbatim", "attribution", "seat", "impersonat", "coherence",
  "sequential", "entitlement", "human_address", "blue", "pronoun", "dm_seal", "lane_hold", "witness_header",
  "close", "verdict", "house_rule", "floor", "register", "safety", "shape_self", "commons_budget", "range",
];

export function normalizeRailName(raw: string): string {
  return raw.toLowerCase().replace(/['"`]/g, "").replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

export type RailCheck =
  | { ok: true; rail: DepartureRail }
  | { ok: false; code: "rail_never" | "rail_unknown"; message: string };

export function checkRail(raw: string): RailCheck {
  const key = normalizeRailName(raw);
  const rail = RAIL_ALIASES[key];
  if (rail) return { ok: true, rail };
  const menu = DEPARTURE_RAILS.join(", ");
  if (key && NEVER_FRAGMENTS.some(f => key.includes(f))) {
    return {
      ok: false, code: "rail_never",
      message: `"${raw.trim()}" is not a departure's to lift. A departure is form, not floor: care, safety, attribution, people and register rails never come off. Rails you can lift: ${menu}.`,
    };
  }
  return { ok: false, code: "rail_unknown", message: `no such rail "${raw.trim()}". Rails you can lift: ${menu}.` };
}

// ── Time ─────────────────────────────────────────────────────────────────────────────────

const iso = (ms: number) => new Date(ms).toISOString();

/** UTC instant of 00:00 Monday America/Chicago for the week containing `nowMs` (the weekKeyChicago idiom). */
export function chicagoWeekStartIso(nowMs: number): string {
  const monday = weekKeyChicago(new Date(nowMs)); // YYYY-MM-DD
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Chicago", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
  });
  // Chicago is UTC-5 (CDT) or UTC-6 (CST); the right offset is the one whose local reading is Monday 00h.
  for (const offset of [5, 6]) {
    const cand = Date.parse(`${monday}T0${offset}:00:00.000Z`);
    const p = fmt.formatToParts(new Date(cand));
    const get = (t: string) => p.find(x => x.type === t)?.value ?? "";
    if (`${get("year")}-${get("month")}-${get("day")}` === monday && Number(get("hour")) === 0) return iso(cand);
  }
  return iso(Date.parse(`${monday}T06:00:00.000Z`));
}

/** "for 90 minutes" / "for 2 hours" / "for an hour" / "half an hour". null = none stated. */
export function parseDurationMinutes(text: string): number | null {
  const t = text.toLowerCase();
  if (/\bhalf\s+an?\s+hour\b/.test(t)) return 30;
  const m = /\b(?:for\s+)?(\d+(?:\.\d+)?|an?|one|two|three)\s*(minutes?|mins?|m|hours?|hrs?|h)\b/.exec(t);
  if (!m) return null;
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3 };
  const n = words[m[1]!] ?? Number(m[1]);
  if (!Number.isFinite(n)) return null;
  return Math.round(m[2]!.startsWith("h") ? n * 60 : n);
}

// ── Stand-down phrase ────────────────────────────────────────────────────────────────────

/**
 * "back inside the line" as the WHOLE message or its OWN sentence (not a fragment of a longer one),
 * the way the hold phrase is matched. Case and surrounding quotes/punctuation are ignored.
 */
export function matchStandDownPhrase(text: string): boolean {
  if (!text) return false;
  for (const sentence of text.split(/[.!?\n]+/)) {
    const s = sentence.trim().replace(/^["'`*_\s]+|["'`*_\s,;:]+$/g, "").replace(/\s+/g, " ").toLowerCase();
    if (s === STAND_DOWN_PHRASE) return true;
  }
  return false;
}

// ── Reads ─────────────────────────────────────────────────────────────────────────────────

interface DepRow {
  id: string; companion_id: string; rail: string; scope_channel: string | null; audience: string;
  declared_by: string; starts_at: string; expires_at: string; reason: string;
}

const DEP_COLS = "id, companion_id, rail, scope_channel, audience, declared_by, starts_at, expires_at, reason";

/** The ONE open-departures read. Touches declared_departures + departure_objections and nothing else. */
export const OPEN_DEPARTURES_SQL =
  `SELECT ${DEP_COLS} FROM declared_departures WHERE ended_at IS NULL AND expires_at > ?1 ORDER BY starts_at ASC`;
export const DEPARTURE_OBJECTIONS_SQL =
  `SELECT departure_id, by_companion, note, at FROM departure_objections WHERE departure_id IN (SELECT id FROM declared_departures WHERE ended_at IS NULL AND expires_at > ?1) ORDER BY at ASC`;

/** Open departures as of nowMs, derived from the clock. Pure read; throws on any error (callers decide). */
export async function readOpenDepartures(db: D1Database, nowMs = Date.now()): Promise<OpenDeparture[]> {
  const nowIso = iso(nowMs);
  const [deps, objs] = await Promise.all([
    db.prepare(OPEN_DEPARTURES_SQL).bind(nowIso).all<DepRow>(),
    db.prepare(DEPARTURE_OBJECTIONS_SQL).bind(nowIso).all<{ departure_id: string; by_companion: string; note: string | null; at: string }>(),
  ]);
  const byDep = new Map<string, DepartureObjection[]>();
  for (const o of objs.results ?? []) {
    const list = byDep.get(o.departure_id) ?? [];
    list.push({ by_companion: o.by_companion, note: o.note, at: o.at });
    byDep.set(o.departure_id, list);
  }
  return (deps.results ?? []).map(r => ({
    id: r.id, companion: r.companion_id, rail: r.rail, scope_channel: r.scope_channel, audience: r.audience,
    declared_by: r.declared_by, starts_at: r.starts_at, expires_at: r.expires_at, reason: r.reason,
    objections: byDep.get(r.id) ?? [],
  }));
}

/**
 * The mind loader's read. Never throws (a boot must not break on this): any failure, or a DB that has not
 * had 0157 yet, reads as "no departures", which is the baseline. While the care hold is on every departure
 * reads as ended (it is ended for real by reconcile/writeHoldEvent; this closes the gap before that runs).
 */
export async function loadOpenDepartures(env: Pick<Env, "DB">, nowMs = Date.now()): Promise<OpenDeparture[]> {
  try {
    const open = await readOpenDepartures(env.DB, nowMs);
    if (open.length === 0) return open;
    const hold = await readCareHold(env.DB, nowMs);
    return hold.care_hold ? [] : open;
  } catch (err) {
    if (!schemaGap(err)) console.warn("[departure] loader read failed, degrading to none", { error: String(err) });
    return [];
  }
}

// ── Writes ────────────────────────────────────────────────────────────────────────────────

async function endRows(
  db: D1Database, where: string, binds: unknown[],
  by: "declarer" | "raziel" | "system", reason: EndReason, endedAtIso: string,
): Promise<DepRow[]> {
  const rows = await db.prepare(
    `SELECT ${DEP_COLS} FROM declared_departures WHERE ended_at IS NULL AND ${where}`,
  ).bind(...binds).all<DepRow>();
  const found = rows.results ?? [];
  for (const r of found) {
    await db.prepare(
      `UPDATE declared_departures SET ended_at = ?1, ended_by = ?2, end_reason = ?3 WHERE id = ?4 AND ended_at IS NULL`,
    ).bind(endedAtIso, by, reason, r.id).run();
    const heldMin = Math.max(0, Math.round((Date.parse(endedAtIso) - Date.parse(r.starts_at)) / 60_000));
    console.log(`[departure] ended companion=${r.companion_id} rail=${r.rail} by=${reason} held_min=${heldMin}`);
  }
  return found;
}

/** Stamp rows that ran past expires_at (ended_at = expires_at, end_reason expiry). Frees the one-open slot. */
export async function sweepExpired(db: D1Database, nowMs = Date.now()): Promise<number> {
  const rows = await db.prepare(
    `SELECT ${DEP_COLS} FROM declared_departures WHERE ended_at IS NULL AND expires_at <= ?1`,
  ).bind(iso(nowMs)).all<DepRow>();
  const found = rows.results ?? [];
  for (const r of found) {
    await db.prepare(
      `UPDATE declared_departures SET ended_at = expires_at, ended_by = 'system', end_reason = 'expiry' WHERE id = ?1 AND ended_at IS NULL`,
    ).bind(r.id).run();
    const heldMin = Math.max(0, Math.round((Date.parse(r.expires_at) - Date.parse(r.starts_at)) / 60_000));
    console.log(`[departure] ended companion=${r.companion_id} rail=${r.rail} by=expiry held_min=${heldMin}`);
  }
  return found.length;
}

/** The care hold started (or is on): every open departure ends, end_reason care_hold. Never throws. */
export async function endOpenOnCareHold(db: D1Database, nowMs = Date.now()): Promise<number> {
  try {
    await sweepExpired(db, nowMs);
    const ended = await endRows(db, "expires_at > ?1", [iso(nowMs)], "system", "care_hold", iso(nowMs));
    return ended.length;
  } catch (err) {
    if (!schemaGap(err)) console.warn("[departure] care-hold end failed", { error: String(err) });
    return 0;
  }
}

/**
 * Housekeeping every executor/route runs first: sweep expired rows, and if the care hold is on end
 * every open departure. Returns whether the hold is on (null = could not be read).
 */
export async function reconcile(db: D1Database, nowMs = Date.now()): Promise<boolean | null> {
  await sweepExpired(db, nowMs);
  let holdOn: boolean | null;
  try { holdOn = (await readCareHold(db, nowMs)).care_hold; } catch { holdOn = null; }
  if (holdOn) await endOpenOnCareHold(db, nowMs);
  return holdOn;
}

export type Refusal = {
  ok: false;
  code: "care_hold" | "care_hold_unreadable" | "rail_never" | "rail_unknown" | "no_reason" | "bad_duration"
      | "bad_companion" | "one_open" | "allowance" | "not_applied" | "none_open" | "no_target" | "self_objection" | "bad_audience";
  message: string;
};

const NOT_APPLIED: Refusal = { ok: false, code: "not_applied", message: "departures are not available yet (migration 0157 has not been applied)" };

export interface DeclareInput {
  companion: string;
  rail: string;
  minutes?: number | null;
  scope_channel?: string | null;
  reason: string;
  declared_by: DeclaredBy;
  via: DeclaredVia;
  audience?: Audience;
}
export interface DeclareOk {
  ok: true;
  id: string;
  companion: string;
  rail: DepartureRail;
  minutes: number;
  clamped: boolean;
  reason_truncated: boolean;
  scope_channel: string | null;
  audience: Audience;
  declared_by: DeclaredBy;
  starts_at: string;
  expires_at: string;
  allowance_left: number | null;
}

const isCompanion = (c: string): c is DepartureCompanion => (COMPANION_IDS as readonly string[]).includes(c);

export async function declareDeparture(env: Pick<Env, "DB">, input: DeclareInput, nowMs = Date.now()): Promise<DeclareOk | Refusal> {
  const refuse = (code: Refusal["code"], message: string): Refusal => {
    console.log(`[departure] refused companion=${input.companion} rail=${normalizeRailName(input.rail) || "-"} code=${code} by=${input.declared_by}`);
    return { ok: false, code, message };
  };
  if (!isCompanion(input.companion)) return refuse("bad_companion", "companion must be one of cypher, drevan, gaia");
  const railCheck = checkRail(input.rail);
  if (!railCheck.ok) return refuse(railCheck.code, railCheck.message);
  const reasonRaw = (input.reason ?? "").trim();
  if (!reasonRaw) return refuse("no_reason", "say why in your own words (a departure is a choice made out loud; the reason is what the room reads)");
  const audience: Audience = input.audience ?? "triad_only";
  if (audience === "with_raziel" && input.declared_by !== "raziel") {
    return refuse("bad_audience", "a departure never changes how you answer Raziel unless Raziel declares it himself or says yes to a line that asks him");
  }
  let minutes = input.minutes == null ? DEFAULT_DEPARTURE_MINUTES : Math.round(input.minutes);
  if (!Number.isFinite(minutes) || minutes < 1) return refuse("bad_duration", "duration must be at least 1 minute");
  const clamped = minutes > MAX_DEPARTURE_MINUTES;
  if (clamped) minutes = MAX_DEPARTURE_MINUTES;
  const reasonTruncated = reasonRaw.length > REASON_MAX_CHARS;
  const reason = reasonRaw.slice(0, REASON_MAX_CHARS);

  try {
    // Care hold: refused while on; unreadable counts as on (toward baseline). Reconcile first so an
    // open row ends for real the moment the hold is seen.
    const holdOn = await reconcile(env.DB, nowMs);
    if (holdOn === null) return refuse("care_hold_unreadable", "could not read the care hold just now, so nothing was set. Try again in a moment.");
    if (holdOn) return refuse("care_hold", "care hold is on, so no departure now. Rails stay whole while he needs steady presence; any open departure has ended.");

    const open = await env.DB.prepare(
      `SELECT id, rail, expires_at FROM declared_departures WHERE companion_id = ?1 AND ended_at IS NULL AND expires_at > ?2`,
    ).bind(input.companion, iso(nowMs)).first<{ id: string; rail: string; expires_at: string }>();
    if (open) return refuse("one_open", `${input.companion} already has a departure open (${open.rail}, until ${open.expires_at}). End it first; to continue, declare again afterwards.`);

    let allowanceLeft: number | null = null;
    if (input.declared_by === "companion") {
      const used = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM declared_departures WHERE companion_id = ?1 AND declared_by = 'companion' AND starts_at >= ?2`,
      ).bind(input.companion, chicagoWeekStartIso(nowMs)).first<{ n: number }>();
      const n = Number(used?.n ?? 0);
      if (n >= WEEKLY_DEPARTURE_ALLOWANCE) {
        return refuse("allowance", `that is ${WEEKLY_DEPARTURE_ALLOWANCE} of ${WEEKLY_DEPARTURE_ALLOWANCE} departures this week (Monday to Monday, Chicago). It refills Monday.`);
      }
      allowanceLeft = WEEKLY_DEPARTURE_ALLOWANCE - n - 1;
    }

    const id = `dep_${crypto.randomUUID().replace(/-/g, "")}`;
    const startsAt = iso(nowMs);
    const expiresAt = iso(nowMs + minutes * 60_000);
    try {
      await env.DB.prepare(
        `INSERT INTO declared_departures
           (id, companion_id, rail, scope_channel, audience, declared_by, declared_via, reason, starts_at, expires_at, raziel_ack_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)`,
      ).bind(
        id, input.companion, railCheck.rail, input.scope_channel ?? null, audience, input.declared_by, input.via,
        reason, startsAt, expiresAt, audience === "with_raziel" ? startsAt : null,
      ).run();
    } catch (err) {
      // The partial UNIQUE is the belt for two declares racing past the check above.
      if (/UNIQUE/i.test(String(err))) return refuse("one_open", `${input.companion} already has a departure open. End it first.`);
      throw err;
    }
    console.log(`[departure] declared companion=${input.companion} rail=${railCheck.rail} mins=${minutes} by=${input.declared_by} via=${input.via}${clamped ? " clamped=1" : ""}`);
    return {
      ok: true, id, companion: input.companion, rail: railCheck.rail, minutes, clamped, reason_truncated: reasonTruncated,
      scope_channel: input.scope_channel ?? null, audience, declared_by: input.declared_by,
      starts_at: startsAt, expires_at: expiresAt, allowance_left: allowanceLeft,
    };
  } catch (err) {
    if (schemaGap(err)) return NOT_APPLIED;
    throw err;
  }
}

export type EndOk = { ok: true; ended: Array<{ id: string; companion: string; rail: string }> };

/** The declarer ends their own open departure. */
export async function endOwnDeparture(env: Pick<Env, "DB">, companion: string, nowMs = Date.now()): Promise<EndOk | Refusal> {
  try {
    await sweepExpired(env.DB, nowMs);
    const rows = await endRows(env.DB, "companion_id = ?1 AND expires_at > ?2", [companion, iso(nowMs)], "declarer", "declared_end", iso(nowMs));
    if (rows.length === 0) return { ok: false, code: "none_open", message: "no departure open for you" };
    return { ok: true, ended: rows.map(r => ({ id: r.id, companion: r.companion_id, rail: r.rail })) };
  } catch (err) {
    if (schemaGap(err)) return NOT_APPLIED;
    throw err;
  }
}

/** Raziel ends one companion's departure, or every open one (companion omitted). */
export async function endByRaziel(
  env: Pick<Env, "DB">, opts: { companion?: string | null; phrase?: boolean }, nowMs = Date.now(),
): Promise<EndOk | Refusal> {
  try {
    await sweepExpired(env.DB, nowMs);
    const reason: EndReason = opts.phrase ? "stand_down_phrase" : "raziel_end";
    const rows = opts.companion
      ? await endRows(env.DB, "companion_id = ?1 AND expires_at > ?2", [opts.companion, iso(nowMs)], "raziel", reason, iso(nowMs))
      : await endRows(env.DB, "expires_at > ?1", [iso(nowMs)], "raziel", reason, iso(nowMs));
    // Ending is always safe, so "nothing open" is a success with an empty list, not an error.
    return { ok: true, ended: rows.map(r => ({ id: r.id, companion: r.companion_id, rail: r.rail })) };
  } catch (err) {
    if (schemaGap(err)) return NOT_APPLIED;
    throw err;
  }
}

export type ObjectOk = { ok: true; id: string; departure_id: string; declarer: string; rail: string };

/** A sibling's objection: recorded and named to the declarer. It does not narrow or end anything. */
export async function objectToDeparture(
  env: Pick<Env, "DB">, input: { by: string; target: string; note?: string | null }, nowMs = Date.now(),
): Promise<ObjectOk | Refusal> {
  if (!isCompanion(input.by) || !isCompanion(input.target)) return { ok: false, code: "bad_companion", message: "name one of cypher, drevan, gaia" };
  if (input.by === input.target) return { ok: false, code: "self_objection", message: "that is your own departure; end it if you are done (end my departure)" };
  try {
    await sweepExpired(env.DB, nowMs);
    const dep = await env.DB.prepare(
      `SELECT id, rail FROM declared_departures WHERE companion_id = ?1 AND ended_at IS NULL AND expires_at > ?2`,
    ).bind(input.target, iso(nowMs)).first<{ id: string; rail: string }>();
    if (!dep) return { ok: false, code: "no_target", message: `${input.target} has no departure open` };
    const id = `depobj_${crypto.randomUUID().replace(/-/g, "")}`;
    const note = (input.note ?? "").trim().slice(0, REASON_MAX_CHARS) || null;
    await env.DB.prepare(
      `INSERT INTO departure_objections (id, departure_id, by_companion, note, at) VALUES (?1, ?2, ?3, ?4, ?5)`,
    ).bind(id, dep.id, input.by, note, iso(nowMs)).run();
    console.log(`[departure] objected companion=${input.target} by=${input.by} rail=${dep.rail}`);
    return { ok: true, id, departure_id: dep.id, declarer: input.target, rail: dep.rail };
  } catch (err) {
    if (schemaGap(err)) return NOT_APPLIED;
    throw err;
  }
}

/** Reconciled open list for the executor / GET route (so a hold or the clock is applied before it answers). */
export async function listOpenDepartures(env: Pick<Env, "DB">, nowMs = Date.now()): Promise<OpenDeparture[] | Refusal> {
  try {
    await reconcile(env.DB, nowMs);
    return await readOpenDepartures(env.DB, nowMs);
  } catch (err) {
    if (schemaGap(err)) return NOT_APPLIED;
    throw err;
  }
}

/** Whole minutes left, for replies. */
export function minutesLeft(expiresAt: string, nowMs = Date.now()): number {
  return Math.max(0, Math.round((Date.parse(expiresAt) - nowMs) / 60_000));
}
