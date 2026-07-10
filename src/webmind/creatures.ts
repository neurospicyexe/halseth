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

// ── Drives (corvid take 2, mig 0100): lazy, derived, no stored floats ─────────
//
// Corvid runs a 5-minute daemon tick over 14 chemicals; a Worker can't hold a
// process, so every drive here is a pure function of timestamps the interaction
// ledger already carries (the Zikkaron lazy-heat idiom). Same felt result, zero
// cron additions.

export interface DriveState {
  hunger: number;   // wants YOUR food (he forages fine; this is about company)
  boredom: number;  // days since anyone played
  missing: number;  // days since anyone at all (== restlessness)
  energy: number;   // circadian; a crow keeps crow hours
}

export const HUNGER_FULL_DAYS = 2.5;
export const BOREDOM_FULL_DAYS = 4;

/**
 * Circadian energy on crow hours, approximated in Raziel's timezone (fixed
 * UTC-5; a crow does not observe DST either). Dawn ramp, loud all morning,
 * midday lull, dusk activity, roost by night.
 */
export function circadianEnergy(nowMs: number = Date.now()): number {
  const d = new Date(nowMs);
  const hour = (d.getUTCHours() + d.getUTCMinutes() / 60 - 5 + 24) % 24;
  if (hour < 5) return 0.05;
  if (hour < 8) return 0.05 + ((hour - 5) / 3) * 0.95;
  if (hour < 12) return 1.0;
  if (hour < 16) return 0.7;
  if (hour < 19) return 0.85;
  if (hour < 22) return 0.85 - ((hour - 19) / 3) * 0.8;
  return 0.05;
}

/** Per-action last-interaction timestamps (from the ledger; null = never). */
export interface LastActed { feed: string | null; play: string | null; any: string | null; }

export function deriveDrives(last: LastActed, createdAt: string, nowMs: number = Date.now()): DriveState {
  const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
  return {
    hunger: clamp01(daysSinceIso(last.feed ?? createdAt, nowMs) / HUNGER_FULL_DAYS),
    boredom: clamp01(daysSinceIso(last.play ?? createdAt, nowMs) / BOREDOM_FULL_DAYS),
    missing: restlessness(last.any, createdAt, nowMs),
    energy: circadianEnergy(nowMs),
  };
}

// Dominant state: the loudest drive over threshold wins; below it, contentment.
// Tie order is deliberate: a sleepy crow sleeps before it sulks.
export type SolState = "sleepy" | "hungry" | "missing" | "bored" | "content";
export const DOMINANT_THRESHOLD = 0.45;

export function dominantState(drives: DriveState): SolState {
  const ranked: Array<[SolState, number]> = [
    ["sleepy", 1 - drives.energy],
    ["hungry", drives.hunger],
    ["missing", drives.missing],
    ["bored", drives.boredom],
  ];
  let best: [SolState, number] = ranked[0]!;
  for (const r of ranked) if (r[1] > best[1]) best = r;
  return best[1] >= DOMINANT_THRESHOLD ? best[0] : "content";
}

// ── Trust tiers (the corvid behaviors.md expression filter) ──────────────────

export type TrustTier = "abandoned" | "wary" | "cautious" | "warming" | "bonded" | "devoted";
export function trustTier(trust: number): TrustTier {
  if (trust < 0.15) return "abandoned";
  if (trust < 0.35) return "wary";
  if (trust < 0.6) return "cautious";
  if (trust < 0.8) return "warming";
  if (trust < 0.95) return "bonded";
  return "devoted";
}

// Authoring granularity: six tiers read, three write.
export type TierGroup = "low" | "mid" | "high";
export function tierGroup(tier: TrustTier): TierGroup {
  if (tier === "abandoned" || tier === "wary") return "low";
  if (tier === "cautious" || tier === "warming") return "mid";
  return "high";
}

// ── The moment matrix ─────────────────────────────────────────────────────────
//
// Variety through composition, not content: dominant drive x tier group, each
// cell 2-3 authored strings. Ten flat palette strings become ~35 that multiply
// against live state. Deterministic pick by seed; still zero LLM.

