import { describe, it, expect } from "vitest";
import {
  blindForRanker,
  parseRanking,
  tallyRankings,
  insertQuestionSql,
  nextOpenQuestionSql,
  closeQuestionSql,
} from "../webmind/council.js";

const answers = [
  { companion_id: "cypher", answer: "the logical read" },
  { companion_id: "drevan", answer: "the spiral read" },
  { companion_id: "gaia", answer: "the witness read" },
];

describe("blindForRanker", () => {
  it("excludes the ranker's own answer and labels the rest", () => {
    const blinded = blindForRanker(answers, "cypher", 0);
    expect(blinded).toHaveLength(2);
    expect(blinded.map(b => b.companion_id)).not.toContain("cypher");
    expect(blinded[0]!.label).toBe("Answer A");
    expect(blinded[1]!.label).toBe("Answer B");
  });
  it("rotates label assignment so the convention is not stable across rankers", () => {
    const r0 = blindForRanker(answers, "gaia", 0); // peers: cypher, drevan
    const r1 = blindForRanker(answers, "gaia", 1);
    expect(r0[0]!.companion_id).not.toBe(r1[0]!.companion_id);
  });
});

describe("parseRanking", () => {
  const blinded = blindForRanker(answers, "cypher", 0); // A=drevan, B=gaia
  it("maps letters back to companions in preference order", () => {
    expect(parseRanking("B > A", blinded)).toEqual(["gaia", "drevan"]);
  });
  it("handles JSON-ish and prose forms", () => {
    expect(parseRanking('["A","B"]', blinded)).toEqual(["drevan", "gaia"]);
    expect(parseRanking("1. Answer A is best\n2. Answer B", blinded)).toEqual(["drevan", "gaia"]);
  });
  it("appends omitted peers as least-preferred (stable)", () => {
    expect(parseRanking("A", blinded)).toEqual(["drevan", "gaia"]);
  });
});

describe("tallyRankings (Borda)", () => {
  const candidates = ["cypher", "drevan", "gaia"];
  it("sums positional points across rankers and picks the winner", () => {
    // Two rankers both put drevan first.
    const { winner, scores } = tallyRankings(
      [{ ranking: ["drevan", "gaia"] }, { ranking: ["drevan", "cypher"] }],
      candidates,
    );
    expect(winner).toBe("drevan");
    expect(scores["drevan"]).toBe(4); // 2 + 2
  });
  it("breaks ties alphabetically for stable re-runs", () => {
    const { winner } = tallyRankings([{ ranking: [] }], candidates);
    expect(winner).toBe("cypher"); // all 0 -> alphabetical
  });
});

describe("sql builders", () => {
  it("insert/next/close target council_questions", () => {
    expect(insertQuestionSql()).toContain("INSERT INTO council_questions");
    expect(nextOpenQuestionSql()).toContain("status = 'open'");
    expect(closeQuestionSql()).toContain("status = 'closed'");
    expect(closeQuestionSql()).toContain("winning_companion_id = ?");
  });
});
