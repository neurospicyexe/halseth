// GET /ingest/recall-ineligible (2026-09-26, recall reconcile) -- against the REAL schema.
//
// Second Brain mirrors journal rows as rag/companion_journal/<id>. The journal feed is kept-only, so a
// mirror of a row that became a draft (0132's backfill), was dropped, retracted, released or
// salience-pruned can never correct itself: nothing re-serves it. This endpoint is the list SB's
// reconcile pages to delete those mirrors. Measured before it shipped: 2038 of 5392 mirrors poisoned.
//
// Pinned here: exactly the non-memory rows come back (never a kept live row), both keyset modes page
// without dropping ties on a boundary, auth is the ingest bearer, and -- the other half of the loop --
// a row kept (or restored) after the reconcile deleted its mirror IS re-served by the puller's feed.

import { describe, it, expect } from "vitest";
import { makeSqliteD1, seedJournal } from "./helpers/sqlite-d1.js";
import { getRecallIneligible, getCompanionJournal } from "../handlers/history.js";

const envFor = (DB: unknown): any => ({ DB, ADMIN_SECRET: "s" });
const get = (env: any, qs: string, token = "s") =>
  getRecallIneligible(new Request(`https://x/ingest/recall-ineligible?${qs}`, { headers: { Authorization: `Bearer ${token}` } }), env);
const feed = (env: any, qs: string) =>
  getCompanionJournal(new Request(`https://x/companion-journal?${qs}`, { headers: { Authorization: "Bearer s" } }), env);

function seedMix(db: any) {
  seedJournal(db, { id: "a-kept-live", agent: "cypher", created_at: "2026-09-20T10:00:00.000Z" });
  seedJournal(db, { id: "b-draft", agent: "drevan", source: "memory_judge", created_at: "2026-09-21T10:00:00.000Z", review_state: "draft" });
  seedJournal(db, { id: "c-dropped", agent: "drevan", source: "memory_judge", created_at: "2026-09-19T10:00:00.000Z", review_state: "dropped", reviewed_at: "2026-09-26 09:00:00" });
  seedJournal(db, { id: "d-kept-archived", agent: "gaia", created_at: "2026-08-01T10:00:00.000Z", archived: 1 });
  seedJournal(db, { id: "e-draft-archived", agent: "cypher", source: "discord_speech", created_at: "2026-09-22T10:00:00.000Z", review_state: "draft", archived: 1 });
}

describe("GET /ingest/recall-ineligible", () => {
  it("requires the ingest bearer", async () => {
    const { DB } = makeSqliteD1();
    const res = await get(envFor(DB), "", "wrong");
    expect(res.status).toBe(401);
  });

  it("rejects an unparseable since", async () => {
    const { DB } = makeSqliteD1();
    expect((await get(envFor(DB), "since=not-a-date")).status).toBe(400);
  });

  it("FULL mode lists every non-memory row by id -- drafts, drops, and archives of any state -- and never a kept live row", async () => {
    const { db, DB } = makeSqliteD1();
    seedMix(db);
    const body = await (await get(envFor(DB), "")).json() as any;
    expect(body.mode).toBe("full");
    expect(body.items.map((r: any) => r.id)).toEqual(["b-draft", "c-dropped", "d-kept-archived", "e-draft-archived"]);
    expect(body.next).toBeNull();
    const dropped = body.items.find((r: any) => r.id === "c-dropped");
    expect(dropped).toMatchObject({ agent: "drevan", review_state: "dropped", archived: 0, cursor_at: "2026-09-26T09:00:00.000Z" });
    for (const r of body.items) expect(r).not.toHaveProperty("note_text"); // ids + state only
  });

  it("FULL mode pages with after_id and visits every row exactly once", async () => {
    const { db, DB } = makeSqliteD1();
    for (let i = 0; i < 7; i++) seedJournal(db, { id: `d${i}`, agent: "drevan", source: "memory_judge", review_state: "draft" });
    seedJournal(db, { id: "live", agent: "drevan" });
    const env = envFor(DB);
    const seen: string[] = [];
    let qs = "limit=3";
    for (let guard = 0; guard < 10; guard++) {
      const body = await (await get(env, qs)).json() as any;
      seen.push(...body.items.map((r: any) => r.id));
      if (!body.next) break;
      qs = `limit=3&after_id=${encodeURIComponent(body.next.after_id)}`;
    }
    expect(seen).toEqual(["d0", "d1", "d2", "d3", "d4", "d5", "d6"]);
  });

  it("INCREMENTAL mode returns only rows whose cursor moved past the bound, oldest first", async () => {
    const { db, DB } = makeSqliteD1();
    seedMix(db);
    const body = await (await get(envFor(DB), "since=2026-09-21T12:00:00.000Z")).json() as any;
    expect(body.mode).toBe("incremental");
    // e-draft-archived (born 09-22) and c-dropped (decided 09-26, space-form stamp normalised);
    // b-draft was born before the bound, d-kept-archived's cursor is its 08-01 birth.
    expect(body.items.map((r: any) => r.id)).toEqual(["e-draft-archived", "c-dropped"]);
  });

  it("INCREMENTAL paging never drops rows that tie on the cursor at a page boundary", async () => {
    const { db, DB } = makeSqliteD1();
    const at = "2026-09-26T08:00:00.000Z";
    for (const id of ["t1", "t2", "t3", "t4", "t5"]) {
      seedJournal(db, { id, agent: "gaia", source: "memory_judge", created_at: "2026-09-01T00:00:00.000Z", review_state: "dropped", reviewed_at: at });
    }
    const env = envFor(DB);
    const seen: string[] = [];
    let qs = "limit=2&since=2026-09-25T00:00:00.000Z";
    for (let guard = 0; guard < 10; guard++) {
      const body = await (await get(env, qs)).json() as any;
      seen.push(...body.items.map((r: any) => r.id));
      if (!body.next) break;
      qs = `limit=2&since=${encodeURIComponent(body.next.since)}&after_id=${encodeURIComponent(body.next.after_id)}`;
    }
    expect(seen).toEqual(["t1", "t2", "t3", "t4", "t5"]);
  });
});

