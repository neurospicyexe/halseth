// The imp tray's birth rule (mig 0132, 2026-09-26): a companion's own spoken words -- and any
// clerk's note written in its voice -- land as `draft`; everything else is born `kept`.

import { describe, it, expect } from "vitest";
import {
  reviewStateFor, COMPANION_SPEECH_JOURNAL_SOURCES, DRAFT_NOTE_CONTENT_PREFIXES, isReviewState, KEPT_SQL,
} from "../webmind/review-state.js";

describe("reviewStateFor(journal)", () => {
  it("drafts every companion-speech source", () => {
    for (const s of ["discord_speech", "memory_judge", "autonomous", "vibecheck"]) {
      expect(COMPANION_SPEECH_JOURNAL_SOURCES.has(s)).toBe(true);
      expect(reviewStateFor("journal", { source: s })).toBe("draft");
    }
  });
  it("keeps human and unknown sources (a human-authored row was never a draft)", () => {
    for (const s of ["session", "claude_code", "conversation_capture", "legacy", "some_new_writer", null, undefined, ""]) {
      expect(reviewStateFor("journal", { source: s })).toBe("kept");
    }
  });
});

describe("reviewStateFor(note)", () => {
  it("drafts the judge's keyed promotion by correlation_id", () => {
    expect(reviewStateFor("note", { correlation_id: "judge:1234567890", content: "plain text" })).toBe("draft");
  });
  it("drafts every clerk content prefix", () => {
    for (const p of DRAFT_NOTE_CONTENT_PREFIXES) {
      expect(reviewStateFor("note", { content: `${p} something` })).toBe("draft");
    }
    expect(reviewStateFor("note", { content: "[discord:pulse] Recent exchange:\nraziel: hi" })).toBe("draft");
    expect(reviewStateFor("note", { content: "[metronome/heartbeat] I posted this" })).toBe("draft");
  });
  it("keeps human-block distillations, captures, soma arcs and plain notes", () => {
    expect(reviewStateFor("note", { content: "[discord:distillation] what Raziel said today", source: "discord" })).toBe("kept");
    expect(reviewStateFor("note", { content: "[SOMA shift] acuity: 0.7", source: "soma_update" })).toBe("kept");
    expect(reviewStateFor("note", { content: "a continuity note I wrote", source: "claude_code" })).toBe("kept");
    expect(reviewStateFor("note", {})).toBe("kept");
  });
  it("matches prefixes at the START only -- a note that quotes a prefix mid-text is not a clerk note", () => {
    expect(reviewStateFor("note", { content: "I saw a [discord:pulse] note earlier" })).toBe("kept");
  });
});

describe("helpers", () => {
  it("isReviewState accepts exactly the three states", () => {
    expect(isReviewState("draft")).toBe(true);
    expect(isReviewState("kept")).toBe(true);
    expect(isReviewState("dropped")).toBe(true);
    expect(isReviewState("archived")).toBe(false);
    expect(isReviewState(1)).toBe(false);
  });
  it("KEPT_SQL is the literal predicate reads use", () => {
    expect(KEPT_SQL).toBe("review_state = 'kept'");
  });
});
