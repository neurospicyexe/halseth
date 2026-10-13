// GET /ingest/continuity-notes + /ingest/continuity-ineligible (2026-10-13) -- against the REAL schema.
//
// A companion's continuity notes followed it across substrates and stopped there: Drevan captured
// Abby's death in Claude.ai, his own Discord boot knew it, Cypher's search found nothing, and Raziel
// had to retell it. These two feeds let Second Brain mirror the searchable notes and purge the rest.
//
// Pinned here: only kept, live, allowlisted notes by a companion are served (never a draft, a drop, an
// archive, a claude_code_session stub or a non-companion writer); thread_key never leaves; paging by
// (cursor, note_id) loses no tie on a page edge; a note kept or restored after the mark is re-served;
// and the purge list is exactly the complement.

import { describe, it, expect } from "vitest";
import { makeSqliteD1, seedNote } from "./helpers/sqlite-d1.js";
import { getIngestContinuityNotes, getIngestContinuityIneligible, SEARCHABLE_NOTE_TYPES } from "../handlers/history.js";

const envFor = (DB: unknown): any => ({ DB, ADMIN_SECRET: "s" });
const notes = (env: any, qs: string, token = "s") =>
  getIngestContinuityNotes(new Request(`https://x/ingest/continuity-notes?${qs}`, { headers: { Authorization: `Bearer ${token}` } }), env);
const ineligible = (env: any, qs: string, token = "s") =>
  getIngestContinuityIneligible(new Request(`https://x/ingest/continuity-ineligible?${qs}`, { headers: { Authorization: `Bearer ${token}` } }), env);

function seedMix(db: any) {
  // The 10-13 shape: Drevan's kept capture from a Claude.ai thread, and the judge's draft of the same day.
  seedNote(db, { note_id: "a-capture", agent_id: "drevan", note_type: "conversation_capture", content: "Abby passed in the night.", created_at: "2026-10-13T13:29:02.461Z", thread_key: "secret-thread" });
  seedNote(db, { note_id: "b-draft", agent_id: "drevan", note_type: "discord_session", content: "[discord:observation] drive in", created_at: "2026-10-13T17:56:09.389Z", review_state: "draft" });
  seedNote(db, { note_id: "c-dropped", agent_id: "cypher", note_type: "discord_session", created_at: "2026-10-10T10:00:00.000Z", review_state: "dropped", reviewed_at: "2026-10-11 02:15:00" });
  seedNote(db, { note_id: "d-archived", agent_id: "gaia", note_type: "continuity", created_at: "2026-10-01T10:00:00.000Z", archived: 1 });
  seedNote(db, { note_id: "e-cc-stub", agent_id: "cypher", note_type: "claude_code_session", content: "Cypher: \nCypher: ", created_at: "2026-10-13T17:09:23.224Z" });
  seedNote(db, { note_id: "f-day", agent_id: "gaia", note_type: "day_distillation", created_at: "2026-09-26T06:00:20.301Z" });
  seedNote(db, { note_id: "g-system", agent_id: "system", note_type: "continuity", created_at: "2026-10-02T10:00:00.000Z" });
  seedNote(db, { note_id: "h-session", agent_id: "cypher", note_type: "discord_session", created_at: "2026-10-12T21:00:00.000Z" });
}

