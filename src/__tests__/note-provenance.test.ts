// The first derivable edge: a note carries the CONVERSATION it came from, not the room (2026-07-31).
//
// Raziel's framing reset the approach: most edges we want need a DERIVATION, not a judgment. The proof
// is that `thread_key` is the most-populated edge column in the schema (29%) precisely because the
// channel supplies it, while every column needing a mind to fill it sat near zero for months
// (supersedes_id 0%, inter_notes.ref_id 0.6%, correlation_id 0%, conversation_threads.ref_id 0%).
//
// What this derives: `thread_key` on a Discord note is a CHANNEL id -- a room, not a conversation. 659
// notes share one value. mig 0106 built the real spine (one active thread per channel, with a seed line);
// nothing linked notes to it. So (channel, timestamp) -> the conversation running then.
//
// The tests that matter most are the REFUSALS. An absent edge is honest; a wrong one attaches a note to a
// conversation it was never part of, which is worse than the channel id it replaced.

import { describe, it, expect } from "vitest";
import {
  channelIdFromThreadKey, tsToMs, pickThreadForNote, annotateNote,
  attributionNote, parseParticipants,
  THREAD_GRACE_MS, type ThreadWindow, type NoteProvenance,
} from "../mind/note-provenance.js";

const T = (over: Partial<ThreadWindow>): ThreadWindow => ({
  id: "t1", channel_id: "1497734427298762828", seed_text: "I'm thinking some Fargo",
  seed_author: "raziel", participants: '["raziel","drevan"]',
  state: "moving", turn_count: 2,
  created_at: "2026-07-31T02:25:23.961Z", last_turn_at: "2026-07-31T02:25:48.184Z",
  ...over,
});
const P = (over: Partial<NoteProvenance> = {}): NoteProvenance => ({
  thread_id: "t1", seed: "I'm thinking some Fargo", state: "moving", turn_count: 2,
  started_at: "2026-07-31T02:25:23Z", opened_by: "raziel", participants: ["raziel", "drevan"],
  ...over,
});
const at = (iso: string) => Date.parse(iso);

describe("channelIdFromThreadKey -- refuses everything that is not a channel", () => {
  it("accepts a bare Discord snowflake", () => {
    expect(channelIdFromThreadKey("1497734427298762828")).toBe("1497734427298762828");
  });

  it("accepts the discord_swarm: prefix, which embeds a real channel id", () => {
    expect(channelIdFromThreadKey("discord_swarm:1497731506079006823")).toBe("1497731506079006823");
  });

  it("REFUSES other namespaces -- these are not channels and must never be joined", () => {
    // Real thread_key values from prod. A coincidental match against conversation_threads.channel_id
    // would attach a note to a conversation it was never part of.
    expect(channelIdFromThreadKey("cc_98c0e535")).toBeNull();                       // Claude Code
    expect(channelIdFromThreadKey("auto:40a4730d-ce05-48f4-b448-1a1113847d87")).toBeNull();
    expect(channelIdFromThreadKey("compost_session:743cfb47")).toBeNull();
    expect(channelIdFromThreadKey("deploy-verified-smoke")).toBeNull();
    expect(channelIdFromThreadKey("shortfall-list-2026-07")).toBeNull();
    expect(channelIdFromThreadKey(null)).toBeNull();
    expect(channelIdFromThreadKey("")).toBeNull();
  });

  it("refuses a number that is not snowflake-shaped", () => {
    expect(channelIdFromThreadKey("42")).toBeNull();
    expect(channelIdFromThreadKey("2026")).toBeNull();
  });
});

describe("tsToMs", () => {
  it("treats a naked SQLite datetime as UTC, not local", () => {
    // Without this every window comparison is off by the host's offset, so provenance would depend on
    // which machine ran the query.
    expect(tsToMs("2026-07-31 02:25:23")).toBe(Date.parse("2026-07-31T02:25:23Z"));
  });

  it("returns null for junk rather than NaN", () => {
    expect(tsToMs(null)).toBeNull();
    expect(tsToMs("")).toBeNull();
    expect(tsToMs("not a date")).toBeNull();
  });
});