describe("the loop closes: a row whose mirror the reconcile deleted is re-served when it becomes memory", () => {
  it("a draft kept after the puller's mark is served by the cursor=reviewed feed (and leaves the ineligible list)", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j1", agent: "drevan", source: "memory_judge", created_at: "2026-09-10T00:00:00.000Z", review_state: "draft" });
    const env = envFor(DB);
    const mark = "2026-09-25T00:00:00.000Z";
    expect(((await (await get(env, "")).json()) as any).items.map((r: any) => r.id)).toEqual(["j1"]);
    // The tray's keep stamps reviewed_at in datetime('now') space-form; the cursor normalises it.
    db.prepare("UPDATE companion_journal SET review_state = 'kept', reviewed_at = '2026-09-26 10:00:00' WHERE id = 'j1'").run();
    expect(((await (await get(env, "")).json()) as any).items).toEqual([]);
    const rows = await (await feed(env, `since=${mark}&cursor=reviewed`)).json() as any[];
    expect(rows.map(r => r.id)).toEqual(["j1"]);
    expect(rows[0].cursor_at).toBe("2026-09-26T10:00:00.000Z");
  });

  it("a released row RESTORED after the mark is re-served even though its cursor never moved", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j2", agent: "cypher", created_at: "2026-09-01T00:00:00.000Z", archived: 1 });
    db.prepare("INSERT INTO memory_releases (companion_id, kind, ref_id, reason, released_at) VALUES ('cypher', 'journal', 'j2', 'r', '2026-09-20 00:00:00')").run();
    const env = envFor(DB);
    const mark = "2026-09-25T00:00:00.000Z";
    expect(((await (await get(env, "")).json()) as any).items.map((r: any) => r.id)).toEqual(["j2"]);
    expect(await (await feed(env, `since=${mark}&cursor=reviewed`)).json()).toEqual([]);
    // forgetting.ts restore: archived = 0 on the row, restored_at = datetime('now') on the release.
    db.prepare("UPDATE companion_journal SET archived = 0 WHERE id = 'j2'").run();
    db.prepare("UPDATE memory_releases SET restored_at = '2026-09-26 11:00:00' WHERE ref_id = 'j2'").run();
    const rows = await (await feed(env, `since=${mark}&cursor=reviewed`)).json() as any[];
    expect(rows.map(r => r.id)).toEqual(["j2"]);
    // Its cursor is still the old birth: the puller's mark never moves backward on it.
    expect(rows[0].cursor_at).toBe("2026-09-01T00:00:00.000Z");
    // Once the mark is past the restore, it is not re-served again.
    expect(await (await feed(env, "since=2026-09-26T12:00:00.000Z&cursor=reviewed")).json()).toEqual([]);
  });

  it("an un-restored release does not re-serve the row", async () => {
    const { db, DB } = makeSqliteD1();
    seedJournal(db, { id: "j3", agent: "cypher", created_at: "2026-09-01T00:00:00.000Z" });
    db.prepare("INSERT INTO memory_releases (companion_id, kind, ref_id, reason, released_at) VALUES ('cypher', 'journal', 'j3', 'r', '2026-09-26 00:00:00')").run();
    expect(await (await feed(envFor(DB), "since=2026-09-25T00:00:00.000Z&cursor=reviewed")).json()).toEqual([]);
  });
});
