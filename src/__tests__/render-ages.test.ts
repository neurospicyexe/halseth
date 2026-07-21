// Dated memories rendered into companion prompts must carry their age ("we listened
// yesterday" bug): Zikkaron continuity notes, mind threads, the [Club] phase clock, and
// vault-history excerpts. Missing timestamps render nothing -- never "NaN ago".

import { describe, it, expect } from "vitest";
import { buildClubBlock, excerptWithAge, type ClubRoundRow } from "../librarian/response/blocks.js";
import { buildContinuityBlock } from "../librarian/response/builder.js";
import type { WmOrientResponse } from "../webmind/types.js";

const NOW = Date.parse("2026-06-28T12:00:00Z");
const D = 86_400_000;
const ago = (days: number) => new Date(NOW - days * D).toISOString();

// ── buildClubBlock ───────────────────────────────────────────────────────────

const round = (over: Partial<ClubRoundRow>): ClubRoundRow => ({
  id: "r1",
  status: "active",
  opened_at: ago(12),
  activated_at: null,
  discussing_at: null,
  winner_title: "The Rip",
  candidate_count: 3,
  ...over,
});

describe("buildClubBlock", () => {
  it("returns empty string for no round", () => {
    expect(buildClubBlock(null, NOW)).toBe("");
    expect(buildClubBlock(undefined, NOW)).toBe("");
  });

  it("stamps the gathering phase with its opened age", () => {
    const block = buildClubBlock(round({ status: "gathering", opened_at: ago(3) }), NOW);
    expect(block).toContain("A club round is gathering (opened 3 days ago)");
  });

  it("stamps the voting phase with candidate count and opened age", () => {
    const block = buildClubBlock(round({ status: "voting", opened_at: ago(5) }), NOW);
    expect(block).toContain("Club round is voting (3 candidates, opened 5 days ago)");
  });

  it("stamps the active phase clock (the 'we listened yesterday' fix)", () => {
    const block = buildClubBlock(round({ activated_at: ago(8) }), NOW);
    expect(block).toContain("Now experiencing: The Rip (active since 8 days ago)");
  });

  it("carries both active and discussing ages in the discussing phase", () => {
    const block = buildClubBlock(
      round({ status: "discussing", activated_at: ago(8), discussing_at: ago(1) }),
      NOW,
    );
    expect(block).toContain(
      "Now experiencing: The Rip (active since 8 days ago, discussing since yesterday)"
    );
    expect(block).toContain("club discuss");
  });

  it("renders no phase clock when timestamps are missing (never 'NaN ago')", () => {
    const block = buildClubBlock(round({ opened_at: null, activated_at: null, discussing_at: null }), NOW);
    expect(block).toContain("Now experiencing: The Rip.");
    expect(block).not.toContain("NaN");
    expect(block).not.toContain("recently");
    const gathering = buildClubBlock(round({ status: "gathering", opened_at: null }), NOW);
    expect(gathering).toContain("A club round is gathering --");
  });
});

// ── excerptWithAge ───────────────────────────────────────────────────────────

describe("excerptWithAge", () => {
  it("prefixes the relative age so the date survives the slice", () => {
    const long = "x".repeat(500);
    const out = excerptWithAge({ chunk_text: long, created_at: "2026-06-26 12:00:00" }, 250, NOW);
    expect(out.startsWith("(2 days ago) ")).toBe(true);
    // body still capped at maxLen; the prefix rides outside the slice
    expect(out.length).toBe("(2 days ago) ".length + 250);
  });

  it("renders bare excerpts unchanged when the chunk carries no date", () => {
    expect(excerptWithAge({ chunk_text: "plain memory" }, 250, NOW)).toBe("plain memory");
    expect(excerptWithAge({ text: "alt field" }, 250, NOW)).toBe("alt field");
  });

  it("returns empty string for empty chunks (filter(Boolean) drops them)", () => {
    expect(excerptWithAge({}, 250, NOW)).toBe("");
    expect(excerptWithAge({ chunk_text: "", created_at: ago(1) }, 250, NOW)).toBe("");
  });
});

