// Watch shelf (migration 0111) -- server-side rules.
//
// WHY: Raziel asked Drevan where they were in Fargo and got "last I tracked, S4 E2" while they had
// watched further in a Claude thread. No column anywhere in 110 migrations held an episode number, so
// the answer came from whichever prose fragment ranked highest -- and a June note about having
// FINISHED the show won. A progress fact is a field, not a memory.
//
// The rule that most needs pinning is FORWARD-ONLY. `POST /mind/watch/progress` logs every viewing but
// only advances the shelf when the position actually moves. Rewatches and out-of-order mentions are
// real and common; if either could rewind the shelf, one loose comment becomes the wrong answer to
// every later "where are we" -- the exact class of failure this organ was built to end.

import { describe, it, expect } from "vitest";
import { posInt, parseEpisodeCode, formatPosition, WATCH_STATUSES, WATCH_SURFACES } from "../handlers/watch.js";

/** The advance rule as the handler computes it, exercised directly. */
function advances(
  cur: { season: number | null; episode: number | null },
  next: { season: number | null; episode: number | null },
): boolean {
  const curS = posInt(cur.season) ?? 0;
  const curE = posInt(cur.episode) ?? 0;
  const { season, episode } = next;
  return season !== null && episode !== null
    ? (season > curS || (season === curS && episode > curE))
    : season !== null ? season > curS
    : episode !== null ? episode > curE
    : false;
}

describe("posInt", () => {
  it("rejects 0, negatives, floats and non-numbers -- 'season 0' is not a thing", () => {
    // A silently-coerced 0 would read downstream as a real position.
    expect(posInt(4)).toBe(4);
    expect(posInt(0)).toBeNull();
    expect(posInt(-2)).toBeNull();
    expect(posInt(4.7)).toBe(4);
    expect(posInt("4")).toBeNull();
    expect(posInt(NaN)).toBeNull();
    expect(posInt(Infinity)).toBeNull();
    expect(posInt(null)).toBeNull();
    expect(posInt(undefined)).toBeNull();
  });
});

describe("parseEpisodeCode -- must agree with the Discord-side parser", () => {
  it("reads the forms Raziel types", () => {
    expect(parseEpisodeCode("S4E5")).toEqual({ season: 4, episode: 5 });
    expect(parseEpisodeCode("s04e05")).toEqual({ season: 4, episode: 5 });
    expect(parseEpisodeCode("4x5")).toEqual({ season: 4, episode: 5 });
    expect(parseEpisodeCode("season 4 episode 5")).toEqual({ season: 4, episode: 5 });
  });

  it("a bare episode carries no season, so the shelf's own season is kept", () => {
    expect(parseEpisodeCode("episode 6")).toEqual({ season: null, episode: 6 });
  });

  it("finds nothing rather than guessing", () => {
    expect(parseEpisodeCode("blade runner")).toEqual({ season: null, episode: null });
    expect(parseEpisodeCode("")).toEqual({ season: null, episode: null });
  });
});

describe("formatPosition", () => {
  it("renders one canonical position string for every surface", () => {
    // Composed server-side so no consumer has to reassemble it from two integers and none of them
    // can disagree about how to write it.
    expect(formatPosition({ season: 4, episode: 2 })).toBe("S4E2");
    expect(formatPosition({ season: 4, episode: null })).toBe("S4");
    expect(formatPosition({ season: null, episode: 6 })).toBe("E6");
    expect(formatPosition({ season: null, episode: null })).toBe("");
  });
});

describe("forward-only advance -- the rule that keeps one loose comment from poisoning the shelf", () => {
  it("advances within a season", () => {
    expect(advances({ season: 4, episode: 2 }, { season: 4, episode: 3 })).toBe(true);
  });

  it("advances across a season boundary", () => {
    expect(advances({ season: 4, episode: 11 }, { season: 5, episode: 1 })).toBe(true);
  });

  it("does NOT rewind on a rewatch of an earlier episode", () => {
    // The event is still logged -- that they watched it is true -- but the position holds.
    expect(advances({ season: 4, episode: 5 }, { season: 4, episode: 2 })).toBe(false);
    expect(advances({ season: 4, episode: 5 }, { season: 3, episode: 9 })).toBe(false);
  });

  it("does NOT re-advance on the same episode twice", () => {
    expect(advances({ season: 4, episode: 5 }, { season: 4, episode: 5 })).toBe(false);
  });

  it("advances from an empty shelf", () => {
    expect(advances({ season: null, episode: null }, { season: 1, episode: 1 })).toBe(true);
  });

  it("a viewing with no position at all never moves the shelf", () => {
    // "we watched some Fargo" is a real event and a non-answer about position.
    expect(advances({ season: 4, episode: 5 }, { season: null, episode: null })).toBe(false);
  });

  it("a bare episode compares against the episode only", () => {
    expect(advances({ season: 4, episode: 5 }, { season: null, episode: 6 })).toBe(true);
    expect(advances({ season: 4, episode: 5 }, { season: null, episode: 3 })).toBe(false);
  });
});

describe("enum surfaces", () => {
  it("`surface` can name every substrate, which is the point of recording it", () => {
    // The original bug was that a Claude-thread viewing left no trace the Discord bots could see.
    // Recording WHICH substrate a viewing came from makes that gap diagnosable instead of looking
    // like a companion who forgot.
    expect(WATCH_SURFACES.has("claude")).toBe(true);
    expect(WATCH_SURFACES.has("discord")).toBe(true);
    expect(WATCH_SURFACES.has("hearth")).toBe(true);
  });

  it("paused and abandoned are distinct -- 'want to pick it back up?' depends on it", () => {
    expect(WATCH_STATUSES.has("paused")).toBe(true);
    expect(WATCH_STATUSES.has("abandoned")).toBe(true);
    expect(WATCH_STATUSES.has("watching")).toBe(true);
    expect(WATCH_STATUSES.has("finished")).toBe(true);
  });
});
