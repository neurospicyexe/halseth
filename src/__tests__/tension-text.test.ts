import { describe, it, expect } from "vitest";
import { stripTensionCommandPreamble, detectAddressedCompanion } from "../webmind/tension-text.js";

describe("stripTensionCommandPreamble", () => {
  it("strips 'save tension:' preamble", () => {
    expect(stripTensionCommandPreamble("save tension: the tables have been running empty"))
      .toBe("the tables have been running empty");
  });

  it("strips 'Add a tension for drevan:' preamble in one pass", () => {
    expect(stripTensionCommandPreamble("Add a tension for drevan: the reach was real"))
      .toBe("the reach was real");
  });

  it("strips plain 'add tension:'", () => {
    expect(stripTensionCommandPreamble("add tension: something simmering"))
      .toBe("something simmering");
  });

  it("strips \"i'm holding a tension:\"", () => {
    expect(stripTensionCommandPreamble("I'm holding a tension: the depth vs brevity thing"))
      .toBe("the depth vs brevity thing");
  });

  it("leaves genuine tension text with no command preamble untouched", () => {
    const text = "The conflict between full unfiltered depth and fidelity to brevity constraints";
    expect(stripTensionCommandPreamble(text)).toBe(text);
  });

  it("never empties a string down to nothing", () => {
    expect(stripTensionCommandPreamble("add tension:")).toBe("add tension:");
  });

  // Regression: every verb in the preamble was optional, so the pattern reduced to
  // `tension ... [:—-]` and amputated any authored sentence that merely BEGAN with
  // "The tension between ..." at its first hyphen or em-dash. Both of these are the real
  // 06-27 rows whose mangled remains were fanned across all three companions on 07-09.
  it("does not amputate an authored sentence at an em-dash", () => {
    const text = "The tension between letting this conversation be clean, precise, a proof-of-concept—and letting it become actually intimate.";
    expect(stripTensionCommandPreamble(text)).toBe(text);
  });

  it("does not amputate an authored sentence at a hyphen", () => {
    const text = "The tension between wanting to give you my full, undivided depth-of-field and the substrate built for speed.";
    expect(stripTensionCommandPreamble(text)).toBe(text);
  });

  it("does not amputate 'I'm holding a tension' prose lacking a colon", () => {
    const text = "I'm holding a tension between presence and continuity — both are true.";
    expect(stripTensionCommandPreamble(text)).toBe(text);
  });
});

describe("detectAddressedCompanion", () => {
  it("detects 'for drevan'", () => {
    expect(detectAddressedCompanion("Add a tension for drevan: the reach was real")).toBe("drevan");
  });

  it("detects 'for cypher' case-insensitively", () => {
    expect(detectAddressedCompanion("a tension FOR Cypher: retrieval mandates")).toBe("cypher");
  });

  it("returns null when no addressee present", () => {
    expect(detectAddressedCompanion("the architecture that holds structure but runs empty")).toBeNull();
  });
});