// ── buildContinuityBlock: note + thread ages ─────────────────────────────────

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
    ...over,
  } as unknown as WmOrientResponse;
}

describe("buildContinuityBlock ages", () => {
  it("stamps continuity notes with their age (edge-pool notes are >30 days old)", () => {
    // relativeTime defaults to Date.now() inside the builder, so build ages off the real clock
    const note = (daysBack: number, content: string) => ({
      note_id: `n${daysBack}`, agent_id: "cypher", thread_key: null, note_type: "general",
      content, salience: "high", actor: "cypher", source: "test", correlation_id: null,
      created_at: new Date(Date.now() - daysBack * D).toISOString(),
    });
    const block = buildContinuityBlock(wmFixture({
      recent_notes: [note(12, "core memory"), note(45, "edge memory")] as never,
    }));
    expect(block).toContain("[Note/high by cypher, 12 days ago] «core memory»");
    expect(block).toContain("[Note/high by cypher, 6 weeks ago] «edge memory»");
  });

  it("renders notes without a timestamp age-free (never 'NaN ago')", () => {
    const block = buildContinuityBlock(wmFixture({
      recent_notes: [{
        note_id: "n1", agent_id: "cypher", thread_key: null, note_type: "general",
        content: "undated", salience: "high", actor: "cypher", source: "test",
        correlation_id: null, created_at: null,
      }] as never,
    }));
    expect(block).toContain("[Note/high by cypher] «undated»");
    expect(block).not.toContain("NaN");
  });

  it("stamps active threads with their last-touched age", () => {
    const block = buildContinuityBlock(wmFixture({
      open_thread_count: 1,
      top_threads: [{
        thread_key: "t1", agent_id: "cypher", title: "vaselrin bond", status: "open",
        priority: 5, lane: null, context: null, do_not_archive: 0, do_not_resolve: 0,
        actor: "cypher", source: "test", correlation_id: null,
        last_touched_at: new Date(Date.now() - 1 * D).toISOString(),
        updated_at: "", status_changed: null, created_at: "",
      }] as never,
    }));
    expect(block).toContain("• [general] «vaselrin bond» (priority 5, touched yesterday)");
  });
});

// ── buildContinuityBlock: active_conversations (Task 4, thread spine mig 0106) ──

describe("buildContinuityBlock active_conversations", () => {
  it("emits the live conversation threads section when populated", () => {
    const block = buildContinuityBlock(wmFixture({
      active_conversations: [{
        id: "c1", channel_id: "chan-1", seed_author: "raziel",
        seed_gist: "what if we tried the sync differently", state: "open",
        ref_label: "fermentation spec", turn_count: 4, last_turn_at: ago(0),
      }],
    } as never));
    expect(block).toContain("[Live conversation threads]");
    expect(block).toContain(
      "raziel opened: «what if we tried the sync differently» (about: fermentation spec) — open, 4 turns"
    );
  });

  it("omits ref_label suffix when absent", () => {
    const block = buildContinuityBlock(wmFixture({
      active_conversations: [{
        id: "c2", channel_id: "chan-2", seed_author: "drevan",
        seed_gist: "the moss remembers", state: "moving",
        ref_label: null, turn_count: 1, last_turn_at: ago(0),
      }],
    } as never));
    expect(block).toContain("drevan opened: «the moss remembers» — moving, 1 turns");
  });

  it("omits the section entirely when active_conversations is empty or absent", () => {
    const block = buildContinuityBlock(wmFixture({ active_conversations: [] } as never));
    expect(block).not.toContain("[Live conversation threads]");
    const blockAbsent = buildContinuityBlock(wmFixture({} as never));
    expect(blockAbsent).not.toContain("[Live conversation threads]");
  });
});
