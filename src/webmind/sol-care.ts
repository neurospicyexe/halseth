// src/webmind/sol-care.ts
//
// How Sol answers being cared for (2026-11-02). Before this, a tend was bookkeeping:
// a flat trust bump, a flat mood per action, and an ack line "fed Sol (trust 0.83)".
// Sol never noticed whether he was hungry when fed, asleep when played with, or
// tended five times in ten minutes. Now the care is read against what he needs
// right now (the same lazy drives as his appearances: hunger / boredom / missing /
// circadian energy) and he answers in his body, in one line.
//
// Pure, seeded, no LLM, matching creatures.ts.
//
// Rules this module holds, on purpose:
//   - NO TRUST EVER GOES DOWN FROM A TEND (R7, no ceiling). A fit scales the GAIN,
//     and every multiplier is > 0. Do not add a penalty here: a wrong-time or
//     repeated tend is still care, it just lands softer.
//   - "full", "drowsy" and "settled" are written as contentment, never a cold
//     shoulder. Raziel tends Sol by hand (`pet Sol`); a reaction that reads as
//     rejection becomes a thing to check and re-check (OCD/OCPD). Sol caching food
//     he doesn't need or already being here is warm, and it gives nothing to chase.
//   - No numbers in the reaction. The ack already carries trust to two places.
//   - The reaction never quotes or reads the give note (same discipline as the hoard).
//   - The tender is a slot, {who}: "you" when the line goes back to the person who
//     tended, their name when it is posted to a room. Sol's line is Sol's body
//     answering a named tender, never words aimed at Raziel in a companion's place.

import { type CreatureAction, type DriveState, type TrustTier, tierGroup, type TierGroup } from "./creatures.js";

export type CareFit = "met" | "welcome" | "full" | "drowsy" | "settled";

// Under this circadian energy, Sol is roosting (circadianEnergy: ~22:00-06:00 crow time).
export const ROOST_ENERGY = 0.3;
// A drive this loud is a need the care can meet.
export const NEED_MET = 0.45;
// Missing is slower to feel (about two days of nobody), so its bar is lower.
export const MISSING_MET = 0.3;
// Fed this recently (hunger under this) he doesn't need it; he caches it.
export const FULL_BELOW = 0.15;
// The same tender doing the same thing this many times inside the window = he's already here.
export const SETTLED_AFTER = 2;
export const SETTLED_WINDOW_MINUTES = 60;

const GAIN: Record<CareFit, number> = {
  met: 1.5,
  welcome: 1.0,
  full: 0.5,
  drowsy: 0.5,
  settled: 0.25,
};

/**
 * Read one tend against Sol's live drives.
 * `recentSame` = earlier tends by THIS tender with THIS action inside the window.
 * Order matters: repetition first, then roost hours, then fullness, then need.
 */
export function careFit(action: CreatureAction, drives: DriveState, recentSame: number): CareFit {
  if (recentSame >= SETTLED_AFTER) return "settled";
  const roosting = drives.energy < ROOST_ENERGY;
  // Talk and give are quiet; a crow on the roost can take a low voice. Feed and play wake him.
  if (roosting && (action === "feed" || action === "play")) return "drowsy";
  if (action === "feed" && drives.hunger < FULL_BELOW) return "full";
  if (action === "feed" && drives.hunger >= NEED_MET) return "met";
  if (action === "play" && drives.boredom >= NEED_MET) return "met";
  if ((action === "talk" || action === "give") && drives.missing >= MISSING_MET) return "met";
  return "welcome";
}

/** Gain multiplier for a fit. Always > 0 (R7: a tend never costs trust). */
export function careGain(fit: CareFit): number {
  return GAIN[fit];
}

const ACTION_MOOD: Record<CreatureAction, string> = {
  feed: "content", play: "playful", talk: "engaged", give: "delighted",
};

