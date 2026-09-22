// Dated memories rendered into companion prompts must carry their age ("we listened
// yesterday" bug): Zikkaron continuity notes, mind threads, the [Club] phase clock, and
// vault-history excerpts. Missing timestamps render nothing -- never "NaN ago".

import { describe, it, expect } from "vitest";
import { buildClubBlock, excerptWithProvenance, type ClubRoundRow } from "../librarian/response/blocks.js";
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

// ── excerptWithProvenance ───────────────────────────────────────────────────────────

describe("excerptWithProvenance", () => {
  it("prefixes the relative age so the date survives the slice", () => {
    const long = "x".repeat(500);
    const out = excerptWithProvenance({ chunk_text: long, created_at: "2026-06-26 12:00:00" }, 250, NOW);
    expect(out.startsWith("(2 days ago) ")).toBe(true);
    // body still capped at maxLen; the prefix rides outside the slice
    expect(out.length).toBe("(2 days ago) ".length + 250);
  });

  it("renders bare excerpts unchanged when the chunk carries no date", () => {
    expect(excerptWithProvenance({ chunk_text: "plain memory" }, 250, NOW)).toBe("plain memory");
    expect(excerptWithProvenance({ text: "alt field" }, 250, NOW)).toBe("alt field");
  });

  it("returns empty string for empty chunks (filter(Boolean) drops them)", () => {
    expect(excerptWithProvenance({}, 250, NOW)).toBe("");
    expect(excerptWithProvenance({ chunk_text: "", created_at: ago(1) }, 250, NOW)).toBe("");
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

// ── inline provenance at retrieval (2026-09-22, candidate T) ─────────────────
//
// "A model cannot honour provenance it cannot see." The principle was already applied to the
// HISTORY vault lane and not the RAG lane, so `[Vault excerpts]` reached every companion on every
// surface as undated, unattributed text -- while the chunks carried created_at, vault_path and
// section the whole time (verified live: 12 of 12).

import { chunkSource } from "../librarian/response/blocks.js";

describe("chunkSource", () => {
  // `section` is the part of a vault chunk with meaning in it -- sampled live 2026-09-22.
  it("prefers the section over the filename", () => {
    expect(chunkSource({ section: "Database & Memory Architecture", vault_path: "x/2025-09-09-383267a1.md" }))
      .toBe("Database & Memory Architecture");
  });
  it("treats a bare dash section as absent (that is how the index writes 'none')", () => {
    expect(chunkSource({ section: "-", vault_path: "notes/PHOENIX-RECKONING.md" })).toBe("PHOENIX-RECKONING");
  });

  // THE BUG THIS REPLACED: the first cut shipped `(2 weeks ago, b2e47f25-3672-41d7...)` into orient.
  // A uuid is not provenance -- it identifies nothing and costs budget in a block that has one.
  it("drops an id-like basename rather than rendering it", () => {
    expect(chunkSource({ vault_path: "v/04e4cb5c-c71b-4a8b-84d1-e242b5d4dd9c.md" })).toBe("");
  });
  it("drops date+hex export names -- the date is already the age prefix", () => {
    expect(chunkSource({ vault_path: "v/2025-09-09-383267a1.md" })).toBe("");
    expect(chunkSource({ vault_path: "v/2025-06-25-685c4bbe.part1" })).toBe("");
  });
  it("drops bare ordinals", () => {
    expect(chunkSource({ vault_path: "v/3" })).toBe("");
    expect(chunkSource({ vault_path: "v/6.md" })).toBe("");
  });

  it("keeps a real filename and strips only text extensions", () => {
    expect(chunkSource({ vault_path: "vault/notes/boot-ritual.md" })).toBe("boot-ritual");
    expect(chunkSource({ vault_path: "a/diagram.canvas" })).toBe("diagram.canvas");
  });
  it("is empty when the chunk carries neither", () => {
    expect(chunkSource({})).toBe("");
    expect(chunkSource({ vault_path: "   " })).toBe("");
  });
  it("caps a very long section so it cannot eat the excerpt budget", () => {
    expect(chunkSource({ section: "z".repeat(200) }).length).toBe(40);
  });
});

describe("excerptWithProvenance -- source alongside age", () => {
  it("renders age and source together, prefix first so it survives the slice", () => {
    const out = excerptWithProvenance(
      { chunk_text: "x".repeat(400), created_at: "2026-06-26 12:00:00", vault_path: "vault/2026-06-planning.md" },
      50, NOW);
    expect(out.startsWith("(")).toBe(true);
    expect(out).toContain("2026-06-planning");
    expect(out.indexOf(")")).toBeLessThan(40);
  });

  it("renders source alone when the chunk has no date", () => {
    expect(excerptWithProvenance({ chunk_text: "body", vault_path: "notes/thing.md" }, 250, NOW))
      .toBe("(thing) body");
  });

  // The degrade-cleanly guarantee: this can never make an excerpt worse than it was.
  it("is byte-identical to the old age-only render when there is no source", () => {
    const out = excerptWithProvenance({ chunk_text: "plain", created_at: "2026-06-26 12:00:00" }, 250, NOW);
    expect(out).toMatch(/^\([^,)]+\) plain$/);
    expect(out).not.toContain(",");
  });

  it("returns the bare body when the chunk carries no provenance at all", () => {
    expect(excerptWithProvenance({ chunk_text: "nothing known" }, 250, NOW)).toBe("nothing known");
  });
});
