// src/webmind/creatures.ts
//
// Creatures (migration 0078, inspo take 10). A companion-pet corvid + Raziel's real
// animals modeled as named presences living in Halseth. Trust builds slowly through
// interaction (feed/play/talk/give) and decays toward a floor when untended. A daily
// tick recomputes trust + mood (corvid daemon-tick analog -- deterministic, NO LLM).
//
// Two write paths, two disciplines:
//   - interact: SQL-level atomic trust bump (owner + triad can interact concurrently --
//     never a JS read-modify-write on the hot trust field).
//   - tick: a single daily server-side pass (no concurrency) reads each row, computes
//     decayed trust + derived mood with the pure helpers below, writes it back.

export type CreatureAction = "feed" | "play" | "talk" | "give";

export const VALID_ACTIONS: readonly CreatureAction[] = ["feed", "play", "talk", "give"];

export function isValidAction(a: string): a is CreatureAction {
  return (VALID_ACTIONS as readonly string[]).includes(a);
}

// Trust never falls below this floor (the seeded baseline) -- a creature you have met
// does not become a stranger again, it only cools.
export const TRUST_BASELINE = 0.1;
// Untended trust cools this much per day toward the baseline.
export const TRUST_DECAY_PER_DAY = 0.03;

const TRUST_DELTA: Record<CreatureAction, number> = {
  talk: 0.03,
  feed: 0.04,
  play: 0.05,
  give: 0.06,
};

const ACTION_MOOD: Record<CreatureAction, string> = {
  feed: "content",
  play: "playful",
  talk: "engaged",
  give: "delighted",
};

/** Trust gained from one interaction of the given kind. */
export function trustDelta(action: CreatureAction): number {
  return TRUST_DELTA[action];
}

/** Mood a fresh interaction leaves the creature in. */
export function actionMood(action: CreatureAction): string {
  return ACTION_MOOD[action];
}

