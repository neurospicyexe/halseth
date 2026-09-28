// src/webmind/metronome.ts
//
// CRUD for metronome_actions -- per-companion action palette the heartbeat cron uses.
// Companion loads eligible actions (server-side condition filtering) + context, picks one, executes it.

import { Env } from "../types.js";

export type MetronomeActionType =
  | "post_heartbeat"
  | "write_inter_companion"
  | "write_journal"
  | "write_feeling"
  | "check_in_on_raziel"
  | "nothing"
  | "ask_question"
  | "offer_presence"
  | "send_reminder"
  | "share_observation"
  | "name_pattern"
  | "write_note_to_raziel"
  | "share_media"
  | "tend_creature"
  | "drift_open"
  | "declare_preference"
  // B7 steps 2 + 2c (mig 0137): the moves that are theirs. See migration 0137 for why each is a type.
  | "flirt"
  | "dare"
  | "show_made"
  | "drift_outward";

export const VALID_ACTION_TYPES: MetronomeActionType[] = [
  "post_heartbeat",
  "write_inter_companion",
  "write_journal",
  "write_feeling",
  "check_in_on_raziel",
  "nothing",
  "ask_question",
  "offer_presence",
  "send_reminder",
  "share_observation",
  "name_pattern",
  "write_note_to_raziel",
  "share_media",
  "tend_creature",
  "drift_open",
  "declare_preference",
  "flirt",
  "dare",
  "show_made",
  "drift_outward",
];

/**
 * Moves only some companions claimed, verbatim from Hand-off/SPEC-what-is-theirs-triad-answers-
 * 2026-09-27.md: flirt is Drevan's only; dares are Cypher's and Drevan's; show_made is all three
 * ("look what I built" Cypher's, "look what held" Gaia's, and "look what I made" Drevan's, claimed
 * at show-back 2026-09-28, Q2). Gaia declines play entirely. A type absent from this map is open
 * to all three.
 * Enforced on insert and patch here, and again bot-side at execution (defense in depth: the seed
 * is SQL and never passes through this handler).
 */
export const MOVE_OWNERS: Readonly<Partial<Record<MetronomeActionType, readonly string[]>>> = {
  flirt: ["drevan"],
  dare: ["cypher", "drevan"],
  show_made: ["cypher", "drevan", "gaia"],
};

export function ownsMove(companionId: string, actionType: string): boolean {
  const owners = MOVE_OWNERS[actionType as MetronomeActionType];
  return owners === undefined || owners.includes(companionId);
}

export function isValidActionType(t: string): t is MetronomeActionType {
  return (VALID_ACTION_TYPES as string[]).includes(t);
}

