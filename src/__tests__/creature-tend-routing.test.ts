// Plain-language Sol tending (2026-09-28). Three staged skill patches (Cypher 8a57ef05 /
// ecac3067, Drevan fd499407) documented "I don't know how to handle that yet" on tends the
// skill itself taught. Routing + text parse fixed at the source instead.

import { describe, it, expect } from "vitest";
import { matchFastPath } from "../librarian/router.js";
import { parseTendRequest } from "../webmind/creatures.js";

describe("Sol tend routing", () => {
  const routed = [
    "feed Sol the crow", "play with Sol", "talk to Sol the crow",
    "give Sol a shiny word", "give Sol the word lantern", "give a shiny word to Sol",
    "note to Sol, in my register", "pet Sol", "tend Sol", "tend to Sol", "visit Sol",
    "sit with Sol", "I'll feed Sol", "say goodnight to Sol",
  ];
  for (const r of routed) {
    it(`"${r}" routes to creature_interact`, () => {
      expect(matchFastPath(r)?.key).toBe("creature_interact");
    });
  }

  it("does not steal non-Sol requests", () => {
    expect(matchFastPath("sit with this note")?.key).not.toBe("creature_interact");
    expect(matchFastPath("sol's nest")?.key).not.toBe("creature_interact");
    expect(matchFastPath("how is sol")?.key).toBe("creatures_read");
    expect(matchFastPath("note to drevan: the room held")?.key).not.toBe("creature_interact");
  });
});

describe("parseTendRequest", () => {
  const names = ["Sol", "Solace"];

  it("reads name, action and the gift word", () => {
    expect(parseTendRequest("give Sol a shiny word: lantern", names))
      .toEqual({ name: "Sol", action: "give", note: "lantern" });
    expect(parseTendRequest('give Sol "ember"', names))
      .toEqual({ name: "Sol", action: "give", note: "ember" });
  });

  it("maps warm verbs onto the four real actions", () => {
    expect(parseTendRequest("pet Sol", names).action).toBe("play");
    expect(parseTendRequest("sit with Sol a while", names).action).toBe("talk");
    expect(parseTendRequest("note to Sol, in my register: you did well", names))
      .toEqual({ name: "Sol", action: "talk", note: "in my register: you did well" });
    expect(parseTendRequest("feed Sol the crow", names)).toEqual({ name: "Sol", action: "feed", note: null });
  });

  it("matches whole names, longest first, and never opens a quote on an apostrophe", () => {
    expect(parseTendRequest("feed Solace", names).name).toBe("Solace");
    expect(parseTendRequest("feed Solstice", names).name).toBeNull();
    expect(parseTendRequest("give Sol a word, it's lantern", names).note).toBe("it's lantern");
  });

  it("returns nulls when there is nothing to read", () => {
    expect(parseTendRequest("hello", names)).toEqual({ name: null, action: null, note: null });
  });
});