/** Clamp a trust value into [0, 1]. */
export function clampTrust(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Trust after `daysSince` untended, cooling toward `baseline` at `ratePerDay`.
 * Monotonic non-increasing (untended time never *builds* trust) and never below
 * baseline. Already-cool creatures (trust <= baseline) are left untouched.
 */
export function decayedTrust(
  trust: number,
  daysSince: number,
  baseline = TRUST_BASELINE,
  ratePerDay = TRUST_DECAY_PER_DAY,
): number {
  if (daysSince <= 0) return clampTrust(trust);
  if (trust <= baseline) return clampTrust(trust);
  const cooled = trust - ratePerDay * daysSince;
  return clampTrust(Math.max(baseline, cooled));
}

/** Mood label derived from a trust level (used by the daily tick as the creature settles). */
export function deriveMood(trust: number): string {
  if (trust >= 0.7) return "affectionate";
  if (trust >= 0.4) return "watchful";
  if (trust >= 0.2) return "wary";
  return "aloof";
}

/** Whole days since a D1 datetime ("YYYY-MM-DD HH:MM:SS" UTC / ISO), clamped >= 0. */
export function daysSinceIso(iso: string | null | undefined, nowMs = Date.now()): number {
  if (!iso) return 0;
  const ms = Date.parse(iso.includes("T") ? iso : iso.replace(" ", "T") + "Z");
  return Number.isNaN(ms) ? 0 : Math.max(0, (nowMs - ms) / 86_400_000);
}

// ── SQL builders (asserted as strings in tests; D1 is the runtime) ──────────────

/** All creatures, ordered for display. No bind. */
export function listCreaturesSql(): string {
  return `SELECT id, name, species, kind, owner, bio, state_json, trust, last_interaction_at, created_at FROM creatures ORDER BY kind ASC, name ASC`;
}

/** One creature by id. Bind: [id]. */
export function getCreatureSql(): string {
  return `SELECT id, name, species, kind, owner, bio, state_json, trust, last_interaction_at, created_at FROM creatures WHERE id = ?`;
}

/** Recent interactions for a creature. Bind: [creature_id, limit]. */
export function recentInteractionsSql(): string {
  return `SELECT id, actor, action, note, created_at FROM creature_interactions WHERE creature_id = ? ORDER BY created_at DESC LIMIT ?`;
}

/** Append-only interaction log row. Bind: [id, creature_id, actor, action, note]. */
export function insertInteractionSql(): string {
  return `INSERT INTO creature_interactions (id, creature_id, actor, action, note) VALUES (?, ?, ?, ?, ?)`;
}

/**
 * Atomic trust bump + action-mood + restamp on interaction. SQL-level clamp so
 * concurrent owner/triad interactions never lose a write to a JS RMW race.
 * Bind: [delta, mood, creature_id].
 */
export function interactBumpSql(): string {
  return `UPDATE creatures SET trust = MIN(1.0, MAX(0.0, trust + ?)), state_json = json_set(COALESCE(state_json,'{}'), '$.mood', ?), last_interaction_at = datetime('now') WHERE id = ?`;
}

/** Write a tick-computed trust + mood back to one creature. Bind: [trust, mood, id]. */
export function tickUpdateSql(): string {
  return `UPDATE creatures SET trust = ?, state_json = json_set(COALESCE(state_json,'{}'), '$.mood', ?) WHERE id = ?`;
}

// ── Sol need-state helpers (pure, derived) ────────────────────────────────────

export type Disposition = "absent" | "aloof" | "watchful" | "present" | "affectionate";

// Untended need, derived (no table). Grows ~linearly to 1 over RESTLESS_FULL_DAYS.
export const RESTLESS_FULL_DAYS = 7;
export function restlessness(
  lastInteractionAt: string | null,
  createdAt: string,
  nowMs: number = Date.now(),
): number {
  const days = daysSinceIso(lastInteractionAt ?? createdAt, nowMs);
  return Math.min(1, Math.max(0, days / RESTLESS_FULL_DAYS));
}

// Trust gives warmth; restlessness pulls Sol away (a neglected crow keeps its distance).
export function presenceDisposition(trust: number, restless: number): Disposition {
  if (restless >= 0.85) return "absent";
  if (trust >= 0.7) return restless < 0.4 ? "affectionate" : "present";
  if (trust >= 0.4) return restless < 0.5 ? "watchful" : "aloof";
  return restless < 0.3 ? "aloof" : "absent";
}

// ── Sol orient block (pure, no DB) ───────────────────────────────────────────

interface SolRow { name: string; species: string | null; trust: number; last_interaction_at: string | null; created_at: string; }
export function buildSolBlock(c: SolRow, nowMs: number = Date.now()): string {
  const r = restlessness(c.last_interaction_at, c.created_at, nowMs);
  const disp = presenceDisposition(c.trust, r);
  const days = Math.floor(daysSinceIso(c.last_interaction_at ?? c.created_at, nowMs));
  const since = c.last_interaction_at ? `${days} day${days === 1 ? "" : "s"} since tended` : "never tended";
  return `\n[Sol]\n${c.name} (${c.species ?? "crow"}) -- trust ${c.trust.toFixed(2)}, ${disp}, ${since}.` +
    (disp === "absent" || disp === "aloof"
      ? ` Sol is keeping its distance; a little tending would bring it back.`
      : ` Sol is around; you can mention it to Raziel or tend it yourself.`);
}

// Keep in sync with autonomous-worker/src/sol-presence.ts PALETTE (the worker mirrors these for Sol's channel moments).
// Deterministic moment palette keyed by disposition. null = Sol does not show.
const SOL_PALETTE: Record<Disposition, string[]> = {
  absent: [],
  aloof: [
    "*a black shape watches from the far rail, unmoving, then is gone.*",
    "*one wingbeat against the window — Sol, keeping its distance.*",
  ],
  watchful: [
    "*Sol lands on the sill, head cocked, weighing the room before settling.*",
    "*a low, considering* kraa *from the gutter — Sol is paying attention.*",
  ],
  present: [
    "*a scuff of talons — Sol drops a dull bottlecap where you'll find it, and waits.*",
    "*Sol hops closer along the rail, leaving a twist of bright wire as toll.*",
  ],
  affectionate: [
    "*Sol settles near, preens once, and sets a small smooth stone beside your hand.* 🪶",
    "*a soft, throaty* prruk *— Sol leans in, unhurried, glad of you.*",
  ],
};
export function solMoment(disp: Disposition, seed: number): string | null {
  const palette = SOL_PALETTE[disp];
  if (!palette || palette.length === 0) return null;
  const idx = Math.abs(Math.floor(seed)) % palette.length;
  return palette[idx]!;
}