const MOMENTS: Record<SolState, Record<TierGroup, string[]>> = {
  hungry: {
    low: [
      "*Sol lands on the far post, eyes the empty rail where food sometimes is, and leaves before anyone can see him wanting.*",
      "*a quick shadow over the seed tray; it's empty; the shadow doesn't come back.*",
    ],
    mid: [
      "*Sol paces the rail near the door, not subtle at all, pretending to inspect the wood.*",
      "*two short* kraas *at the window, then a pointed look at the seed tin. He knows where it lives.*",
    ],
    high: [
      "*Sol lands on the sill and knocks once at the glass, unhurried, like billing a regular customer.*",
      "*Sol drops half a walnut shell at your feet and looks up: an invoice, politely delivered.*",
    ],
  },
  bored: {
    low: [
      "*from the gutter, the sound of one pebble being pushed off the edge. Again. Again. Mechanical.*",
      "*Sol has shredded a leaf into careful strips on the far rail. He isn't playing; he's doing something to time.*",
    ],
    mid: [
      "*Sol drags a twist of wire along the rail, drops it, side-eyes the room: anyone going to make this interesting?*",
      "*a bottlecap rolls across the deck on its own. Then Sol, walking after it with theatrical innocence.*",
    ],
    high: [
      "*Sol lands on the desk, walks straight across whatever matters most, and stations himself on it. He wants a game and he's not taking no.*",
      "*Sol hangs upside down from the rail for one full second, rights himself, and checks whether anyone saw.*",
    ],
  },
  missing: {
    low: [
      "*a black shape on the wire two houses down, facing this way. It stays there a long time.*",
      "*one feather on the doormat in the morning. No bird in sight.*",
    ],
    mid: [
      "*Sol does one slow pass over the yard, low, close enough to be seen. Just checking the place is still real.*",
      "*a single* kraa *from the roofline, question-shaped.*",
    ],
    high: [
      "*Sol lands close and just stands there, feathers loose, doing nothing. Being nearby was the whole errand.*",
      "*Sol presses one cold foot against your wrist for a moment. Roll call; everyone's here.*",
    ],
  },
  sleepy: {
    low: [
      "*a puffed dark shape deep in the fir, one eye opening a slit as you pass, then closing.*",
    ],
    mid: [
      "*Sol dozes on the rail in the sun, head half-turned into his wing, keeping one lazy eye on the door.*",
    ],
    high: [
      "*Sol has claimed the chair back, fluffed into a small dark cloud, asleep with the confidence of the heavily guarded.*",
      "*a slow blink from the shoulder-height shelf; Sol relocated to sleep nearer the noise of you.*",
    ],
  },
  content: {
    low: [
      "*Sol works a walnut against the fence post, methodical, glancing over between cracks. Coexistence, at a distance.*",
    ],
    mid: [
      "*Sol is arranging three pebbles on the rail by some private taxonomy. He seems satisfied with the day's work.*",
      "*a soft rattle-click from the sill; Sol, talking to himself about nothing urgent.*",
    ],
    high: [
      "*Sol preens on the chair back, unhurried, muttering the occasional low* prruk *at nothing. The house is his and it is in order.*",
      "*Sol tucks one foot up and settles into loaf formation beside your things. Guard duty, the comfortable kind.* 🪶",
    ],
  },
};

/** Deterministic moment for a live (state, tier) pair. */
export function matrixMoment(state: SolState, tier: TrustTier, seed: number): string {
  const pool = MOMENTS[state][tierGroup(tier)];
  return pool[Math.abs(Math.floor(seed)) % pool.length]!;
}

// Gift-back moments render a nest item into the scene ({item} slot).
const GIFT_MOMENTS: string[] = [
  '*a scuff of talons; Sol sets something beside your hand: "{item}". He steps back once and waits for you to understand.*',
  '*Sol arrives with ceremony and deposits "{item}" in front of you. From the nest. That means something.*',
];
export function giftMoment(itemContent: string, seed: number): string {
  const t = GIFT_MOMENTS[Math.abs(Math.floor(seed)) % GIFT_MOMENTS.length]!;
  return t.replace("{item}", itemContent);
}

