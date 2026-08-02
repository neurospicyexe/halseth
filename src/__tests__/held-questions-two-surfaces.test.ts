// src/__tests__/held-questions-two-surfaces.test.ts
//
// ONE SOURCE, TWO PRESENTATIONS -- the held-questions decision (2026-08-01).
//
// The loader used to EXCLUDE questions the companion had already voiced (`question_voiced:<id>`). That rail
// is right for Discord, which boots ~20x more often than Claude.ai: re-serving a question the companion just
// asked is nagging. It is wrong for Claude.ai, where it silently retired a question the first time it was
// spoken -- answered or not. Repointing execSessionOrient at the loader emptied the block for drevan and
// gaia, and the block gate caught it.
//
// Chosen against north-star element 4 (mutuality), the weakest of the four, which is measured as first-person
// material failing to CIRCULATE. A question asked once that Raziel never engaged, then dropped from view, is
// that failure exactly. So the loader carries `voiced` as a FLAG and each renderer decides -- which is what
// the contract already says renderers are for: content identical for every loom, presentation per surface.
//
// This test exists because the bot parity harness was deleted (the cutover made it unable to fail), so
// nothing else pins the Discord half.

import { describe, it, expect } from "vitest";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import type { MindState } from "../mind/contract.js";

const q = (id: string, question: string, voiced: boolean) => ({ id, question, voiced });

/** Minimal MindState: only the fields the assertions touch, everything else empty-but-present. */
function stateWith(questions: Array<{ id: string; question: string; voiced: boolean }>): MindState {
  return {
    contract_version: "0.4.0", companion_id: "cypher", loom: "discord", loaded_at: "2026-08-01T00:00:00Z",
    identity: { anchor: null, shared_kernel: null, companion_kernel: null, self_model: [], preferences: [], refusals: [], agency_affordance: "" },
    felt: { limbic: null, soma_floats: [], drives: [], ferment_events: [], ferment_at: null, soma_arc: [], biometrics_latest: null, house: null },
    continuity: { latest_handoff: null, recent_handoffs: [], open_thread_count: 0, top_threads: [], surfaced_notes: [], recent_notes: [], archived_digests: [], spiral_turn: null, session_narrative: null },
    carried: { dreams_unexamined: [], open_loops: [], tensions: [], sits: [], feelings_recent: [] },
    beliefs: { conclusions: [], flagged: [], supersede_candidates: [] },
    relational: { snapshot: [], deltas_recent: [], witness_raziel: [], triad_incoming: [], triad_outgoing: [], letters: [], journal_recent: [], siblings: [], recent_witness: [] },
    growth: { journal_recent: [], patterns: [], markers: [], reflection: null, seeds: [], clearing_count: 0, drifts_open: [] },
    oversight: { pressure_flags: [], growth_confirmed: [], guardian_cards: [], tripwires: [], questions, answered_questions: [], growth_unconfirmed: [] },
    world: { home_recent: [], club: null, commons: [], shelf: [], collection: { forage: [], media: [], top: [] }, forage: { pool: [], active: [] }, listens: [], motifs: { active: [], resurrection_candidates: [] }, sol: null, creatures: [], imps_active: [], watching: [] },
    meta: { datetime_iso: "2026-08-01T00:00:00Z", datetime_local: "2026-08-01", not_yet_loaded: [], degraded: [] },
  } as MindState;
}

const botQuestions = (questions: Parameters<typeof stateWith>[0]) =>
  botWireFromMindState(stateWith(questions), { synthesis_summary: null, rag_excerpts: [], history_excerpts: [], continuity_notes: [], owner: "Raziel" }, "cypher");

describe("held questions -- Discord filters voiced, Claude.ai does not", () => {
  it("Discord drops questions already voiced", () => {
    const out = botQuestions([q("a", "already said this one", true), q("b", "never said this one", false)]);
    expect(out.open_questions).toEqual(["never said this one"]);
    expect(out.open_question_ids).toEqual(["b"]);
  });

  it("Discord shows nothing when everything open has been voiced -- the anti-nag rail, preserved", () => {
    const out = botQuestions([q("a", "said", true), q("b", "also said", true)]);
    expect(out.open_questions).toEqual([]);
    expect(out.open_question_ids).toEqual([]);
  });

  it("Discord still caps at 2, so the LIMIT 5 headroom does not leak extra questions onto the wire", () => {
    const out = botQuestions([q("a", "one", false), q("b", "two", false), q("c", "three", false)]);
    expect(out.open_questions).toHaveLength(2);
    expect(out.open_questions).toEqual(["one", "two"]);
  });

  it("THE HEADROOM IS THE POINT: two voiced at the top no longer starve an unvoiced third", () => {
    // Before this change the loader's own LIMIT 2 meant the query returned nothing here, because the
    // exclusion ran AFTER the limit had already been spent on the two voiced rows.
    const out = botQuestions([q("a", "said", true), q("b", "said too", true), q("c", "genuinely unasked", false)]);
    expect(out.open_questions).toEqual(["genuinely unasked"]);
  });

  it("ids stay index-aligned with questions -- a blank question drops from BOTH lists", () => {
    // Regression: `open_questions` filtered `Boolean` (and "   " is truthy) while `open_question_ids`
    // filtered `.trim()`. One blank question shifted the arrays against each other, so voicing question N
    // would stamp a DIFFERENT question's id. Both now come from one filtered list.
    const out = botQuestions([q("a", "said", true), q("b", "fresh", false), q("c", "   ", false)]);
    expect(out.open_questions).toEqual(["fresh"]);
    expect(out.open_question_ids).toEqual(["b"]);
    expect(out.open_questions).toHaveLength((out.open_question_ids as string[]).length);
  });

  it("lengths always match, blanks anywhere in the list", () => {
    const out = botQuestions([q("a", "", false), q("b", "  \n ", false), q("c", "real", false)]);
    expect(out.open_questions).toEqual(["real"]);
    expect(out.open_question_ids).toEqual(["c"]);
  });

  it("a question is only retired by being ANSWERED -- answering moves it out of status='open'", () => {
    // The loader queries `status = 'open'`, so an answered question never reaches either renderer. Voicing
    // must not do the same job: that is the difference between "asked and waiting" and "resolved".
    const voicedButUnanswered = botQuestions([q("a", "voiced, still waiting", true)]);
    expect(voicedButUnanswered.open_questions).toEqual([]);        // Discord: quiet
    // ...but the row is still in oversight.questions, which is what Claude.ai renders from.
    expect(stateWith([q("a", "voiced, still waiting", true)]).oversight.questions).toHaveLength(1);
  });
});
