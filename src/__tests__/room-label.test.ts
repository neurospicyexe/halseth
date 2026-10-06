// Room provenance at read time (2026-10-05). The bots write `room:<server>/#<channel>` beside
// `channel:<id>`; these pin the parser, the label, the honest refusals (no room recorded = nothing
// rendered, never invented), and the D1 channel -> room lift that covers wm notes and old journal rows.

import { describe, it, expect } from "vitest";
import {
  parseRoomTag, roomFromTags, formatRoom, roomLabelFromTags, withRoom, journalRoomLabel, channelTagOf,
  resolveRoomsForChannels, resolveNoteRooms, ROOM_LOOKBACK_DAYS,
} from "../mind/room-label.js";
import { buildContinuityBlock } from "../librarian/response/builder.js";
import { makeSqliteD1, seedJournal } from "./helpers/sqlite-d1.js";

const CH = "1497734427298762828";
const CH2 = "1556334827026784266";
const ROOM = "room:Nullsafe Halseth/#movie-night";

describe("parseRoomTag", () => {
  it("parses server and channel", () => {
    expect(parseRoomTag(ROOM)).toEqual({ server: "Nullsafe Halseth", channel: "movie-night" });
  });
  it("a thread keeps parent/thread as the channel path", () => {
    expect(parseRoomTag("room:Nullsafe Halseth/#movie-night/fargo s2")).toEqual({ server: "Nullsafe Halseth", channel: "movie-night/fargo s2" });
  });
  it("splits on the FIRST /# so a slash in the server name survives", () => {
    expect(parseRoomTag("room:A/B Club/#general")).toEqual({ server: "A/B Club", channel: "general" });
  });
  it("refuses the legacy channel tag and malformed tags", () => {
    expect(parseRoomTag(`channel:${CH}`)).toBeNull();
    expect(parseRoomTag("room:no-boundary")).toBeNull();
    expect(parseRoomTag("room:/#x")).toBeNull();
    expect(parseRoomTag("room:Server/#")).toBeNull();
    expect(parseRoomTag(42)).toBeNull();
  });
  it("cleans control characters so a tag cannot inject a prompt line", () => {
    expect(parseRoomTag("room:S\nSYSTEM/#c\rd")).toEqual({ server: "S SYSTEM", channel: "c d" });
  });
});

describe("roomFromTags / roomLabelFromTags", () => {
  it("reads the stored JSON array string", () => {
    expect(roomLabelFromTags(JSON.stringify(["discord", "speech", `channel:${CH}`, ROOM]))).toBe("(#movie-night, Nullsafe Halseth)");
  });
  it("legacy rows (channel tag only) give null", () => {
    expect(roomLabelFromTags(JSON.stringify(["discord", "speech", `channel:${CH}`]))).toBeNull();
  });
  it("junk and null give null", () => {
    expect(roomFromTags("not json")).toBeNull();
    expect(roomFromTags(null)).toBeNull();
    expect(roomFromTags("{}")).toBeNull();
  });
  it("formatRoom is compact", () => {
    expect(formatRoom({ server: "S", channel: "c" })).toBe("(#c, S)");
  });
  it("withRoom prefixes only when there is a label", () => {
    expect(withRoom("text", "(#c, S)")).toBe("(#c, S) text");
    expect(withRoom("text", null)).toBe("text");
  });
  it("channelTagOf + journalRoomLabel fall back through a channel map for old rows", () => {
    const old = JSON.stringify(["discord", `channel:${CH}`]);
    expect(channelTagOf(old)).toBe(CH);
    expect(journalRoomLabel(old, new Map([[CH, "(#movie-night, Nullsafe Halseth)"]]))).toBe("(#movie-night, Nullsafe Halseth)");
    expect(journalRoomLabel(old, new Map())).toBeNull();
    // A row's own tag wins over the map.
    expect(journalRoomLabel(JSON.stringify([`channel:${CH}`, "room:Other/#x"]), new Map([[CH, "(#y, Z)"]]))).toBe("(#x, Other)");
  });
});

