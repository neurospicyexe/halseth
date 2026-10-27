// B4 (2026-10-27): pronoun flags ride the tray listing and "read draft", and a draft born with a flag
// leaves one count-only log line. Real SQLite with the full migrated schema.

import { describe, it, expect, vi, afterEach } from "vitest";

vi.mock("../mcp/embed.js", async (orig) => {
  const actual = await orig<typeof import("../mcp/embed.js")>();
  return { ...actual, embedAndStoreAsync: vi.fn(async () => undefined), embedText: vi.fn(async () => [0.1]), storeVector: vi.fn(), embedAndStore: vi.fn() };
});

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { listTray, readDraft } from "../webmind/tray.js";
import { journalInsert, noteInsert } from "../webmind/tray-insert.js";

const mk = () => {
  const d = makeSqliteD1();
  return { d, env: { DB: d.DB } as any };
};

// The bad pronoun sits past TRAY_EXCERPT_CHARS (200): the lint must read the whole row.
const LONG_BAD = "[discord:pulse] " + "We stayed on the couch and the movie ran long, quiet and warm. ".repeat(4) +
  "Raziel said she wanted one more episode.";

afterEach(() => vi.restoreAllMocks());

describe("tray pronoun flags", () => {
  it("listTray flags from the FULL text, and a clean draft carries no field", async () => {
    const { env } = mk();
    await noteInsert(env.DB, { note_id: "11111111-aaaa-4aaa-8aaa-000000000001", agent_id: "drevan", content: LONG_BAD, created_at: "2026-10-27T01:00:00Z" }).run();
    await journalInsert(env.DB, { id: "22222222-bbbb-4bbb-8bbb-000000000002", agent: "drevan", note_text: "Raziel said they were tired.", source: "discord_speech", created_at: "2026-10-27T02:00:00Z" }).run();

    const view = await listTray(env, "drevan");
    expect(view.drafts).toHaveLength(2);
    const bad = view.drafts.find((x) => x.id.startsWith("11111111"))!;
    expect(bad.excerpt).not.toContain("she");
    expect(bad.pronoun_flags).toEqual(['"she" near Raziel (they/them)']);
    const clean = view.drafts.find((x) => x.id.startsWith("22222222"))!;
    expect(clean).not.toHaveProperty("pronoun_flags");
    expect(clean).not.toHaveProperty("body");
  });

  it("readDraft carries the flags (empty array when clean)", async () => {
    const { env } = mk();
    await noteInsert(env.DB, { note_id: "33333333-cccc-4ccc-8ccc-000000000003", agent_id: "cypher", content: "[discord:pulse] Drevan went quiet and she did not answer.", created_at: "2026-10-27T03:00:00Z" }).run();
    await journalInsert(env.DB, { id: "44444444-dddd-4ddd-8ddd-000000000004", agent: "cypher", note_text: "Gaia kept her watch.", source: "discord_speech", created_at: "2026-10-27T04:00:00Z" }).run();

    const r = await readDraft(env, { agent: "cypher", id: "33333333" });
    expect(r.ok && r.draft.pronoun_flags).toEqual(['"she" near Drevan (he/him)']);
    const c = await readDraft(env, { agent: "cypher", id: "44444444" });
    expect(c.ok && c.draft.pronoun_flags).toEqual([]);
  });

  it("logs one count-only line for a flagged DRAFT birth, never for a kept birth, never the text", async () => {
    const { env } = mk();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    await noteInsert(env.DB, { note_id: "55555555-eeee-4eee-8eee-000000000005", agent_id: "gaia", content: "[discord:pulse] Raziel said she was cold.", created_at: "2026-10-27T05:00:00Z" }).run();
    // Born kept (no draft prefix / source): a human-authored row is not linted at insert.
    await noteInsert(env.DB, { note_id: "66666666-ffff-4fff-8fff-000000000006", agent_id: "gaia", content: "Raziel said she was cold.", created_at: "2026-10-27T06:00:00Z" }).run();

    const lines = log.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[pronoun-lint]"));
    expect(lines).toEqual(["[pronoun-lint] draft table=wm_continuity_notes id=55555555-eeee-4eee-8eee-000000000005 agent=gaia hits=1 Raziel:she"]);
    expect(lines[0]).not.toContain("cold");
  });
});