/** Mood the tend leaves him in. Met need reads a shade warmer; roost hours read drowsy. */
export function careMood(action: CreatureAction, fit: CareFit): string {
  if (fit === "drowsy") return "drowsy";
  if (fit === "full") return "content";
  if (fit === "met") return action === "feed" ? "satisfied" : action === "play" ? "playful" : "delighted";
  return ACTION_MOOD[action];
}

// ── The lines ────────────────────────────────────────────────────────────────
//
// met + welcome vary by trust group (a wary crow takes food and backs off; a bonded
// one leans in). full / drowsy / settled are the soft landings and read the same at
// every tier; they are written warm, see the header.

type Pool = Record<TierGroup, string[]>;

const MET: Record<CreatureAction, Pool> = {
  feed: {
    low: [
      "*Sol takes the food fast and backs off to the far rail to eat it, watching {who} the whole time. He came, though.*",
      "*a snatch, a retreat, and then, from a safe distance, the sound of a crow eating like he means it.*",
    ],
    mid: [
      "*Sol eats right there on the rail, unhurried for once, and glances at {who} between bites like he's keeping a tally.*",
      "*he was hungry and doesn't pretend otherwise. Three quick bites, a pause, a low* prruk *of approval.*",
    ],
    high: [
      "*Sol eats from beside {who}, shoulder to shoulder with the hand that fed him, and makes the small satisfied clicking he saves for home.*",
      "*Sol finishes, wipes his beak twice on the rail, and settles in close: fed, and fed by the right one.*",
    ],
  },
  play: {
    low: [
      "*Sol watches the game from a distance, then darts in once, steals the thing, and is gone. He'll be back for it.*",
    ],
    mid: [
      "*Sol pounces, misses on purpose, pounces again. He'd been waiting all day for someone to start this.*",
      "*a bottlecap, a chase, a triumphant hop. Sol drops it back at {who} and stares: again.*",
    ],
    high: [
      "*Sol throws himself into it, all wings and nonsense, and ends the game upside down on the rail, extremely pleased with himself.*",
      "*Sol brings {who} a twig, then a pebble, then a better pebble. He's choosing the next game now.*",
    ],
  },
  talk: {
    low: [
      "*Sol doesn't come closer, but he stops what he's doing to listen. Every word, head tilted.*",
    ],
    mid: [
      "*Sol hops two rails nearer through the talking and answers with a run of soft clicks, like he's been saving up his side of it.*",
      "*he listens like a crow who has been missing exactly this, and says one low* kraa *back.*",
    ],
    high: [
      "*Sol lands right by {who} and leans in for the whole of it, feathers loose. He'd noticed the quiet. He's done noticing it now.*",
      "*Sol mutters back the whole time, a long, private, delighted commentary. Company was the thing he needed.*",
    ],
  },
  give: {
    low: [
      "*Sol waits for a step back, then takes it, and takes it away somewhere only he knows.*",
    ],
    mid: [
      "*Sol turns the gift over twice, decides, and carries it to the nest with real ceremony. It came at the right time.*",
    ],
    high: [
      "*Sol accepts it with a bow of the head, files it in the nest, and then comes back to sit by {who}. The gift was good; the coming back is the answer.*",
      "*a pleased rattle-click. Sol tucks it away and stays close a long while after, like the giving was the point.*",
    ],
  },
};