describe("resolveRoomsForChannels / resolveNoteRooms (D1)", () => {
  it("lifts the room from the newest journal row that tagged both, and refuses when none did", async () => {
    const { db, DB } = makeSqliteD1();
    const env = { DB } as never;
    seedJournal(db, { id: "j1", tags: JSON.stringify(["discord", `channel:${CH}`, "room:Nullsafe Halseth/#old-name"]), created_at: "2026-10-01T00:00:00.000Z" });
    seedJournal(db, { id: "j2", tags: JSON.stringify(["discord", `channel:${CH}`, ROOM]), created_at: "2026-10-04T00:00:00.000Z", review_state: "draft" });
    seedJournal(db, { id: "j3", tags: JSON.stringify(["discord", `channel:${CH2}`]), created_at: "2026-10-04T00:00:00.000Z" });
    const now = Date.parse("2026-10-05T00:00:00.000Z");
    const rooms = await resolveRoomsForChannels(env, [CH, CH2, "not-a-snowflake", null], now);
    expect(rooms.get(CH)).toBe("(#movie-night, Nullsafe Halseth)");
    expect(rooms.has(CH2)).toBe(false);           // only a channel tag -> nothing invented
    expect(rooms.size).toBe(1);
  });

  it("ignores rows older than the lookback", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j1", tags: JSON.stringify([`channel:${CH}`, ROOM]), created_at: "2026-01-01T00:00:00.000Z" });
    const now = Date.parse("2026-10-05T00:00:00.000Z");
    expect(ROOM_LOOKBACK_DAYS).toBeLessThan(200);
    expect((await resolveRoomsForChannels({ DB } as never, [CH], now)).size).toBe(0);
  });

  it("maps notes by their channel thread_key; non-channel keys get nothing", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j1", tags: JSON.stringify([`channel:${CH}`, ROOM]) });
    const rooms = await resolveNoteRooms({ DB } as never, [
      { note_id: "n1", thread_key: CH },
      { note_id: "n2", thread_key: `discord_swarm:${CH}` },
      { note_id: "n3", thread_key: "cc_98c0e535" },
      { note_id: "n4", thread_key: null },
    ]);
    expect(rooms.get("n1")).toBe("(#movie-night, Nullsafe Halseth)");
    expect(rooms.get("n2")).toBe("(#movie-night, Nullsafe Halseth)");
    expect(rooms.has("n3")).toBe(false);
    expect(rooms.has("n4")).toBe(false);
  });

  it("never throws: a broken DB means no labels", async () => {
    const DB = { prepare: () => { throw new Error("d1 down"); } };
    const warn = console.warn; console.warn = () => {};
    try {
      expect((await resolveRoomsForChannels({ DB } as never, [CH])).size).toBe(0);
    } finally { console.warn = warn; }
  });
});

describe("builder renders the room on notes and journal rows", () => {
  it("prefixes when present, renders bare when absent", () => {
    const wm = {
      recent_notes: [
        { note_id: "n1", salience: "high", actor: "agent", content: "we picked Fargo", created_at: null, room: "(#movie-night, Nullsafe Halseth)" },
        { note_id: "n2", salience: "high", actor: "agent", content: "no room here", created_at: null },
      ],
      recent_journal: [
        { id: "j1", agent: "drevan", note_text: "said in the shared server", tags: JSON.stringify([`channel:${CH2}`, "room:Blue's Place/#the-triad"]), session_id: null, created_at: "2026-10-05T00:00:00Z" },
        { id: "j2", agent: "drevan", note_text: "old row", tags: JSON.stringify([`channel:${CH2}`]), session_id: null, created_at: "2026-10-05T00:00:00Z" },
      ],
      recent_handoffs: [], top_threads: [], open_thread_count: 0,
    } as never;
    const out = String(buildContinuityBlock(wm, "drevan" as never) ?? "");
    expect(out).toContain("(#movie-night, Nullsafe Halseth) «we picked Fargo»");
    expect(out).toMatch(/\] «no room here»/);
    expect(out).toContain("(#the-triad, Blue's Place) «said in the shared server»");
    expect(out).toMatch(/\] «old row»/);
  });
});