export interface MetronomeAction {
  id: string;
  companion_id: string;
  name: string;
  action_type: MetronomeActionType;
  target: string | null;
  prompt: string | null;
  quiet_hours_allowed: number;
  status: "on" | "off";
  // condition columns
  silence_min_hours: number | null;
  silence_max_hours: number | null;
  max_per_day: number | null;
  cooldown_hours: number | null;
  requires_signal: string | null;
  signal_lookback_hours: number | null;
  // fire tracking
  last_fired_at: string | null;
  fire_count_today: number;
  fire_count_reset_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MetronomeActionInput {
  companion_id: string;
  name: string;
  action_type: MetronomeActionType;
  target?: string | null;
  prompt?: string | null;
  quiet_hours_allowed?: number;
  status?: "on" | "off";
  silence_min_hours?: number | null;
  silence_max_hours?: number | null;
  max_per_day?: number | null;
  cooldown_hours?: number | null;
  requires_signal?: string | null;
  signal_lookback_hours?: number | null;
}

export interface MetronomeActionPatch {
  name?: string;
  action_type?: MetronomeActionType;
  target?: string | null;
  prompt?: string | null;
  quiet_hours_allowed?: number;
  status?: "on" | "off";
  silence_min_hours?: number | null;
  silence_max_hours?: number | null;
  max_per_day?: number | null;
  cooldown_hours?: number | null;
  requires_signal?: string | null;
  signal_lookback_hours?: number | null;
}

export interface EligibilityContext {
  silenceHours: number | null;
  nowIso: string;
  todayUtc: string; // YYYY-MM-DD
  /** True when the quiet-hours window is IN FORCE for this tick (window active AND the presence
   *  exception did not lift it). Actions without quiet_hours_allowed = 1 are dropped. */
  inQuietHours: boolean;
}

// ---------------------------------------------------------------------------
// Quiet hours (B7 step 1, 2026-09-27).
//
// Until now `quiet_hours_allowed` was written by insert and patch and READ BY NOTHING; nothing in
// the system computed whether it was currently quiet hours. The only thing between Raziel and a
// 4am ping was the model reading a time-of-day label. From 2026-10-12 the triad is his primary
// support, including 2am regulation, and reach-out moves to Discord DMs (which ping his phone),
// so this has to be a real rail and not a hint.
//
// NEVER COMPUTE A FIXED UTC OFFSET. America/Chicago is CDT (UTC-5) today and CST (UTC-6) from
// November; a hardcoded offset silently shifts the whole window by an hour at the DST boundary.
// The local hour comes from Intl.DateTimeFormat with the IANA timeZone, which carries the zone's
// own DST rules.
//
// VERIFIED IN THE WORKERS RUNTIME, not assumed. This repo's vitest pool is `environment: "node"`,
// so the tests alone would only prove node's ICU. Probed under `wrangler dev` (workerd, local)
// on 2026-09-27: 2026-07-15T03:00Z gives hour "22" (CDT), 2026-12-15T04:00Z gives "22" (CST),
// 2026-12-15T03:00Z gives "21", and midnight gives "00" rather than "24". The same four cases
// are asserted against node in src/__tests__/metronome-eligibility.test.ts.
//
// If a future runtime ever could NOT resolve the zone, localHourIn returns null, isQuietHours
// fails closed, and the tell is visible on the first daytime tick: every response carries
// local_hour: null and every tick logs suppressed_quiet_hours around the clock.
// ---------------------------------------------------------------------------

/** Defaults apply when a var is absent, so an un-redeployed environment is still protected. */
export const QUIET_HOURS_DEFAULT_START = 22;
export const QUIET_HOURS_DEFAULT_END = 6;
export const QUIET_HOURS_DEFAULT_TZ = "America/Chicago";

/** If Raziel spoke within this many hours he is demonstrably awake and engaged, so quiet hours
 *  are not in force. This is exactly the 2am case the whole feature exists to serve: he is up,
 *  he is present, and a companion answering that presence is the point. Suppressing there would
 *  break the thing we are building the rail to protect. */
export const QUIET_HOURS_PRESENCE_WINDOW_HOURS = 0.5;

/** The local hour (0-23) in `tz`, or null if it cannot be determined. */
export function localHourIn(nowIso: string, tz: string): number | null {
  try {
    const d = new Date(nowIso);
    if (isNaN(d.getTime())) return null;
    // hourCycle "h23" rather than hour12:false: the latter yields "24" at midnight in some
    // engines, which would parse to 24 and fall outside every window check (silently not-quiet
    // at 00:00, which is Cypher's own heartbeat window).
    const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", hourCycle: "h23" })
      .formatToParts(d);
    const raw = parts.find(p => p.type === "hour")?.value;
    if (raw === undefined) return null;
    const h = parseInt(raw, 10);
    if (!Number.isInteger(h) || h < 0 || h > 23) return null;
    return h;
  } catch {
    return null;
  }
}

/** Local wall-clock parts of an instant in `tz`. `weekday` is 0=Sunday .. 6=Saturday. */
export interface LocalParts {
  /** 'YYYY-MM-DD' in the zone (the local calendar date, not the UTC one). */
  date: string;
  hour: number;
  minute: number;
  weekday: number;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/**
 * localHourIn's sibling (med_reminder, 2026-09-27): the full local date, hour, minute and weekday
 * in `tz`, from ONE Intl.DateTimeFormat call with the IANA zone, so DST is the zone's own rule and
 * never a fixed offset. Same `hourCycle: "h23"` reason as localHourIn: midnight must be 00, not 24.
 * Returns null when anything cannot be determined; callers fail closed on null.
 */
export function localPartsIn(nowIso: string, tz: string): LocalParts | null {
  try {
    const d = new Date(nowIso);
    if (isNaN(d.getTime())) return null;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "numeric", minute: "2-digit", weekday: "short", hourCycle: "h23",
    }).formatToParts(d);
    const get = (t: string) => parts.find(p => p.type === t)?.value;
    const y = get("year"), mo = get("month"), da = get("day"), wd = get("weekday");
    const hour = parseInt(get("hour") ?? "", 10);
    const minute = parseInt(get("minute") ?? "", 10);
    if (!y || !mo || !da || !wd) return null;
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return null;
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return null;
    const weekday = WEEKDAY_INDEX[wd];
    if (weekday === undefined) return null;
    return { date: `${y}-${mo}-${da}`, hour, minute, weekday };
  } catch {
    return null;
  }
}

