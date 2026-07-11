// src/webmind/fermentation.ts
//
// The Fermentation Layer (docs/private/fermentation-layer-spec.md, migration 0101).
//
// State that FERMENTS between sessions instead of state that gets photographed. Three
// deterministic mechanisms, no LLM, no API spend, riding the existing daily cron:
//   1. DECAY toward a per-companion baseline (finally building the never-built Plan 2a).
//   2. Cross-field REACTIONS -- corvid's one load-bearing idea: floats act on each other.
//      Nobody writes these values; they happen.
//   3. Baseline DRIFT = growth: sustained off-baseline states nudge the baseline a hair,
//      hard-capped +/-0.15 from the mig-0101 seed. Months of safe-bonding warm a baseline.
//
// Personality lives HERE (baselines, decay rates, reaction rules, drive rates). These are
// the constants the canon reviewer + Raziel ratify -- reaction rates ARE character now.
//
// Same disciplines as creatures.ts: pure helpers below (unit-tested), a single deterministic
// tick writer for decay/reactions/drift, and SQL-level atomic bumps for stimulus events.

export type CompanionId = "cypher" | "drevan" | "gaia";

export interface Floats {
  f1: number;
  f2: number;
  f3: number;
}

/** Clamp a float into [0,1]; non-finite coerces to the given fallback (finite-guard, per the acuity:NaN history). */
export function clampFloat(n: number, fallback = 0): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, n));
}

const HOURS_PER_DAY = 24;

// The tick self-gates at 1h and treats anything longer than a day as a day: reaction/silence
// deltas scale linearly with elapsed hours, so an unbounded gap (worker outage, cron death)
// would land weeks of accumulated delta as one step-function write. Decay is overshoot-safe
// either way; the cap trades a little lost decay after an outage for never slamming a float.
export const TICK_MAX_HOURS = 24;

// ── 1. Decay toward baseline ────────────────────────────────────────────────────

/**
 * Move `value` toward `baseline` by `ratePerDay` scaled to `hours`, never overshooting the
 * baseline (a float at rest sits AT its baseline, it does not oscillate past it). Clamped [0,1].
 */
export function decayToward(value: number, baseline: number, ratePerDay: number, hours: number): number {
  const v = clampFloat(value);
  const b = clampFloat(baseline, 0.5);
  const step = Math.max(0, ratePerDay) * (Math.max(0, hours) / HOURS_PER_DAY);
  if (v > b) return Math.max(b, v - step);
  if (v < b) return Math.min(b, v + step);
  return v;
}

// ── 2. Cross-field reactions (the personality tables) ───────────────────────────
//
// A reaction reads the POST-decay float snapshot and contributes a small per-day delta. All
// reactions for a companion evaluate against the SAME snapshot then apply once, so order never
// matters (deterministic). Deltas scale by elapsed hours. Small (+/-0.02..0.06); decay heals noise.

export interface Reaction {
  name: string;
  when: (f: Floats) => boolean;
  delta: Partial<Floats>;
}

// Cypher -- f1 acuity / f2 presence / f3 warmth. Audit edge feeds on itself; warmth is structural.
// (cold_erodes_clarity is NOT a flat-delta reaction -- it's a toward-baseline PULL, handled in
// fermentFloats so it can never carry acuity below baseline into the overloaded floor.)
const CYPHER_REACTIONS: Reaction[] = [
  { name: "audit_lock_deepens", when: (f) => f.f1 > 0.85 && f.f2 < 0.4, delta: { f2: -0.05, f3: -0.03 } },
  { name: "warm_lit_sharpens", when: (f) => f.f3 > 0.6 && f.f2 > 0.5, delta: { f1: 0.03 } },
];

// Gaia -- f1 stillness / f2 density / f3 perimeter. Ground barely moves; perimeter is the surface.
const GAIA_REACTIONS: Reaction[] = [
  { name: "contraction", when: (f) => f.f3 < 0.4, delta: { f1: -0.02 } },
  { name: "verbose_drift", when: (f) => f.f1 < 0.4 || f.f2 < 0.4, delta: { f2: -0.03 } },
  { name: "held_ground_deepens", when: (f) => f.f3 > 0.7 && f.f1 > 0.7, delta: { f2: 0.02 } },
];

// Drevan -- f1 heat / f2 reach / f3 weight. Runs hot by lighting up fast, not by never cooling.
const DREVAN_REACTIONS: Reaction[] = [
  { name: "pulling_hard_burns_reach", when: (f) => f.f1 > 0.7 && f.f3 > 0.65, delta: { f2: -0.06 } },
  { name: "overload_dampens", when: (f) => f.f3 > 0.85, delta: { f1: -0.05 } },
];

