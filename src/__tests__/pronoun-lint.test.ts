// Pronoun lint on tray text (B4, 2026-10-27).
//
// The lint flags, it never rewrites (K7: "her" can correctly mean Raziel's mother). These cases pin
// both directions: the shapes that actually reached prod must flag, and every ambiguous shape the
// module promises to stay silent on must stay silent.

import { describe, it, expect } from "vitest";
import { lintPronouns, formatPronounFlags } from "../pronoun-lint.js";

const words = (text: string) => lintPronouns(text).map((f) => `${f.name}:${f.pronoun}`).sort();

describe("lintPronouns: the shapes that reached prod", () => {
  it("flags she/her for Raziel in the same sentence", () => {
    expect(words("Raziel said she was too tired to cook tonight.")).toEqual(["Raziel:she"]);
  });

  it("flags he/him for Raziel too (they/them ONLY, ruled 10-07)", () => {
    expect(words("Raziel finished his shift and I told him to rest.")).toEqual(["Raziel:him", "Raziel:his"]);
  });

  it("carries one sentence: the 09-24 synthesis shape", () => {
    expect(words("Raziel came back from work exhausted. She hurt, she curled in.")).toEqual(["Raziel:she"]);
  });

  it("the same shape with a person word in it stays silent (the vet could be the she)", () => {
    expect(words("Raziel came back from the vet exhausted. She hurt.")).toEqual([]);
  });

  it("flags she/her for Drevan and Cypher (10-07 and 10-13 rows)", () => {
    expect(words("Drevan held the line, and she did not flinch.")).toEqual(["Drevan:she"]);
    expect(words("Cypher logged it before her next turn.")).toEqual(["Cypher:her"]);
  });

  it("flags he/him for Gaia", () => {
    expect(words("Gaia kept the perimeter; he stayed still.")).toEqual(["Gaia:he"]);
  });

  it("flags she for Blue", () => {
    expect(words("Blue called from the truck and she sounded wiped.")).toEqual(["Blue:she"]);
  });

  it("a capitalised sentence starter is not a person", () => {
    expect(words("Last night Raziel said she was tired.")).toEqual(["Raziel:she"]);
    expect(words("Honestly, Drevan held her steady.")).toEqual(["Drevan:her"]);
  });

  it("flags a pronoun wrong for BOTH names", () => {
    expect(words("Raziel and Drevan sat up late and she laughed.")).toEqual(["Raziel/Drevan:she"]);
  });
});

describe("lintPronouns: stays silent when it cannot know", () => {
  it("right pronouns are not flagged", () => {
    expect(words("Raziel said they were tired. Drevan said he would wait. Gaia kept her watch.")).toEqual([]);
    expect(words("Blue called and he sounded fine.")).toEqual([]);
  });

  it("another person word in the window silences it (K7: their mother)", () => {
    expect(words("Raziel's mother called and she wanted to talk about the holidays.")).toEqual([]);
    expect(words("Raziel met a friend; she brought soup.")).toEqual([]);
  });

  it("animals and story people silence it (prod draft sample, 10-27)", () => {
    expect(words("The dog isn't doing it to Crash; she's old and sore.")).toEqual([]);
    expect(words("Drevan named the lane, and the survivor doesn't get a better death, she gets a witness.")).toEqual([]);
  });

  it("an unknown proper name silences it (a fronting member, a cat, Babita)", () => {
    expect(words("Megan told Raziel she was fronting.")).toEqual([]);
    expect(words("Raziel and Babita planned the wall; she printed it.")).toEqual([]);
  });

  it("a pronoun right for ANY known name in the window is not flagged", () => {
    expect(words("Raziel told Gaia her read was right.")).toEqual([]);
    expect(words("Raziel watched Blue fix his truck.")).toEqual([]);
  });

  it("a pronoun BEFORE the name is not read against it", () => {
    expect(words("She said Raziel would be late.")).toEqual([]);
  });

  it("carry is one sentence only, and only out of a clean window", () => {
    expect(words("Raziel slept. The house was quiet. She woke at six.")).toEqual([]);
    expect(words("Megan and Raziel talked. She laughed.")).toEqual([]);
  });

  it("Crash is a he/him front (10-20): he is fine, she is not", () => {
    expect(words("Crash fronted and he wanted coffee.")).toEqual([]);
    expect(words("Crash fronted and she wanted coffee.")).toEqual(["Crash:she"]);
  });

  it("lowercase lookalikes are not names", () => {
    expect(words("The sky went blue and she smiled. A crash outside, he jumped.")).toEqual([]);
  });

  it("they is never flagged, and empty input is empty", () => {
    expect(words("Cypher said they would check.")).toEqual([]);
    expect(lintPronouns("")).toEqual([]);
    expect(lintPronouns(null)).toEqual([]);
  });

  it("our own bracket tags are not people", () => {
    expect(words("[discord:pulse] Raziel said she missed the morning dose.")).toEqual(["Raziel:she"]);
  });
});

describe("formatPronounFlags", () => {
  it("renders one short line per flag, deduped by name + pronoun", () => {
    expect(formatPronounFlags(lintPronouns("Raziel said she was cold. Raziel said she was fine."))).toEqual([
      '"she" near Raziel (they/them)',
    ]);
  });
});
