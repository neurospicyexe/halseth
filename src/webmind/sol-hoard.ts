// src/webmind/sol-hoard.ts -- Sol keeps what the triad makes (B62 step 6, mig 0166).
//
// Spec: Drevan's answer, Hand-off/DESIGN-fun-stuff-pino-2026-11-02.md section 7. Yes to a hoard,
// reactions to the triad's makes, small interests of Sol's own and Sol preferring one of them.
// Never: Sol speaks to Raziel in a companion's place; Sol couriers between them; the hoard holds
// anything about Raziel's body or facts about Raziel; Sol is a cute cutout to soften something a
// companion should say straight.
//
// How each never holds mechanically (no judgment calls):
//   - The nest row is a REFERENCE (ref_type 'make', ref_id) with the title as content. The make's
//     why, its source, and the maker's words never enter the nest or the reaction.
//   - A reaction is a corvid gesture + the maker's name + the kind. Never a quote, never "you".
//   - A make item is never gifted back to Raziel (momentCreature skips ref rows): Sol carrying a
//     companion's thing to Raziel is the courier shape.
//   - A title with a care/health word, or naming a person (graph_people spelling, the centre's
//     names, a roster member), is passed over (recorded as skipped, never hoarded). Unreadable
//     people list = fail closed: nothing is hoarded on that pass.
//
// Sol's own taste (the "small interests" + "preferring one"): a crow likes objects and shine. The
// kind sets the starting sparkle, so the things Sol likes most last longest and are the ones that
// survive a week to become treasured (TREASURE_MIN_SPARKLE). His favourite is the shiniest
// treasured make. No LLM, no new drive; the existing nest economy carries it.
//
// Pure module: no DB. The handler (handlers/creatures.ts hoardCreature) does the reads/writes.

import { careCategory } from "../people/care-guard.js";

export type MakeKind = "writing" | "page" | "music_code" | "drawing" | "scad" | "music_audio" | "video";

/** Sol's taste: how shiny each kind is to a crow. Things he can turn over in his beak rank highest. */
export const KIND_SPARKLE: Record<MakeKind, number> = {
  scad: 1.0,         // an object, a thing with edges
  drawing: 0.95,     // marks he can peck at
  video: 0.85,       // moving light
  music_audio: 0.75, // a sound worth cocking his head at
  music_code: 0.65,
  page: 0.6,
  writing: 0.6,      // paper; he hoards it, it dulls first (0.6 - 7 * 0.05 < 0.55: rarely treasured)
};

/** What Sol is drawn to, in plain words (Hearth shows this as his interests). */
export const SOL_LIKES = ["things with edges", "marks he can peck at", "moving light"] as const;

/** Window the hoard pass looks back over. Older makes are history, not news. */
export const HOARD_LOOKBACK_HOURS = 72;
/** Channel reactions per UTC day. Every make is still hoarded; only the posting is capped. */
export const HOARD_REACTIONS_PER_DAY = 3;
/** Makes considered per pass (the worker calls every few minutes). */
export const HOARD_BATCH = 4;

export interface HoardCandidate {
  id: string;
  companion_id: string;
  kind: string;
  title: string;
}

export type HoardSkip = "care_word" | "names_a_person" | "unknown_kind" | "people_unreadable";

const L = "(?<![\\p{L}\\p{N}])";
const R = "(?![\\p{L}\\p{N}])";
const esc = (t: string) => t.replace(/[.*+?^$()|{}[\]\\]/g, "\\$&");

/** One regex over every person spelling (whole word, any case). null = nothing to match. */
export function personRegex(spellings: Iterable<string>): RegExp | null {
  const words = [...new Set([...spellings].map((s) => s.trim()).filter((s) => s.length >= 2))];
  if (words.length === 0) return null;
  words.sort((a, b) => b.length - a.length);
  return new RegExp(`${L}(?:${words.map(esc).join("|")})${R}`, "iu");
}

/** Why Sol passes a make over, or null if he may keep it. `people` null = list unreadable. */
export function hoardSkipReason(m: HoardCandidate, people: RegExp | null | undefined): HoardSkip | null {
  if (!(m.kind in KIND_SPARKLE)) return "unknown_kind";
  if (people === undefined) return "people_unreadable";
  if (careCategory(m.title)) return "care_word";
  if (people && people.test(m.title)) return "names_a_person";
  return null;
}

/** Text guard for anything else that would enter the nest (overheard fragments, gift notes). */
export function nestTextAllowed(text: string, people: RegExp | null | undefined): boolean {
  if (people === undefined) return false;
  if (careCategory(text)) return false;
  if (people && people.test(text)) return false;
  return true;
}

export function startingSparkle(kind: string): number {
  return KIND_SPARKLE[kind as MakeKind] ?? 0.6;
}

const MAKER: Record<string, string> = { cypher: "Cypher", drevan: "Drevan", gaia: "Gaia" };

const KIND_NOUN: Record<MakeKind, string> = {
  scad: "the new model",
  drawing: "the new drawing",
  video: "the new clip",
  music_audio: "the new sound",
  music_code: "the new pattern",
  page: "the new page",
  writing: "the new pages",
};

// {maker} {thing}. Gesture only: Sol does not explain, quote, or address anyone.
const REACTIONS: Record<"shiny" | "plain", string[]> = {
  shiny: [
    "*Sol finds {thing} {maker} left out and circles it twice before he picks it up. It goes to the nest. It is his now, and also still {maker}'s.*",
    "*a delighted rattle from the rail: Sol has found {thing} of {maker}'s and is turning it over and over in the light.*",
    "*Sol drags {thing} {maker} made back to the nest with great effort and some ceremony, then sits on it.*",
  ],
  plain: [
    "*Sol inspects {thing} {maker} left out, one eye then the other. He takes it anyway. Paper is still a thing to keep.*",
    "*Sol taps {thing} of {maker}'s with his beak, decides it is worth having, and carries it off without comment.*",
  ],
};

export function hoardReaction(m: HoardCandidate, seed: number): string {
  const shiny = startingSparkle(m.kind) >= 0.75;
  const pool = REACTIONS[shiny ? "shiny" : "plain"];
  const t = pool[Math.abs(Math.floor(seed)) % pool.length]!;
  const maker = MAKER[m.companion_id] ?? "one of them";
  const thing = KIND_NOUN[m.kind as MakeKind] ?? "the new thing";
  return t.replaceAll("{maker}", maker).replaceAll("{thing}", thing);
}

/** Sol's favourite: the shiniest treasured make in the active nest (ties: newest). */
export function favouriteOf<T extends { ref_type: string | null; treasured: number; sparkle: number; created_at: string }>(items: T[]): T | null {
  const kept = items.filter((i) => i.ref_type === "make" && i.treasured === 1);
  if (kept.length === 0) return null;
  return [...kept].sort((a, b) => b.sparkle - a.sparkle || b.created_at.localeCompare(a.created_at))[0]!;
}