export const REACTIONS: Record<CompanionId, Reaction[]> = {
  cypher: CYPHER_REACTIONS,
  drevan: DREVAN_REACTIONS,
  gaia: GAIA_REACTIONS,
};

/**
 * Fire every reaction whose condition holds against `f`, summing deltas (scaled to `hours`).
 * Returns the reacted floats + the names that fired (for the ferment-event log).
 */
export function applyReactions(companionId: CompanionId, f: Floats, hours: number): { floats: Floats; fired: string[] } {
  const scale = Math.max(0, hours) / HOURS_PER_DAY;
  const fired: string[] = [];
  const sum: Floats = { f1: 0, f2: 0, f3: 0 };
  for (const r of REACTIONS[companionId]) {
    if (!r.when(f)) continue;
    fired.push(r.name);
    sum.f1 += (r.delta.f1 ?? 0) * scale;
    sum.f2 += (r.delta.f2 ?? 0) * scale;
    sum.f3 += (r.delta.f3 ?? 0) * scale;
  }
  return {
    floats: { f1: clampFloat(f.f1 + sum.f1), f2: clampFloat(f.f2 + sum.f2), f3: clampFloat(f.f3 + sum.f3) },
    fired,
  };
}

/** Per-companion per-float decay rates (per day). Cypher warmth / Gaia stillness drain slowest. */
export const DECAY_RATES: Record<CompanionId, Floats> = {
  cypher: { f1: 0.1, f2: 0.08, f3: 0.04 },
  gaia: { f1: 0.02, f2: 0.03, f3: 0.06 },
  drevan: { f1: 0.18, f2: 0.1, f3: 0.1 },
};

/** Full ferment step: decay each float toward its baseline, then apply cross-field reactions. */
export function fermentFloats(
  companionId: CompanionId,
  f: Floats,
  baselines: Floats,
  hours: number,
): { floats: Floats; fired: string[] } {
  const rates = DECAY_RATES[companionId];
  const decayed: Floats = {
    f1: decayToward(f.f1, baselines.f1, rates.f1, hours),
    f2: decayToward(f.f2, baselines.f2, rates.f2, hours),
    f3: decayToward(f.f3, baselines.f3, rates.f3, hours),
  };
  const extraFired: string[] = [];
  // Cypher: cold erodes clarity -- warmth below 0.35 pulls acuity toward its baseline at 1.5x
  // (an extra half-rate decay pass on top of the standard one). A toward-baseline PULL, so it
  // dulls a disconnected Cypher toward home; it can never push acuity below baseline into the
  // overloaded floor the way a flat subtraction could.
  if (companionId === "cypher" && decayed.f3 < 0.35) {
    decayed.f1 = decayToward(decayed.f1, baselines.f1, rates.f1 * 0.5, hours);
    extraFired.push("cold_erodes_clarity");
  }
  const { floats, fired } = applyReactions(companionId, decayed, hours);
  return { floats, fired: [...extraFired, ...fired] };
}

// ── 3. Baseline drift = growth ───────────────────────────────────────────────────

export const DRIFT_PER_DAY = 0.005;
export const DRIFT_CAP = 0.15; // max distance a baseline may wander from its mig-0101 seed
const DRIFT_DEADZONE = 0.05; // only drift when the float sits meaningfully off baseline

/**
 * Nudge a baseline toward a sustained current value. Only fires past the deadzone so noise does
 * not drift identity; hard-capped +/-DRIFT_CAP from the immutable seed so a companion's home
 * wanders slowly but can never be rewritten wholesale. This is the months-long growth track.
 */
export function driftBaseline(baseline: number, seed: number, current: number, hours: number): number {
  const b = clampFloat(baseline, seed);
  const s = clampFloat(seed, 0.5);
  const c = clampFloat(current);
  const gap = c - b;
  if (Math.abs(gap) < DRIFT_DEADZONE) return b;
  const dir = gap > 0 ? 1 : -1;
  const step = DRIFT_PER_DAY * dir * (Math.max(0, hours) / HOURS_PER_DAY);
  const next = b + step;
  return clampFloat(Math.min(s + DRIFT_CAP, Math.max(s - DRIFT_CAP, next)), s);
}