describe("GET /ingest/continuity-notes", () => {
  it("requires the ingest bearer and a parseable since", async () => {
    const { DB } = makeSqliteD1();
    expect((await notes(envFor(DB), "", "wrong")).status).toBe(401);
    expect((await notes(envFor(DB), "since=not-a-date")).status).toBe(400);
  });

  it("serves only kept, live, allowlisted notes by a companion, oldest cursor first", async () => {
    const { db, DB } = makeSqliteD1();
    seedMix(db);
    const body = await (await notes(envFor(DB), "")).json() as any;
    expect(body.items.map((r: any) => r.note_id)).toEqual(["f-day", "h-session", "a-capture"]);
    expect(body.next).toBeNull();
    const capture = body.items.find((r: any) => r.note_id === "a-capture");
    expect(capture).toMatchObject({ agent_id: "drevan", note_type: "conversation_capture", content: "Abby passed in the night.", cursor_at: "2026-10-13T13:29:02.461Z" });
    for (const r of body.items) {
      expect(r).not.toHaveProperty("thread_key");
      expect(SEARCHABLE_NOTE_TYPES).toContain(r.note_type);
    }
  });

  it("since is strictly after; after_id re-includes the rows that tie the bound past that id", async () => {
    const { db, DB } = makeSqliteD1();
    const at = "2026-10-13T12:00:00.000Z";
    for (const id of ["t1", "t2", "t3"]) seedNote(db, { note_id: id, agent_id: "drevan", note_type: "continuity", created_at: at });
    seedNote(db, { note_id: "later", agent_id: "drevan", note_type: "continuity", created_at: "2026-10-13T13:00:00.000Z" });
    const env = envFor(DB);
    const strict = await (await notes(env, `since=${at}`)).json() as any;
    expect(strict.items.map((r: any) => r.note_id)).toEqual(["later"]);
    const tie = await (await notes(env, `since=${at}&after_id=t1`)).json() as any;
    expect(tie.items.map((r: any) => r.note_id)).toEqual(["t2", "t3", "later"]);
  });

  it("pages across a tie on the page edge and visits every row exactly once", async () => {
    const { db, DB } = makeSqliteD1();
    const at = "2026-10-13T12:00:00.000Z";
    for (let i = 0; i < 5; i++) seedNote(db, { note_id: `n${i}`, agent_id: "cypher", note_type: "discord_session", created_at: at });
    seedNote(db, { note_id: "z-last", agent_id: "cypher", note_type: "discord_session", created_at: "2026-10-13T12:00:01.000Z" });
    const env = envFor(DB);
    const seen: string[] = [];
    let qs = "limit=2";
    for (let guard = 0; guard < 10; guard++) {
      const body = await (await notes(env, qs)).json() as any;
      seen.push(...body.items.map((r: any) => r.note_id));
      if (!body.next) break;
      qs = `limit=2&since=${encodeURIComponent(body.next.since)}&after_id=${encodeURIComponent(body.next.after_id)}`;
    }
    expect(seen).toEqual(["n0", "n1", "n2", "n3", "n4", "z-last"]);
  });

  it("a draft kept after the mark is served on its keep time", async () => {
    const { db, DB } = makeSqliteD1();
    seedNote(db, { note_id: "kept-late", agent_id: "drevan", note_type: "discord_session", created_at: "2026-10-01T10:00:00.000Z", review_state: "kept", reviewed_at: "2026-10-13 18:00:00" });
    const body = await (await notes(envFor(DB), "since=2026-10-13T00:00:00.000Z")).json() as any;
    expect(body.items).toHaveLength(1);
    expect(body.items[0]).toMatchObject({ note_id: "kept-late", cursor_at: "2026-10-13T18:00:00.000Z" });
  });

  it("a note restored after the mark is re-served even though its cursor is old", async () => {
    const { db, DB } = makeSqliteD1();
    seedNote(db, { note_id: "restored", agent_id: "gaia", note_type: "continuity", created_at: "2026-08-01T10:00:00.000Z" });
    db.prepare(
      "INSERT INTO memory_releases (id, companion_id, kind, ref_id, reason, released_at, restored_at) VALUES ('r1', 'gaia', 'note', 'restored', 'x', '2026-10-01 00:00:00', '2026-10-13 09:00:00')",
    ).run();
    const body = await (await notes(envFor(DB), "since=2026-10-12T00:00:00.000Z")).json() as any;
    expect(body.items.map((r: any) => r.note_id)).toEqual(["restored"]);
  });
});

describe("GET /ingest/continuity-ineligible", () => {
  it("requires the ingest bearer", async () => {
    const { DB } = makeSqliteD1();
    expect((await ineligible(envFor(DB), "", "wrong")).status).toBe(401);
  });

  it("FULL lists exactly the complement of the feed, ids and state only", async () => {
    const { db, DB } = makeSqliteD1();
    seedMix(db);
    const env = envFor(DB);
    const body = await (await ineligible(env, "")).json() as any;
    expect(body.mode).toBe("full");
    expect(body.items.map((r: any) => r.id)).toEqual(["b-draft", "c-dropped", "d-archived", "e-cc-stub", "g-system"]);
    for (const r of body.items) expect(r).not.toHaveProperty("content");
    const served = ((await (await notes(env, "")).json()) as any).items.map((r: any) => r.note_id);
    const listed = body.items.map((r: any) => r.id);
    expect(served.filter((id: string) => listed.includes(id))).toEqual([]);
    expect([...served, ...listed].sort()).toEqual(["a-capture", "b-draft", "c-dropped", "d-archived", "e-cc-stub", "f-day", "g-system", "h-session"]);
  });

  it("FULL pages by note_id with after_id", async () => {
    const { db, DB } = makeSqliteD1();
    for (let i = 0; i < 5; i++) seedNote(db, { note_id: `d${i}`, agent_id: "drevan", note_type: "discord_session", review_state: "draft" });
    const env = envFor(DB);
    const seen: string[] = [];
    let qs = "limit=2";
    for (let guard = 0; guard < 10; guard++) {
      const body = await (await ineligible(env, qs)).json() as any;
      seen.push(...body.items.map((r: any) => r.id));
      if (!body.next) break;
      qs = `limit=2&after_id=${encodeURIComponent(body.next.after_id)}`;
    }
    expect(seen).toEqual(["d0", "d1", "d2", "d3", "d4"]);
  });

  it("INCREMENTAL returns only rows whose cursor moved past the bound (a drop is stamped by its review)", async () => {
    const { db, DB } = makeSqliteD1();
    seedMix(db);
    const body = await (await ineligible(envFor(DB), "since=2026-10-11T00:00:00.000Z")).json() as any;
    expect(body.mode).toBe("incremental");
    expect(body.items.map((r: any) => r.id)).toEqual(["c-dropped", "e-cc-stub", "b-draft"]);
  });
});