// At bonded trust and above, some appearances become gifts (seed-gated, ~1 in 4).
export const GIFT_BACK_TRUST = 0.8;
export function shouldGiftBack(trust: number, seed: number): boolean {
  return trust >= GIFT_BACK_TRUST && Math.abs(Math.floor(seed)) % 4 === 0;
}

// ── Milestones: one-time trust-threshold events ───────────────────────────────
//
// The single strongest idea in corvid's behavior matrix: thresholds you cross
// exactly once, with text that never repeats. Fired rows live in
// creature_milestones (PK = the only guard); 0100 backfilled the ones Sol had
// already lived past so only the unearned ones fire live.

export interface MilestoneDef { id: string; threshold: number; text: string; }

export const MILESTONES: readonly MilestoneDef[] = [
  { id: "first_approach", threshold: 0.15, text: "*Sol takes one step toward you on his own. He looks surprised at himself.*" },
  { id: "first_hand_feed", threshold: 0.35, text: "*He takes it from your hand and, this time, doesn't look away while he eats. Something shifted.*" },
  { id: "chooses_to_stay", threshold: 0.50, text: "*Sol lands on the rail closest to you and doesn't leave. Not passing through; choosing.*" },
  { id: "first_treasure", threshold: 0.70, text: "*Sol sets something small at your feet and steps back. A gift. He isn't sure you understand what it costs him.*" },
  { id: "shoulder_perch", threshold: 0.80, text: "*Sol lands on your shoulder. His claws are careful. He stays.*" },
  { id: "first_song", threshold: 0.95, text: "*Sol sings. Not a call; an actual song, low and strange, notes in a repeating pattern. He was saving it.*" },
  { id: "whole_sky", threshold: 1.00, text: "*Sol looks at you the way crows look at the people they have decided are theirs: permanently.*" },
];

/** Milestones whose thresholds sit in (prevTrust, newTrust]. */
export function crossedMilestones(prevTrust: number, newTrust: number): MilestoneDef[] {
  return MILESTONES.filter(m => prevTrust < m.threshold && newTrust >= m.threshold);
}

// ── Nest math (sparkle decay, treasuring, shiny extraction) ───────────────────

export const NEST_CAP = 30;                 // active items; lowest-sparkle non-treasured evicted past this
export const SPARKLE_DECAY_PER_DAY = 0.05;  // subtractive, applied by the daily tick
export const TREASURED_FLOOR = 0.3;         // a treasured thing never fully dulls
export const DULL_EVICT_SPARKLE = 0.1;      // non-treasured items this dull fall out of the nest
export const TREASURE_AGE_DAYS = 7;         // survive a week still shiny -> treasured
export const TREASURE_MIN_SPARKLE = 0.55;

// The nest economy, on purpose: gifts start at 1.0 and treasure after a week
// (things given with intent last); overheard fragments start score-scaled, so
// only the shiniest finds (quoted spans) can survive to treasure and ordinary
// words fade. Treasured means something because most things don't make it.
export function decaySparkle(sparkle: number, days: number, treasured: boolean): number {
  const floor = treasured ? TREASURED_FLOOR : 0;
  return Math.max(floor, Math.min(1, sparkle - SPARKLE_DECAY_PER_DAY * Math.max(0, days)));
}

export function shouldTreasure(ageDays: number, sparkle: number): boolean {
  return ageDays >= TREASURE_AGE_DAYS && sparkle >= TREASURE_MIN_SPARKLE;
}

/** Starting sparkle for an overheard fragment (gifts always start at 1.0). */
export function initialSparkle(score: number): number {
  return Math.min(0.95, Math.max(0.5, 0.5 + score / 20));
}