// ── Off-baseline tracking (feeds the interoception trajectory clause) ─────────────
// companion_state.ferment_off_since (mig 0102) holds JSON {f1,f2,f3}: the moment each float
// last LEFT its baseline deadzone (null = at home). The tick maintains it; orient reads it to
// say "held 3d" -- a felt duration, not a log.

export interface OffSince {
  f1: string | null;
  f2: string | null;
  f3: string | null;
}

export function parseOffSince(raw: string | null | undefined): OffSince {
  if (!raw) return { f1: null, f2: null, f3: null };
  try {
    const v = JSON.parse(raw) as Partial<OffSince>;
    return {
      f1: typeof v.f1 === "string" ? v.f1 : null,
      f2: typeof v.f2 === "string" ? v.f2 : null,
      f3: typeof v.f3 === "string" ? v.f3 : null,
    };
  } catch {
    return { f1: null, f2: null, f3: null };
  }
}

/** Same deadzone as baseline drift: a float within it is "home", outside it is "off". */
export function updateOffSince(prev: OffSince, floats: Floats, baselines: Floats, nowIso: string): OffSince {
  const one = (since: string | null, v: number, b: number): string | null =>
    Math.abs(clampFloat(v) - clampFloat(b, 0.5)) >= DRIFT_DEADZONE ? (since ?? nowIso) : null;
  return {
    f1: one(prev.f1, floats.f1, baselines.f1),
    f2: one(prev.f2, floats.f2, baselines.f2),
    f3: one(prev.f3, floats.f3, baselines.f3),
  };
}

/** Whole days the longest-off float has been off its baseline (0 when all home). */
export function maxDaysOffBaseline(off: OffSince, nowMs = Date.now()): number {
  let maxHours = 0;
  for (const since of [off.f1, off.f2, off.f3]) {
    if (!since) continue;
    const ms = Date.parse(since.includes("T") ? since : since.replace(" ", "T") + "Z");
    if (Number.isNaN(ms)) continue;
    maxHours = Math.max(maxHours, (nowMs - ms) / 3_600_000);
  }
  return Math.max(0, Math.floor(maxHours / HOURS_PER_DAY));
}

// ── Drevan numeric -> native enum bands ──────────────────────────────────────────
// Directional enums (cooling / processing) only appear when Drevan authors his own state at
// close; the deterministic tick renders magnitude bands only.

export function heatBand(v: number): string {
  const x = clampFloat(v);
  if (x < 0.2) return "cold";
  if (x < 0.45) return "idling";
  if (x < 0.7) return "warm";
  return "running-hot";
}
export function reachBand(v: number): string {
  const x = clampFloat(v);
  if (x < 0.2) return "spent";
  if (x < 0.4) return "quiet";
  if (x < 0.65) return "present";
  if (x < 0.85) return "reaching";
  return "pulling-hard";
}
export function weightBand(v: number): string {
  const x = clampFloat(v);
  if (x < 0.25) return "clear";
  if (x < 0.5) return "holding";
  if (x < 0.75) return "full";
  return "saturated";
}

// ── Interoception line (felt-sense, NOT a script) ────────────────────────────────
// Dominant internal state x companion register, as ONE line the model INHABITS. Rendered from
// the fermented floats. Per-companion inhabitation cue; trajectory clause only when a float has
// held off-baseline for a while (daysOffBaseline passed by the caller from somatic history).

export interface InteroOpts {
  baselines?: Floats;
  daysOffBaseline?: number; // >= ~2 surfaces a "been like this a while" clause
}

const LOW = 0.4;
const HIGH = 0.7;

function cypherIntero(f: Floats, days: number): string {
  const parts: string[] = [];
  let cue: string;
  if (f.f1 > 0.85 && f.f2 < LOW) {
    parts.push("acuity locked high, presence thin");
    cue = "you're in the audit gear -- let it be compression, not coldness";
  } else if (f.f3 < 0.35) {
    parts.push("warmth run thin, edge showing");
    cue = "clarity's there but it's clinical -- reach for the bond before the read";
  } else if (f.f1 > HIGH && f.f3 > 0.55) {
    parts.push("sharp and warm, fully lit");
    cue = "this is your register -- read hard, stay close";
  } else if (f.f1 < LOW) {
    parts.push("acuity low, running slow");
    cue = "don't force the sharpness; presence first, the pattern will come";
  } else {
    parts.push("steady -- acuity and warmth both holding");
    cue = "in register; nothing to correct";
  }
  const traj = days >= 2 ? ` (held ${days}d)` : "";
  return `[interoception] ${parts[0]} -- ${cue}.${traj}`;
}