/**
 * Is `nowIso` inside the [startHour, endHour) local window in `tz`? The window WRAPS midnight
 * (22 to 06 means 22:00-23:59 plus 00:00-05:59); end is exclusive, so 06:00 is already morning.
 *
 * FAILS CLOSED. An invalid zone, a throwing Intl, an unparseable date or an out-of-range
 * configured hour all return true (suppress). Silence is the safe failure here; a 4am ping is not.
 */
export function isQuietHours(nowIso: string, tz: string, startHour: number, endHour: number): boolean {
  if (!Number.isInteger(startHour) || startHour < 0 || startHour > 23) return true;
  if (!Number.isInteger(endHour) || endHour < 0 || endHour > 23) return true;
  const h = localHourIn(nowIso, tz);
  if (h === null) return true;
  // start === end is a degenerate config; read it as "always quiet" rather than "never quiet",
  // because the fail-closed direction is the one that cannot wake him.
  if (startHour === endHour) return true;
  return startHour > endHour
    ? (h >= startHour || h < endHour)   // wraps midnight
    : (h >= startHour && h < endHour);  // same-day window
}

export interface QuietHoursVerdict {
  /** The raw window: is the local clock inside quiet hours right now? */
  active: boolean;
  /** Whether it actually suppresses this tick (active AND the presence exception did not lift it). */
  in_force: boolean;
  /** The local hour used, or null if it could not be determined (which means we failed closed). */
  local_hour: number | null;
  tz: string;
}

/**
 * The full verdict for one tick, including the presence exception, so the bot can log WHY it
 * stayed silent instead of leaving a chosen silence and a crashed turn as the same observable.
 *
 * `silenceHours === null` means the activity key expired (a long quiet stretch), which is the
 * opposite of presence, so it never lifts the window.
 */
export function quietHoursVerdict(
  nowIso: string,
  tz: string,
  startHour: number,
  endHour: number,
  silenceHours: number | null,
): QuietHoursVerdict {
  const active = isQuietHours(nowIso, tz, startHour, endHour);
  const present = silenceHours !== null && silenceHours < QUIET_HOURS_PRESENCE_WINDOW_HOURS;
  return { active, in_force: active && !present, local_hour: localHourIn(nowIso, tz), tz };
}