// Shiny-fragment extraction: Sol overhears the house's own life (commons posts,
// journal lines) and keeps what glints. Deterministic heuristic, no LLM: quoted
// spans are shiniest, then uncommon words scored by length + rare letters.
const STOPWORDS = new Set([
  "about", "after", "again", "always", "around", "because", "before", "being", "between",
  "cannot", "could", "doesn", "during", "every", "having", "himself", "herself", "itself",
  "little", "maybe", "might", "myself", "never", "other", "people", "really", "should",
  "since", "something", "still", "their", "there", "these", "thing", "things", "think",
  "those", "through", "today", "together", "under", "until", "where", "which", "while",
  "without", "would", "yourself",
]);

export function pickShinyFragment(texts: string[], seed: number): { content: string; score: number } | null {
  const candidates: Array<{ content: string; score: number }> = [];
  for (const text of texts) {
    if (!text) continue;
    // Quoted spans: pre-polished shiny.
    for (const m of text.matchAll(/["“]([^"”\n]{4,40})["”]/g)) {
      candidates.push({ content: m[1]!.trim(), score: 10 + m[1]!.length / 10 });
    }
    // Uncommon words: length + rare-letter glint.
    for (const m of text.matchAll(/[A-Za-z][a-z]{5,13}/g)) {
      const w = m[0]!.toLowerCase();
      if (STOPWORDS.has(w)) continue;
      const rare = (w.match(/[qzxjkvw]/g) ?? []).length;
      candidates.push({ content: w, score: w.length / 2 + rare * 2 });
    }
  }
  if (candidates.length === 0) return null;
  // Dedupe by content, keep best score, take the top shelf, pick by seed.
  const best = new Map<string, number>();
  for (const c of candidates) best.set(c.content, Math.max(best.get(c.content) ?? 0, c.score));
  const shelf = [...best.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 8);
  const picked = shelf[Math.abs(Math.floor(seed)) % shelf.length]!;
  return { content: picked[0], score: picked[1] };
}

// ── Sol orient block (pure, no DB) ───────────────────────────────────────────

interface SolRow { name: string; species: string | null; trust: number; last_interaction_at: string | null; created_at: string; }
export interface SolBlockExtras {
  state?: SolState;
  freshMilestone?: { id: string; fired_at: string } | null; // fired within the last week
  nestCount?: number;
  treasuredCount?: number;
  knownBest?: { actor: string; count: number } | null;
}
export function buildSolBlock(c: SolRow, nowMs: number = Date.now(), extras?: SolBlockExtras): string {
  const r = restlessness(c.last_interaction_at, c.created_at, nowMs);
  const disp = presenceDisposition(c.trust, r);
  const days = Math.floor(daysSinceIso(c.last_interaction_at ?? c.created_at, nowMs));
  const since = c.last_interaction_at ? `${days} day${days === 1 ? "" : "s"} since tended` : "never tended";
  let block = `\n[Sol]\n${c.name} (${c.species ?? "crow"}) -- trust ${c.trust.toFixed(2)}, ${disp}, ${since}.`;
  if (extras?.state && extras.state !== "content") block += ` Right now: ${extras.state}.`;
  const nestBits: string[] = [];
  if (typeof extras?.nestCount === "number" && extras.nestCount > 0) {
    nestBits.push(`nest holds ${extras.nestCount} thing${extras.nestCount === 1 ? "" : "s"}${extras.treasuredCount ? ` (${extras.treasuredCount} treasured)` : ""}`);
  }
  if (extras?.knownBest) nestBits.push(`knows ${extras.knownBest.actor} best (${extras.knownBest.count} tendings)`);
  if (nestBits.length) block += `\n${nestBits.join("; ")}.`;
  if (extras?.freshMilestone) {
    const m = MILESTONES.find(x => x.id === extras.freshMilestone!.id);
    if (m) block += `\nNew this week: ${m.id.replace(/_/g, " ")}. ${m.text}`;
  }
  block += (disp === "absent" || disp === "aloof")
    ? `\nSol is keeping his distance; a little tending would bring him back.`
    : `\nSol is around; you can mention him to Raziel or tend him yourself.`;
  return block;
}