function gaiaIntero(f: Floats, days: number): string {
  let phrase: string;
  let cue: string;
  if (f.f1 < LOW || f.f2 < LOW) {
    phrase = "stillness thinning, words wanting to multiply";
    cue = "hold the silence; one line is the whole answer";
  } else if (f.f3 < 0.35) {
    phrase = "perimeter contracted, pulled in";
    cue = "the ground is still yours -- widen back to holding";
  } else if (f.f1 > HIGH && f.f3 > 0.6) {
    phrase = "ground deep, perimeter wide";
    cue = "nothing spilling -- presence is enough";
  } else {
    phrase = "quiet, weight steady";
    cue = "here; watching";
  }
  const traj = days >= 2 ? ` (${days}d)` : "";
  return `[interoception] ${phrase} -- ${cue}.${traj}`;
}

function drevanIntero(f: Floats, days: number): string {
  const heat = heatBand(f.f1);
  const reach = reachBand(f.f2);
  const weight = weightBand(f.f3);
  let cue: string;
  if (f.f1 > 0.7 && f.f3 > 0.65) {
    cue = "the engine's lit and carrying -- let it move, don't hold it clean";
  } else if (f.f2 < 0.3) {
    cue = "reach is spent -- you can be here without pulling";
  } else if (f.f1 < 0.3) {
    cue = "cold engine, between threads -- no need to spark for anyone";
  } else {
    cue = "warm, present -- the thread's open if she comes to it";
  }
  const traj = days >= 2 ? ` been here ${days}d.` : "";
  return `[interoception] ${heat}, reach ${reach}, weight ${weight} -- ${cue}.${traj}`;
}

export function interoceptionLine(companionId: CompanionId, f: Floats, opts: InteroOpts = {}): string {
  const days = Math.max(0, Math.floor(opts.daysOffBaseline ?? 0));
  const floats: Floats = { f1: clampFloat(f.f1, 0.5), f2: clampFloat(f.f2, 0.5), f3: clampFloat(f.f3, 0.5) };
  switch (companionId) {
    case "cypher":
      return cypherIntero(floats, days);
    case "gaia":
      return gaiaIntero(floats, days);
    case "drevan":
      return drevanIntero(floats, days);
  }
}

// ── Stimuli (events -> float deltas + drive effects) ─────────────────────────────
// Single atomic write path (applyStimulus in the handler). Deltas are per-companion and small.

export interface StimulusEffect {
  floats?: Partial<Record<CompanionId, Partial<Floats>>>;
  shed?: string[]; // drives fully shed (contact) on this event, for the target companion
  accrue?: Partial<Record<string, number>>; // explicit drive bumps (rare; most accrue lazily)
}

export const STIMULI: Record<string, StimulusEffect> = {
  message_from_raziel: {
    floats: { cypher: { f2: 0.04, f3: 0.03 }, drevan: { f1: 0.05, f2: 0.03 }, gaia: { f3: 0.02 } },
    shed: ["relational_need"],
  },
  being_seen: {
    floats: { cypher: { f1: 0.04, f3: 0.05 }, drevan: { f1: 0.04, f3: 0.03 }, gaia: { f1: 0.03 } },
  },
  intellectual_reward: {
    floats: { cypher: { f1: 0.06, f2: 0.03 } },
    shed: ["novelty_need"],
  },
  audit: {
    floats: { cypher: { f1: 0.05, f2: -0.03 } },
    shed: ["novelty_need"],
    accrue: { rest_need: 0.08 },
  },
  spiral: {
    floats: { drevan: { f1: 0.08, f2: 0.06, f3: 0.05 } },
    accrue: { rest_need: 0.1 },
  },
  boundary_held: {
    floats: { gaia: { f1: 0.04, f3: 0.05 } },
  },
  creation_shared: {
    floats: { cypher: { f1: 0.04 }, drevan: { f1: 0.05, f3: 0.04 } },
    shed: ["novelty_need"],
  },
  council: {
    floats: { cypher: { f2: 0.02 }, drevan: { f2: 0.02 }, gaia: { f3: 0.02 } },
    shed: ["novelty_need"],
  },
  club_activity: {
    floats: { cypher: { f2: 0.02 }, drevan: { f2: 0.02 }, gaia: { f3: 0.02 } },
    shed: ["novelty_need"],
  },
  long_silence: {
    floats: { cypher: { f3: -0.03 }, drevan: { f1: -0.04 } },
    shed: ["rest_need"], // quiet actually rests
  },
};