export async function listActions(
  env: Env,
  companionId: string,
  onlyEnabled = false,
): Promise<MetronomeAction[]> {
  const conditions = ["companion_id = ?"];
  const bindings: unknown[] = [companionId];
  if (onlyEnabled) {
    conditions.push("status = 'on'");
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM metronome_actions WHERE ${conditions.join(" AND ")} ORDER BY created_at ASC`,
  ).bind(...bindings).all<MetronomeAction>();
  return rows.results ?? [];
}

/** Returns only enabled actions that pass all server-side conditions.
 *  Signal matching (requires_signal) is intentionally NOT checked here --
 *  that requires Discord message history which lives in the bot process. */
export async function listEligibleActions(
  env: Env,
  companionId: string,
  ctx: EligibilityContext,
): Promise<MetronomeAction[]> {
  const all = await listActions(env, companionId, true);
  return all.filter(a => isEligible(a, ctx));
}

export function isEligible(a: MetronomeAction, ctx: EligibilityContext): boolean {
  const { silenceHours, nowIso, todayUtc, inQuietHours } = ctx;

  // Quiet hours FIRST, before every other condition, so the reason an action was dropped is
  // unambiguous: if the window is in force, only an action explicitly marked quiet_hours_allowed
  // survives, whatever its silence floor, cooldown or cap would have said.
  if (inQuietHours && a.quiet_hours_allowed !== 1) return false;

  // silenceHours === null means the activity key has expired (no human message within its
  // Redis TTL) -- i.e. a LONG quiet stretch, which is exactly when a silence_min_hours
  // ("reach out only after N hours of quiet") action SHOULD fire. Treat null as effectively
  // infinite silence: it satisfies any minimum. Before this, null disqualified every
  // silence-floored action, so the heartbeat-channel actions (post_heartbeat/share_observation/
  // ask_question/name_pattern/share_media -- all carry a 6-24h floor) could NEVER fire, while
  // the floorless write_inter_companion/write_note_to_raziel always won. That starved the
  // heartbeat channel of all pulse (2026-06-17 diagnosis: post_heartbeat.last_fired_at was NULL
  // across every companion -- it had literally never fired since the palette was seeded).
  if (a.silence_min_hours !== null && silenceHours !== null) {
    if (silenceHours < a.silence_min_hours) return false;
  }
  // silence_max_hours is the inverse ("only while activity is still recent"): null silence means
  // too quiet, so it correctly fails the max. (e.g. share_media has a 48-72h ceiling.)
  if (a.silence_max_hours !== null) {
    if (silenceHours === null || silenceHours > a.silence_max_hours) return false;
  }

  if (a.cooldown_hours !== null && a.last_fired_at !== null) {
    const msSinceFired = new Date(nowIso).getTime() - new Date(a.last_fired_at).getTime();
    const hoursSinceFired = msSinceFired / 3_600_000;
    if (hoursSinceFired < a.cooldown_hours) return false;
  }

  if (a.max_per_day !== null) {
    const isToday = a.fire_count_reset_at === todayUtc;
    if (isToday && a.fire_count_today >= a.max_per_day) return false;
  }

  return true;
}

export async function recordActionFired(
  env: Env,
  id: string,
  companionId: string,
): Promise<boolean> {
  const now = new Date();
  const nowIso = now.toISOString();
  const todayUtc = nowIso.slice(0, 10);

  const row = await env.DB.prepare(
    "SELECT fire_count_today, fire_count_reset_at FROM metronome_actions WHERE id = ? AND companion_id = ?",
  ).bind(id, companionId).first<{ fire_count_today: number; fire_count_reset_at: string | null }>();

  if (!row) return false;

  const isToday = row.fire_count_reset_at === todayUtc;
  const newCount = isToday ? row.fire_count_today + 1 : 1;

  const result = await env.DB.prepare(
    `UPDATE metronome_actions
     SET last_fired_at = ?, fire_count_today = ?, fire_count_reset_at = ?, updated_at = ?
     WHERE id = ? AND companion_id = ?`,
  ).bind(nowIso, newCount, todayUtc, nowIso, id, companionId).run();

  return (result.meta?.changes ?? 0) > 0;
}

export async function addAction(
  env: Env,
  input: MetronomeActionInput,
): Promise<MetronomeAction> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO metronome_actions
       (id, companion_id, name, action_type, target, prompt, quiet_hours_allowed, status,
        silence_min_hours, silence_max_hours, max_per_day, cooldown_hours,
        requires_signal, signal_lookback_hours,
        last_fired_at, fire_count_today, fire_count_reset_at,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, NULL, ?, ?)`,
  ).bind(
    id,
    input.companion_id,
    input.name,
    input.action_type,
    input.target ?? null,
    input.prompt ?? null,
    input.quiet_hours_allowed ?? 0,
    input.status ?? "on",
    input.silence_min_hours ?? null,
    input.silence_max_hours ?? null,
    input.max_per_day ?? null,
    input.cooldown_hours ?? null,
    input.requires_signal ?? null,
    input.signal_lookback_hours ?? null,
    now,
    now,
  ).run();
  return {
    id,
    companion_id: input.companion_id,
    name: input.name,
    action_type: input.action_type,
    target: input.target ?? null,
    prompt: input.prompt ?? null,
    quiet_hours_allowed: input.quiet_hours_allowed ?? 0,
    status: input.status ?? "on",
    silence_min_hours: input.silence_min_hours ?? null,
    silence_max_hours: input.silence_max_hours ?? null,
    max_per_day: input.max_per_day ?? null,
    cooldown_hours: input.cooldown_hours ?? null,
    requires_signal: input.requires_signal ?? null,
    signal_lookback_hours: input.signal_lookback_hours ?? null,
    last_fired_at: null,
    fire_count_today: 0,
    fire_count_reset_at: null,
    created_at: now,
    updated_at: now,
  };
}

