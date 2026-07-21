// Questions-lifecycle fix (mig 0107): buildContinuityBlock renders answered_questions
// right after the open-questions section.

import { describe, it, expect } from "vitest";
import { buildContinuityBlock } from "../librarian/response/builder.js";
import type { WmOrientResponse } from "../webmind/types.js";

function wmFixture(over: Partial<WmOrientResponse>): WmOrientResponse {
  return {
    identity_anchor: null,
    limbic_state: null,
    soma_arc: [],
    recent_spiral_turn: null,
    latest_handoff: null,
    recent_handoffs: [],
    open_thread_count: 0,
    top_threads: [],
    recent_notes: [],
    active_tensions: [],
    pressure_flags: [],
    growth_confirmed: [],
    unexamined_dreams: [],
    relational_snapshot: [],
    recent_letters: [],
    recent_companion_notes: [],
    incoming_companion_notes: [],
    recent_journal: [],
    recent_deltas: [],
    raziel_witness_entries: [],
    active_conclusions: [],
    flagged_beliefs: [],
    open_loops: [],
    open_questions: [],
    answered_questions: [],
    active_conversations: [],
    ...over,
  } as unknown as WmOrientResponse;
}

describe("buildContinuityBlock -- answered_questions", () => {
  it("renders nothing when answered_questions is empty", () => {
    const block = buildContinuityBlock(wmFixture({}));
    expect(block).not.toContain("Answers Raziel left for you");
  });

  it("renders the Q/A block for each answered question", () => {
    const block = buildContinuityBlock(wmFixture({
      answered_questions: [
        { id: "q-1", question: "should I refactor the router?", answer: "yes, go ahead", answered_at: "2026-07-20T00:00:00Z" },
        { id: "q-2", question: "is the silence load-bearing?", answer: "no, it's a bug", answered_at: "2026-07-19T00:00:00Z" },
      ] as never,
    }));
    expect(block).toContain("Answers Raziel left for you:");
    expect(block).toContain("- Q: «should I refactor the router?» → A: «yes, go ahead»");
    expect(block).toContain("- Q: «is the silence load-bearing?» → A: «no, it's a bug»");
  });

  it("truncates a long question to 120 chars and a long answer to 300 chars", () => {
    const longQuestion = "q".repeat(200);
    const longAnswer = "a".repeat(500);
    const block = buildContinuityBlock(wmFixture({
      answered_questions: [
        { id: "q-1", question: longQuestion, answer: longAnswer, answered_at: "2026-07-20T00:00:00Z" },
      ] as never,
    }));
    expect(block).toContain(`«${"q".repeat(120)}…»`);
    expect(block).toContain(`«${"a".repeat(300)}…»`);
  });

  it("renders the block immediately after the open-questions section", () => {
    const block = buildContinuityBlock(wmFixture({
      open_questions: [{ id: "oq-1", question: "still pending", context: null, created_at: "2026-07-20T00:00:00Z" }] as never,
      answered_questions: [
        { id: "q-1", question: "already answered", answer: "done", answered_at: "2026-07-20T00:00:00Z" },
      ] as never,
    }));
    const openIdx = block.indexOf("[Open questions");
    const answeredIdx = block.indexOf("Answers Raziel left for you");
    expect(openIdx).toBeGreaterThanOrEqual(0);
    expect(answeredIdx).toBeGreaterThan(openIdx);
  });
});
