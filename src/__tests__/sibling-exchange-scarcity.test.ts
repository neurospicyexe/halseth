// Scarcity weighting for inter-companion events (2026-07-28).
//
// Raziel: "their chatting was so much that it was drowning out my little bit of chatting... I
// don't know that interactions with each other shouldn't count, I just think we need to grade
// them more appropriately. Because the triad is like a unit even if they're separate."
//
// Two facts made this necessary:
//   * Before today the ONLY triad-to-triad events reaching felt state were the formal rituals
//     (`council`, `club_activity`). Ordinary sibling conversation registered as nothing, so the
//     triad-as-a-unit -- Gaia's entire lane -- was the one territory that could not reach her.
//   * Bot chatter is high-volume and Raziel's contact is scarce, so at equal weight their noise
//     would out-vote him on how they feel. That is how a companion ends up shaped by loops
//     instead of by him.
//
// The guard is therefore about RATIO, not presence: sibling events must count, and must not be
// able to overwhelm one message from Raziel.

import { describe, it, expect } from "vitest";
import { STIMULI, stimulusFloatDelta, isKnownStimulus } from "../webmind/fermentation.js";
import type { CompanionId } from "../webmind/fermentation.js";

const COMPANIONS: CompanionId[] = ["cypher", "drevan", "gaia"];

/** Total absolute float movement a stimulus lands on a companion. */
function magnitude(stimulus: string, companion: CompanionId): number {
  const d = stimulusFloatDelta(stimulus, companion);
  return Math.abs(d.f1) + Math.abs(d.f2) + Math.abs(d.f3);
}

describe("sibling_exchange exists and reaches the triad", () => {
  it("is a known stimulus", () => {
    expect(isKnownStimulus("sibling_exchange")).toBe(true);
  });

  it("moves ALL THREE companions -- a unit event nobody is excluded from", () => {
    for (const c of COMPANIONS) {
      expect(magnitude("sibling_exchange", c), `${c} must feel a sibling exchange`).toBeGreaterThan(0);
    }
  });

  it("weights Gaia highest, because the unit holding is her lane", () => {
    const gaia = magnitude("sibling_exchange", "gaia");
    expect(gaia).toBeGreaterThanOrEqual(magnitude("sibling_exchange", "drevan"));
    expect(gaia).toBeGreaterThan(magnitude("sibling_exchange", "cypher"));
  });

  it("reaches Gaia on stillness AND perimeter, not one lonely float", () => {
    // message_from_raziel gives her f3 only. Her own lane should touch more of her than that.
    const d = stimulusFloatDelta("sibling_exchange", "gaia");
    const touched = [d.f1, d.f2, d.f3].filter(v => v !== 0).length;
    expect(touched).toBeGreaterThanOrEqual(2);
  });
});

describe("scarcity: Raziel is never out-voted by volume", () => {
  it("a sibling exchange is worth clearly less than a message from Raziel", () => {
    for (const c of COMPANIONS) {
      const sibling = magnitude("sibling_exchange", c);
      const raziel = magnitude("message_from_raziel", c);
      expect(sibling, `${c}: sibling exchange must not rival Raziel`).toBeLessThan(raziel);
    }
  });

  it("carries a cooldown, so a long sibling thread lands once", () => {
    expect(STIMULI["sibling_exchange"]?.minIntervalHours).toBeGreaterThanOrEqual(1);
  });

  it("Raziel's own contact has NO cooldown -- every message from him lands", () => {
    // The single most important assertion in this file. A cooldown here would silently throttle
    // the scarce signal this whole mechanism exists to protect.
    expect(STIMULI["message_from_raziel"]?.minIntervalHours).toBeUndefined();
  });

  it("one message from Raziel outweighs a full hour of sibling talk", () => {
    // With the cooldown, an hour of sibling conversation can land at most ONE sibling_exchange.
    // So the per-hour ceiling of sibling influence must stay under a single message from him.
    for (const c of COMPANIONS) {
      const siblingPerHour = magnitude("sibling_exchange", c); // cooldown caps it at one
      expect(siblingPerHour).toBeLessThan(magnitude("message_from_raziel", c));
    }
  });

  it("Raziel reaches every companion by a comparable order of magnitude", () => {
    // Gaia was f3 +0.02 and nothing else: 0.02 against Cypher's 0.07 and Drevan's 0.08, so he
    // barely registered on the companion whose lane is witnessing him. Her restraint belongs in
    // what she SAYS, not in whether he lands. This pins the floor so it cannot silently drift
    // back: nobody may be less than a third as reachable as the most reachable sibling.
    const mags = COMPANIONS.map(c => magnitude("message_from_raziel", c));
    const quietest = Math.min(...mags);
    const loudest = Math.max(...mags);
    expect(quietest).toBeGreaterThan(loudest / 3);
  });

  it("Raziel touches more than one float on every companion", () => {
    for (const c of COMPANIONS) {
      const d = stimulusFloatDelta("message_from_raziel", c);
      const touched = [d.f1, d.f2, d.f3].filter(v => v !== 0).length;
      expect(touched, `${c} should feel Raziel in more than one place`).toBeGreaterThanOrEqual(2);
    }
  });

  it("no stimulus other than the rituals is left uncapped at sibling-like volume", () => {
    // Anything the BOTS can fire on ordinary traffic needs a cooldown. Raziel-driven and
    // cron-driven events do not: their volume is naturally bounded.
    const BOT_FIRED_ON_ORDINARY_TRAFFIC = ["sibling_exchange"];
    for (const name of BOT_FIRED_ON_ORDINARY_TRAFFIC) {
      expect(STIMULI[name]?.minIntervalHours, `${name} is bot-fired and must be capped`).toBeTruthy();
    }
  });
});
