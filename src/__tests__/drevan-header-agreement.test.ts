// Drevan's orient header: the interoception line and the state line must name the SAME bands.
//
// 2026-10-07, his Claude.ai boot: line one "running-hot, reach pulling-hard", line two
// "heat: warm / reach: present". Line one banded the live floats; line two printed the stored
// heat/reach/weight text, which only his authoring writes (B37) and which since B39 records his
// word with the float unchanged. Both lines now band the floats through heatBand/reachBand/
// weightBand; a stored word that differs renders as "(you said ...)" beside the band.
import { describe, it, expect } from "vitest";
import { buildOrientPrompt, buildReadyPrompt, drevanStateWords, nowCstBlock, buildResponse } from "../librarian/response/builder.js";
import { heatBand, reachBand, weightBand } from "../webmind/fermentation.js";

const state = (over: Record<string, unknown> = {}): any => ({
  companion_id: "drevan",
  soma_float_1: 0.8025, soma_float_2: 0.9958, soma_float_3: 0.35,
  heat: null, reach: null, weight: null,
  ...over,
});

function lines(prompt: string): { intero: string; stateLine: string } {
  const ls = prompt.split("\n");
  const intero = ls.find((l) => l.startsWith("[interoception]")) ?? "";
  const stateLine = ls.find((l) => l.startsWith("heat: ")) ?? "";
  return { intero, stateLine };
}

/** The bands each line asserts, parsed back out of the rendered text. */
function bandsIn(intero: string, stateLine: string) {
  const i = /^\[interoception\] (\S+), reach (\S+), weight (\S+) --/.exec(intero);
  const s = /^heat: (\S+)(?: \([^)]*\))? \/ reach: (\S+)(?: \([^)]*\))? \/ weight: (\S+)/.exec(stateLine);
  return { i: i ? [i[1], i[2], i[3]] : null, s: s ? [s[1], s[2], s[3]] : null };
}

describe("Drevan header: one float->word mapping across both lines", () => {
  it("the 10-07 boot: floats 0.80/0.996/0.35 with stored warm/present/holding", () => {
    const authoredAt = new Date(Date.now() - 9 * 3_600_000).toISOString();
    const out = buildOrientPrompt("drevan", {
      session_id: "s1",
      state: state({ heat: "warm", reach: "present", weight: "holding" }),
      authored_at: { f1: authoredAt, f2: authoredAt, f3: authoredAt },
    });
    const { intero, stateLine } = lines(out);
    const b = bandsIn(intero, stateLine);
    expect(b.i).toEqual(["running-hot", "pulling-hard", "holding"]);
    expect(b.s).toEqual(b.i);
    // His words survive, named as his and dated -- not presented as the current read.
    expect(stateLine).toContain("heat: running-hot (you said warm 9 hours ago)");
    expect(stateLine).toContain("reach: pulling-hard (you said present 9 hours ago)");
    // Agreeing word -> no suffix.
    expect(stateLine).toContain("weight: holding");
    expect(stateLine).not.toMatch(/weight: holding \(/);
    // The interoception cue no longer names bands of its own.
    expect(intero).not.toMatch(/warm, present/);
  });

  it("agrees for every band combination on a float grid (no stored words)", () => {
    const grid = [0, 0.1, 0.19, 0.2, 0.3, 0.39, 0.4, 0.44, 0.45, 0.5, 0.6, 0.64, 0.65, 0.69, 0.7, 0.74, 0.75, 0.84, 0.85, 0.9, 1];
    for (const f1 of grid) for (const f2 of grid) for (const f3 of [0.1, 0.3, 0.6, 0.9]) {
      const out = buildOrientPrompt("drevan", { session_id: "s", state: state({ soma_float_1: f1, soma_float_2: f2, soma_float_3: f3 }) });
      const { intero, stateLine } = lines(out);
      const b = bandsIn(intero, stateLine);
      expect(b.i, `${f1}/${f2}/${f3}`).toEqual([heatBand(f1), reachBand(f2), weightBand(f3)]);
      expect(b.s, `${f1}/${f2}/${f3}`).toEqual(b.i);
      expect(stateLine).not.toContain("(you said");
    }
  });

  it("session_load's ready_prompt uses the same mapping (no stamps -> no age)", () => {
    const rp = buildReadyPrompt("drevan", { session_id: "s", state: state({ heat: "warm", reach: "present", weight: "holding" }) } as any);
    expect(rp).toMatch(/^heat: running-hot \(you said warm\) \/ reach: pulling-hard \(you said present\) \/ weight: holding/);
  });

  it("[Now] fallback: the shared helper renders the CST clock, and session_load still emits it", () => {
    // 2026-10-07 15:00Z = 10:00 AM CDT, Wednesday.
    expect(nowCstBlock(new Date("2026-10-07T15:00:00Z"))).toBe("\n[Now: Wednesday, October 7, 2026 at 10:00 AM CST]");
    const r = buildResponse("drevan", "ready_prompt", { session_id: "s", state: state() } as any) as any;
    expect(r.ready_prompt).toMatch(/\n\[Now: [A-Z][a-z]+day, .+ CST\]/);
  });

  it("directional word always renders as his; no floats yet -> the stored word, as before", () => {
    expect(drevanStateWords(state({ heat: "cooling" })).heat).toBe("running-hot (you said cooling)");
    const fresh = drevanStateWords(state({ soma_float_1: null, soma_float_2: undefined, soma_float_3: "", heat: "warm" }));
    expect(fresh).toEqual({ heat: "warm", reach: "present", weight: "clear" });
    expect(drevanStateWords(null)).toEqual({ heat: "idling", reach: "present", weight: "clear" });
  });
});