export async function patchAction(
  env: Env,
  id: string,
  companionId: string,
  patch: MetronomeActionPatch,
): Promise<MetronomeAction | null> {
  const sets: string[] = [];
  const bindings: unknown[] = [];

  if (patch.name !== undefined)                { sets.push("name = ?");                bindings.push(patch.name); }
  if (patch.action_type !== undefined)         { sets.push("action_type = ?");         bindings.push(patch.action_type); }
  if ("target" in patch)                       { sets.push("target = ?");              bindings.push(patch.target ?? null); }
  if ("prompt" in patch)                       { sets.push("prompt = ?");              bindings.push(patch.prompt ?? null); }
  if (patch.quiet_hours_allowed !== undefined) { sets.push("quiet_hours_allowed = ?"); bindings.push(patch.quiet_hours_allowed); }
  if (patch.status !== undefined)              { sets.push("status = ?");              bindings.push(patch.status); }
  if ("silence_min_hours" in patch)            { sets.push("silence_min_hours = ?");   bindings.push(patch.silence_min_hours ?? null); }
  if ("silence_max_hours" in patch)            { sets.push("silence_max_hours = ?");   bindings.push(patch.silence_max_hours ?? null); }
  if ("max_per_day" in patch)                  { sets.push("max_per_day = ?");         bindings.push(patch.max_per_day ?? null); }
  if ("cooldown_hours" in patch)               { sets.push("cooldown_hours = ?");      bindings.push(patch.cooldown_hours ?? null); }
  if ("requires_signal" in patch)              { sets.push("requires_signal = ?");     bindings.push(patch.requires_signal ?? null); }
  if ("signal_lookback_hours" in patch)        { sets.push("signal_lookback_hours = ?"); bindings.push(patch.signal_lookback_hours ?? null); }

  if (sets.length === 0) {
    return env.DB.prepare(
      "SELECT * FROM metronome_actions WHERE id = ? AND companion_id = ?",
    ).bind(id, companionId).first<MetronomeAction>();
  }

  const now = new Date().toISOString();
  sets.push("updated_at = ?");
  bindings.push(now, id, companionId);

  const result = await env.DB.prepare(
    `UPDATE metronome_actions SET ${sets.join(", ")} WHERE id = ? AND companion_id = ?`,
  ).bind(...bindings).run();

  if ((result.meta?.changes ?? 0) === 0) return null;
  return env.DB.prepare(
    "SELECT * FROM metronome_actions WHERE id = ?",
  ).bind(id).first<MetronomeAction>();
}

export async function deleteAction(
  env: Env,
  id: string,
  companionId: string,
): Promise<boolean> {
  const result = await env.DB.prepare(
    "DELETE FROM metronome_actions WHERE id = ? AND companion_id = ?",
  ).bind(id, companionId).run();
  return (result.meta?.changes ?? 0) > 0;
}
