// B64 Task 7: history backfill against the REAL schema. Memories kept, opinions fresh.
import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { inferBackfillVia, backfillAppraisals, postBackfillAppraisals } from "../pets/backfill.js";
import { runSleepPass } from "../pets/sleep.js";
import type { PetModel } from "../pets/model.js";

const NOW = Date.parse("2026-11-20T18:00:00Z");
const DAY = 86_400_000;

function setup() {
  const s = makeSqliteD1();
  const sol = s.db.prepare("SELECT id FROM creatures WHERE kind = 'companion_pet' AND name = 'Sol'").get() as { id: string };
  s.db.prepare("DELETE FROM creature_interactions").run();
  s.db.prepare("DELETE FROM creature_appraisals").run();
  s.db.prepare("UPDATE creatures SET created_at = '2026-06-20 00:00:00' WHERE id = ?").run(sol.id);
  return { ...s, solId: sol.id };
}
let n = 0;
function seed(db: any, cid: string, actor: string, action: string, at: string, note: string | null = null) {
  const id = `int${++n}`;
  db.prepare("INSERT INTO creature_interactions (id, creature_id, actor, action, note, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run(id, cid, actor, action, note, at);
  return id;
}
const appr = (db: any) => db.prepare("SELECT * FROM creature_appraisals ORDER BY created_at, rowid").all() as any[];
const env = (DB: unknown) => ({ DB, ADMIN_SECRET: "admin-tok", MCP_AUTH_SECRET: "mcp-tok" }) as never;

describe("inferBackfillVia", () => {
  it.each([
    [{ actor: "sol", action: "feed", note: null }, "appear"],
    [{ actor: "imp", action: "feed", note: null }, "imp"],
    [{ actor: "raziel", action: "feed", note: null }, "hand"],
    [{ actor: "cypher", action: "give", note: "a button" }, "hand"],
    [{ actor: "cypher", action: "give", note: null }, "backfill"],
    [{ actor: "drevan", action: "feed", note: "hi" }, "backfill"],
    [{ actor: "gaia", action: "play", note: null }, "backfill"],
  ])("%j -> %s", (row, via) => { expect(inferBackfillVia(row)).toBe(via); });
});

describe("backfillAppraisals", () => {
  it("writes one backfill appraisal per interaction, at the row's own time, unprocessed, with no text", async () => {
    const { db, DB, solId } = setup();
    const a = seed(db, solId, "raziel", "feed", "2026-06-20 12:00:00");
    const b = seed(db, solId, "cypher", "give", "2026-06-21T13:30:00.000Z", "SECRET NOTE TEXT");
    const c = seed(db, solId, "sol", "talk", "2026-06-22 09:00:00");
    const r = await backfillAppraisals(DB, solId, NOW);
    expect(r).toEqual({ inserted: 3, skipped: 0 });
    const rows = appr(db);
    expect(rows.map((x) => x.interaction_id)).toEqual([a, b, c]);
    expect(rows.every((x) => x.source === "backfill" && x.processed_at === null)).toBe(true);
    expect(rows.map((x) => x.created_at)).toEqual([
      "2026-06-20T12:00:00.000Z", "2026-06-21T13:30:00.000Z", "2026-06-22T09:00:00.000Z",
    ]);
    expect(rows.map((x) => x.via)).toEqual(["hand", "hand", "appear"]);
    expect(rows[2]).toMatchObject({ action: "appear", fit: null, valence: 0, arousal: 0.1 });
    expect(JSON.stringify(rows)).not.toContain("SECRET NOTE");
    // no friction, no quirk tags: opinions start fresh
    expect(rows.every((x) => x.friction === 0 && !x.tags.includes("quirk:"))).toBe(true);
  });

  it("recomputes fit from the drives at that moment (a first feed of a hungry crow is not a feed of a full one)", async () => {
    const { db, DB, solId } = setup();
    seed(db, solId, "cypher", "feed", "2026-06-25 12:00:00");
    seed(db, solId, "cypher", "feed", "2026-06-25 12:05:00");
    await backfillAppraisals(DB, solId, NOW);
    const [first, second] = appr(db);
    expect(first.fit).not.toBe(second.fit);
    expect(second.fit).toBe("full");
  });

  it("run twice: the second inserts 0 (idempotent on interaction_id), no duplicates", async () => {
    const { db, DB, solId } = setup();
    seed(db, solId, "raziel", "feed", "2026-06-20 12:00:00");
    seed(db, solId, "drevan", "play", "2026-06-20 15:00:00");
    expect(await backfillAppraisals(DB, solId, NOW)).toEqual({ inserted: 2, skipped: 0 });
    expect(await backfillAppraisals(DB, solId, NOW)).toEqual({ inserted: 0, skipped: 2 });
    expect(appr(db)).toHaveLength(2);
  });

  it("an interaction that already has a live appraisal is skipped, not doubled", async () => {
    const { db, DB, solId } = setup();
    const id = seed(db, solId, "cypher", "feed", "2026-11-19 12:00:00");
    db.prepare(
      "INSERT INTO creature_appraisals (id, creature_id, interaction_id, actor, action, via, fit, valence, arousal, friction, tags, weight, source, created_at) VALUES ('live1', ?, ?, 'cypher', 'feed', 'hand', 'met', 0.8, 0.6, 0, '[]', 1, 'live', '2026-11-19T12:00:00.000Z')",
    ).run(solId, id);
    expect(await backfillAppraisals(DB, solId, NOW)).toEqual({ inserted: 0, skipped: 1 });
    expect(appr(db)).toHaveLength(1);
  });

  it("writes no trust and no creature state (R7): only appraisals", async () => {
    const { db, DB, solId } = setup();
    seed(db, solId, "raziel", "feed", "2026-06-20 12:00:00");
    const before = db.prepare("SELECT * FROM creatures WHERE id = ?").get(solId);
    await backfillAppraisals(DB, solId, NOW);
    expect(db.prepare("SELECT * FROM creatures WHERE id = ?").get(solId)).toEqual(before);
  });

  it("batches past 50 statements", async () => {
    const { db, DB, solId } = setup();
    for (let i = 0; i < 120; i++) seed(db, solId, "cypher", "talk", new Date(Date.parse("2026-07-01T00:00:00Z") + i * 3_600_000).toISOString());
    expect((await backfillAppraisals(DB, solId, NOW)).inserted).toBe(120);
    expect(appr(db)).toHaveLength(120);
  });
});

describe("crossing: backfill evidence into the sleep pass", () => {
  it("creates at entrenchment 1 origin 'backfill', never promotes, zero quirks", async () => {
    const { db, DB, solId } = setup();
    // many dawn feeds (weight 0.2 each: enough past the 3.0 sleep gate): plenty of "evidence" for a promotion if backfill could earn one
    for (let d = 0; d < 19; d++) {
      seed(db, solId, "cypher", "feed", new Date(Date.parse("2026-11-01T12:30:00Z") + d * DAY).toISOString());
    }
    await backfillAppraisals(DB, solId, NOW);
    const ids = appr(db).map((x) => x.id as string);
    const slug = "dawn_feed";
    let call = 0;
    const model: PetModel = {
      async complete() {
        call++;
        return JSON.stringify({ items: [
          call === 1
            ? { op: "CREATE", slug, category: "preference", target_actor: null, perspective: "first light means food", evidence: ids.slice(0, 6) }
            : { op: "REINFORCE", slug, delta: 5, evidence: ids.slice(6), quirk: {
              title: "Dawn Feeding", trigger: { action: "feed", time_band: "dawn" }, behavior: "waits on the rail",
              resolution: { kind: "visits", n: 2 } } },
        ] });
      },
    } as PetModel;
    const r1 = await runSleepPass(env(DB), solId, model, NOW);
    expect(r1).toMatchObject({ ran: true });
    const t1 = db.prepare("SELECT * FROM creature_traits WHERE slug = ?").get(slug) as any;
    expect(t1).toMatchObject({ entrenchment: 1, origin: "backfill", status: "candidate" });
    expect(t1.live_points).toBe(0);
    // reinforce on a later night with fresh backfill appraisals
    for (let d = 0; d < 6; d++) seed(db, solId, "cypher", "feed", new Date(Date.parse("2026-11-02T12:30:00Z") + d * 3_600_000 * 30).toISOString());
    await backfillAppraisals(DB, solId, NOW);
    await runSleepPass(env(DB), solId, model, NOW + DAY);
    const t2 = db.prepare("SELECT * FROM creature_traits WHERE slug = ?").get(slug) as any;
    expect(t2.entrenchment).toBeLessThanOrEqual(2.01);
    expect(t2.live_points).toBe(0);
    expect(t2.status).not.toBe("quirk");
    expect((db.prepare("SELECT COUNT(*) n FROM creature_quirks").get() as any).n).toBe(0);
  });
});

describe("POST /admin/creatures/:id/backfill-appraisals", () => {
  const req = (tok?: string) => new Request("http://x/admin/creatures/x/backfill-appraisals", {
    method: "POST", headers: tok ? { Authorization: `Bearer ${tok}` } : {},
  });
  it("401 without ADMIN_SECRET (MCP secret is not enough)", async () => {
    const { DB, solId } = setup();
    expect((await postBackfillAppraisals(req(), env(DB), { id: solId })).status).toBe(401);
    expect((await postBackfillAppraisals(req("mcp-tok"), env(DB), { id: solId })).status).toBe(401);
  });
  it("404 unknown creature; 400 for a non-pet", async () => {
    const { db, DB } = setup();
    expect((await postBackfillAppraisals(req("admin-tok"), env(DB), { id: "nope" })).status).toBe(404);
    const other = db.prepare("SELECT id FROM creatures WHERE kind != 'companion_pet' LIMIT 1").get() as { id: string } | undefined;
    if (other) expect((await postBackfillAppraisals(req("admin-tok"), env(DB), { id: other.id })).status).toBe(400);
  });
  it("200 { inserted, skipped } for Sol", async () => {
    const { db, DB, solId } = setup();
    seed(db, solId, "raziel", "feed", "2026-06-20 12:00:00");
    const res = await postBackfillAppraisals(req("admin-tok"), env(DB), { id: solId });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inserted: 1, skipped: 0 });
  });
});