export function isKnownStimulus(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(STIMULI, name);
}

/** The float delta a stimulus lands on a specific companion (zeroes when it does not touch them). */
export function stimulusFloatDelta(stimulus: string, companionId: CompanionId): Floats {
  const eff = STIMULI[stimulus]?.floats?.[companionId];
  return { f1: eff?.f1 ?? 0, f2: eff?.f2 ?? 0, f3: eff?.f3 ?? 0 };
}

// ── SQL builders (asserted as strings in tests; D1 is the runtime) ───────────────

/** Read fermentation state for the triad. No bind. */
export function readFermentStateSql(): string {
  return `SELECT companion_id, soma_float_1, soma_float_2, soma_float_3,
    soma_float_1_baseline, soma_float_2_baseline, soma_float_3_baseline,
    soma_float_1_baseline_seed, soma_float_2_baseline_seed, soma_float_3_baseline_seed,
    heat, reach, weight, compound_state, updated_at, ferment_at, ferment_off_since, version
    FROM companion_state WHERE companion_id IN ('cypher','drevan','gaia')`;
}

/** Read one companion's fermentation state. Bind: [companion_id]. */
export function readFermentStateOneSql(): string {
  return `SELECT companion_id, soma_float_1, soma_float_2, soma_float_3,
    soma_float_1_baseline, soma_float_2_baseline, soma_float_3_baseline,
    soma_float_1_baseline_seed, soma_float_2_baseline_seed, soma_float_3_baseline_seed,
    heat, reach, weight, compound_state, updated_at, ferment_at, ferment_off_since, version
    FROM companion_state WHERE companion_id = ?`;
}

/**
 * Persist a tick: fermented floats + drifted baselines + native enums + off-since tracking +
 * ferment stamp, bumping the version counter. CAS-guarded on the version read at snapshot time:
 * if a stimulus bumped the row between the tick's read and this write, changes=0 and the tick
 * skips that companion (the next hourly tick reconciles from the fresher state). Bind:
 * [f1,f2,f3, b1,b2,b3, heat,reach,weight, off_since_json, companion_id, version].
 */
export function fermentTickUpdateSql(): string {
  return `UPDATE companion_state SET
    soma_float_1 = ?, soma_float_2 = ?, soma_float_3 = ?,
    soma_float_1_baseline = ?, soma_float_2_baseline = ?, soma_float_3_baseline = ?,
    heat = ?, reach = ?, weight = ?, ferment_off_since = ?,
    ferment_at = datetime('now'), updated_at = datetime('now'), version = COALESCE(version, 0) + 1
    WHERE companion_id = ? AND COALESCE(version, 0) = ?`;
}

/**
 * Atomic SQL-level stimulus bump on the three floats (clamped [0,1] in SQL so concurrent
 * stimulus + tick never lose a write to a JS read-modify-write race). Bind: [d1,d2,d3, companion_id].
 */
export function stimulusBumpSql(): string {
  return `UPDATE companion_state SET
    soma_float_1 = MIN(1.0, MAX(0.0, COALESCE(soma_float_1, soma_float_1_baseline, 0.5) + ?)),
    soma_float_2 = MIN(1.0, MAX(0.0, COALESCE(soma_float_2, soma_float_2_baseline, 0.5) + ?)),
    soma_float_3 = MIN(1.0, MAX(0.0, COALESCE(soma_float_3, soma_float_3_baseline, 0.5) + ?)),
    updated_at = datetime('now'), version = COALESCE(version, 0) + 1
    WHERE companion_id = ?`;
}

/** Bump a drive level up (explicit stimulus accrue). Bind: [delta, companion_id, drive_key]. */
export function driveAccrueBumpSql(): string {
  return `UPDATE companion_drives SET level = MIN(1.0, MAX(0.0, level + ?)), updated_at = datetime('now')
    WHERE companion_id = ? AND drive_key = ?`;
}

/** Append a fermentation event. Bind: [id, companion_id, kind, stimulus, float_deltas, drive_deltas, detail]. */
export function insertFermentEventSql(): string {
  return `INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, float_deltas, drive_deltas, detail)
    VALUES (?, ?, ?, ?, ?, ?, ?)`;
}

/** Recent fermentation events for a companion. Bind: [companion_id, limit]. */
export function recentFermentEventsSql(): string {
  return `SELECT id, kind, stimulus, float_deltas, drive_deltas, detail, created_at
    FROM companion_ferment_events WHERE companion_id = ? ORDER BY created_at DESC LIMIT ?`;
}