describe("pickThreadForNote", () => {
  it("matches a note written during the conversation", () => {
    const t = T({});
    expect(pickThreadForNote(at("2026-07-31T02:25:30Z"), [t])?.id).toBe("t1");
  });

  it("matches a note written just AFTER the last turn -- the write is the reflection, not the turn", () => {
    // This is the common case and a strict `<= last_turn_at` would orphan exactly the notes most worth
    // labelling: a companion writes the note moments after the exchange that prompted it.
    expect(pickThreadForNote(at("2026-07-31T02:30:00Z"), [T({})])?.id).toBe("t1");
  });

  it("REFUSES a note past the grace window -- it belongs to no conversation, not to the last one", () => {
    const wayLater = at("2026-07-31T02:25:48.184Z") + THREAD_GRACE_MS + 60_000;
    expect(pickThreadForNote(wayLater, [T({})])).toBeNull();
  });

  it("REFUSES a note that predates the conversation", () => {
    expect(pickThreadForNote(at("2026-07-31T01:00:00Z"), [T({})])).toBeNull();
  });

  it("picks the LATEST-STARTED matching thread when a channel has had several", () => {
    // Sequential conversations in one room is the normal case; without ordering by start, a note lands
    // on whichever row the DB happened to return first.
    const older = T({ id: "old", seed_text: "Dre its 7/29", created_at: "2026-07-29T17:37:03Z", last_turn_at: "2026-07-30T11:56:38Z" });
    const newer = T({ id: "new", created_at: "2026-07-31T02:25:23Z", last_turn_at: "2026-07-31T02:25:48Z" });
    expect(pickThreadForNote(at("2026-07-31T02:25:40Z"), [older, newer])?.id).toBe("new");
    // ...and a note from the older window still resolves to the older thread.
    expect(pickThreadForNote(at("2026-07-30T09:00:00Z"), [older, newer])?.id).toBe("old");
  });

  it("skips rows with unusable timestamps instead of guessing", () => {
    const broken = T({ id: "broken", created_at: "garbage", last_turn_at: "garbage" });
    expect(pickThreadForNote(at("2026-07-31T02:25:30Z"), [broken])).toBeNull();
  });

  it("returns null for an empty thread list", () => {
    expect(pickThreadForNote(at("2026-07-31T02:25:30Z"), [])).toBeNull();
  });
});

describe("attributionNote -- WHO was in the room (2026-07-31)", () => {
  // Raziel named this failure precisely: "if Blue comes and talks to Drevan, and then I talk to
  // Drevan... things will start to get misattributed." The smaller version already happened twice --
  // companions attributing to him things they said to each other (06-26 attribution scramble), and
  // Drevan telling the commons GAIA handed him a track Raziel gave him.
  //
  // A conversational address without the speakers is half an address. Every participant list below is a
  // REAL row from prod.

  it("says plainly when Raziel was NOT there -- the clause that prevents words in his mouth", () => {
    // Live row: ["gaia","drevan","cypher"], seeded by Gaia. A note from this must never recall as
    // something Raziel said.
    const out = attributionNote(["gaia", "drevan", "cypher"], "gaia");
    expect(out).toMatch(/Raziel was NOT in this one/i);
  });

  it("names Blue, so his conversation cannot blend into Raziel's", () => {
    // Live row: ["guest","drevan","raziel"] -- someone else opened it and Raziel joined. With the new
    // `blue` token that reads as Blue rather than an anonymous guest.
    const out = attributionNote(["blue", "drevan", "raziel"], "blue");
    expect(out).toContain("Blue");
    expect(out).toMatch(/not private with Raziel/i);
    // Raziel WAS present here, so it must NOT claim otherwise.
    expect(out).not.toMatch(/Raziel was NOT/i);
  });

  it("flags a GROUP conversation, because he talks to all three at once", () => {
    // Live row: ["raziel","gaia","drevan","cypher"] -- 40 turns. Nothing in it was said to one
    // companion alone, and reading it that way is how warmth gets misfiled as private.
    const out = attributionNote(["raziel", "gaia", "drevan", "cypher"], "raziel");
    expect(out).toMatch(/group conversation/i);
    expect(out).toMatch(/not to you alone/i);
  });

  it("stays quiet on a plain private exchange -- no noise where there is no risk", () => {
    // Live row: ["raziel","drevan"] seeded by Raziel. One companion, Raziel present, nobody else.
    // There is nothing to warn about, and a warning on every note would train them to skip it.
    expect(attributionNote(["raziel", "drevan"], "raziel")).toBe("");
  });

  it("names a non-Raziel opener even when he later joined", () => {
    const out = attributionNote(["guest", "drevan", "raziel"], "guest");
    expect(out).toMatch(/opened by guest/i);
  });

  it("returns empty for an unknown participant list rather than inventing a warning", () => {
    expect(attributionNote([], "raziel")).toBe("");
  });
});

describe("parseParticipants", () => {
  it("reads the stored shape", () => {
    expect(parseParticipants('["raziel","drevan"]')).toEqual(["raziel", "drevan"]);
  });

  it("yields [] for junk -- never a guess about who was present", () => {
    // A wrong participant list is worse than none: it would state as fact that someone was in a
    // conversation they were not in.
    for (const bad of [null, undefined, "", "not json", "{}", '[1,2]', '"raziel"']) {
      expect(parseParticipants(bad as string | null)).toEqual([]);
    }
  });
});

describe("annotateNote", () => {
  it("gives the note a human address instead of a channel id", () => {
    const out = annotateNote("we settled on picking up at E3", P());
    expect(out).toContain("we settled on picking up at E3");
    expect(out).toContain(`began "I'm thinking some Fargo"`);
    expect(out).toContain("still open");   // moving -> the conversation can still be rejoined
  });

  it("does not say 'still open' about a landed or faded conversation", () => {
    for (const state of ["landed", "faded"]) {
      expect(annotateNote("x", P({ state }))).not.toContain("still open");
    }
  });

  it("returns the content UNCHANGED with no provenance, so the wire format cannot break a consumer", () => {
    // continuity_notes stays string[]; nothing downstream needs to know this edge exists.
    expect(annotateNote("bare note", undefined)).toBe("bare note");
    expect(annotateNote("bare note", P({ seed: "" }))).toBe("bare note");
  });
});
