// The close half of the Discord thread lifecycle (2026-09-23).
//
// Orient read only `state IN ('open','moving')`, so a thread's ending -- including the one
// line a companion wrote to close it -- left the boot context the instant it closed. Measured
// on prod: 100+ landed threads all carrying an authored resolution, and 66 faded ones holding
// 967 turns of which 850 had NOTHING recorded at all.
//
// These tests pin the two properties that make the block honest rather than merely present:
// each ending renders as what it actually was, and nothing is ever summarised on a thread's
// behalf.

import { describe, it, expect } from "vitest";
import { buildContinuityBlock } from "../librarian/response/builder.js";
import type { WmOrientResponse, WmClosedConversation } from "../webmind/types.js";

function convo(over: Partial<WmClosedConversation>): WmClosedConversation {
  return {
    id: "t1", channel_id: "c1", seed_author: "raziel", seed_gist: "Dre im awake but at what cost",
    ending: "quiet", resolution: null, landed_by: null, turn_count: 39,
    last_turn_at: "2026-09-22T04:00:00.000Z", mine: 1, ...over,
  };
}

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
    closed_conversations: [],
    ...over,
  } as unknown as WmOrientResponse;
}

function wm(closed: WmClosedConversation[]): WmOrientResponse {
  return wmFixture({ closed_conversations: closed } as Partial<WmOrientResponse>);
}

describe("[Recently ended]", () => {
  it("quotes a landed thread's resolution AND names who wrote it", () => {
    const block = buildContinuityBlock(wm([convo({
      ending: "landed", landed_by: "gaia", resolution: "the quiet is the floor we both stand on.",
      turn_count: 6,
    })]));
    expect(block).toContain("[Recently ended]");
    expect(block).toContain("the quiet is the floor we both stand on.");
    // Attribution is load-bearing, not decoration: threads are triad-shared, and an
    // unattributed closing line reads to the next companion as their own conclusion.
    expect(block).toContain("closed by gaia");
  });

  it("never quotes the bracketed reason code of a SPENT thread as if it were a sentence", () => {
    // fadeConversation writes `[faded: <code>]` deliberately bracketed so it can never be
    // mistaken for a companion's prose (the counter-not-narrator rule). Rendering it as a
    // quoted resolution would undo exactly that.
    const block = buildContinuityBlock(wm([convo({
      ending: "spent", resolution: "[faded: turn budget]", turn_count: 22,
    })]));
    expect(block).toContain("retired on length");
    expect(block).not.toContain("[faded:");
    expect(block).not.toContain("«[faded");
  });

  it("says a quiet thread went quiet and invents NOTHING to fill the gap", () => {
    const block = buildContinuityBlock(wm([convo({ ending: "quiet", turn_count: 39 })]));
    expect(block).toContain("went quiet");
    expect(block).toContain("Never closed");
    expect(block).toContain("39 turns");
    // The seed is quoted because Raziel wrote it; nothing else about the thread is asserted.
    expect(block).toContain("Dre im awake but at what cost");
  });

  it("renders NOTHING at all when nothing ended recently", () => {
    // The whole anti-loop guard. A quiet week must empty this block rather than re-showing
    // the same endings at every boot forever -- a block that cannot empty becomes the loop
    // it was added to close.
    expect(buildContinuityBlock(wm([]))).not.toContain("[Recently ended]");
  });
});