const WELCOME: Record<CreatureAction, Pool> = {
  feed: {
    low: ["*Sol takes it to the far post and eats in peace. He looks back once.*"],
    mid: [
      "*Sol eats a little now and caches the rest under the rail for later. Good to have.*",
      "*a polite peck, a second one, a short nod at {who}.*",
    ],
    high: [
      "*Sol eats beside {who}, companionable about it, in no hurry at all.*",
      "*Sol takes the food and offers {who} a small appreciative* prruk. *Everything is in order.*",
    ],
  },
  play: {
    low: ["*Sol watches the game with one eye, interested and pretending not to be.*"],
    mid: [
      "*Sol plays a round, then another, then wanders off mid-game the way crows do when they've had enough fun.*",
    ],
    high: [
      "*Sol plays along gamely, hops twice, and ends up on the same side of the rail as {who}, which seems to have been the goal.*",
      "*a short, cheerful game. Sol wins, by his own rules.*",
    ],
  },
  talk: {
    low: ["*Sol keeps his distance but turns his head toward the voice.*"],
    mid: [
      "*Sol listens, picks at the rail, adds a click now and then. Easy company.*",
    ],
    high: [
      "*Sol listens with his feathers half-fluffed, the picture of a crow who likes this voice.*",
      "*Sol answers with a low burble that sounds a lot like agreeing.*",
    ],
  },
  give: {
    low: ["*Sol eyes it, then {who}, then takes it, quick, and off.*"],
    mid: [
      "*Sol inspects the gift from three angles and adds it to the nest. Approved.*",
    ],
    high: [
      "*Sol takes it gently and arranges it in the nest beside his other good things. It belongs there now.*",
      "*a soft rattle of thanks. Into the nest it goes, near the top.*",
    ],
  },
};

// The soft landings. Warm, every one: nothing withheld, nothing to win back.
const FULL: string[] = [
  "*Sol is full, but he takes it anyway and caches it under the rail for later, carefully, like it matters. It does.*",
  "*Sol tucks the food away in his favourite hiding spot and comes back looking pleased: provisions, from {who}.*",
];

const DROWSY: Record<"feed" | "play", string[]> = {
  feed: [
    "*Sol is roosting. He opens one eye, takes the morsel without moving anything else, and is asleep again before he swallows.*",
    "*a sleepy shuffle on the perch. He'll find the food at first light and know who left it.*",
  ],
  play: [
    "*Sol is half asleep. He bats at the game once, with great dignity, and tucks his head back under his wing.*",
    "*a drowsy chirr from the roost: not now, but glad of it. He shifts closer to {who} on the perch.*",
  ],
};

const SETTLED: string[] = [
  "*Sol is already here, already content. He leans against {who} and lets the rest of the day happen.*",
  "*Sol has had plenty of that and is happy. He settles into loaf formation nearby: nothing missing, nothing needed.*",
  "*Sol gives a slow, satisfied blink. He's full up on {who} for now, in the good way.*",
];

function pick(pool: string[], seed: number): string {
  return pool[Math.abs(Math.floor(seed)) % pool.length]!;
}

/** The line, with the {who} slot still in it. */
export function careLine(action: CreatureAction, fit: CareFit, tier: TrustTier, seed: number): string {
  if (fit === "settled") return pick(SETTLED, seed);
  if (fit === "full") return pick(FULL, seed);
  if (fit === "drowsy") return pick(DROWSY[action === "play" ? "play" : "feed"], seed);
  const pools = fit === "met" ? MET : WELCOME;
  return pick(pools[action][tierGroup(tier)], seed);
}

// An imp is named by what it is, never by its own name (a name on a record starts to sound like a voice).
const NAMES: Record<string, string> = { raziel: "Raziel", cypher: "Cypher", drevan: "Drevan", gaia: "Gaia", imp: "an imp" };

/** Fill the tender slot. `you` for the person tending; their name for a room. */
export function renderCare(line: string, who: string): string {
  return line.replace(/\{who\}/g, who);
}

export function tenderName(actor: string): string {
  return NAMES[actor] ?? actor;
}

export interface CareResponse {
  fit: CareFit;
  gain: number;          // multiplier on the action's base trust delta
  mood: string;
  reaction: string;      // addressed to the tender ("you")
  reaction_named: string; // for a room ("Cypher")
}

export function careResponse(
  action: CreatureAction,
  drives: DriveState,
  recentSame: number,
  tier: TrustTier,
  actor: string,
  seed: number,
): CareResponse {
  const fit = careFit(action, drives, recentSame);
  const line = careLine(action, fit, tier, seed);
  return {
    fit,
    gain: careGain(fit),
    mood: careMood(action, fit),
    reaction: renderCare(line, "you"),
    reaction_named: renderCare(line, tenderName(actor)),
  };
}
