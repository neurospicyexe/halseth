// POST /admin/retract (2026-09-26): one gesture retracts one mistake from every Halseth store it
// reached, reversibly, with a logged release.
//
// WHY: on 2026-09-26 Drevan fabricated a blood-sugar number (187 for 208). Within a minute the
// memory-judge had written a companion_journal row memorialising it, the speech ingest had journaled
// the reply itself, and (via promotion) a wm continuity note existed too. His own recall then
// returned the fabrication ranked first. Cleaning it up took three hand-written SQL statements and a
// read of the code to find the ids. That is not a tool; this is. It archives (never deletes), keyed
// by the same external ids the writers stamp (`discord:<msg>` for speech, `judge:<msg>` for the
// judge's notes), and writes a memory_releases row per archived item so "restore release <id>"
// undoes it within the 30-day window like any other chosen forgetting.

import { describe, it, expect } from "vitest";
import { adminRetract } from "../handlers/retract.js";

function req(body: unknown, auth = "Bearer admin-tok"): Request {
  return new Request("https://h.example/admin/retract", {
    method: "POST",
    headers: { Authorization: auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A fake D1 that answers SELECTs from canned rows and records every statement it is asked to run. */
function fakeDb(rows: { journal?: Array<{ id: string }>; notes?: Array<{ note_id: string }>; stmChanges?: number }) {
  const executed: Array<{ sql: string; binds: unknown[] }> = [];
  const stmt = (sql: string) => ({
    bind: (...binds: unknown[]) => ({
      all: async () => {
        if (sql.includes("FROM companion_journal")) return { results: rows.journal ?? [] };
        if (sql.includes("FROM wm_continuity_notes")) return { results: rows.notes ?? [] };
        return { results: [] };
      },
      run: async () => {
        executed.push({ sql, binds });
        return { meta: { changes: sql.includes("DELETE FROM stm_entries") ? (rows.stmChanges ?? 0) : 1 } };
      },
      __sql: sql, __binds: binds,
    }),
  });
  return {
    executed,
    prepare: stmt,
    batch: async (stmts: Array<{ __sql: string; __binds: unknown[] }>) => {
      for (const s of stmts) executed.push({ sql: s.__sql, binds: s.__binds });
      return stmts.map(s => ({ meta: { changes: s.__sql.includes("DELETE FROM stm_entries") ? (rows.stmChanges ?? 0) : 1 } }));
    },
  };
}

const env = (db: ReturnType<typeof fakeDb>) => ({ ADMIN_SECRET: "admin-tok", DB: db }) as never;

describe("POST /admin/retract", () => {
  it("rejects a missing bearer", async () => {
    const res = await adminRetract(req({ agent: "drevan", external_ids: ["discord:1"], reason: "x" }, "Bearer nope"), env(fakeDb({})));
    expect(res.status).toBe(401);
  });

  it("requires agent, a reason, and at least one key", async () => {
    const db = fakeDb({});
    for (const body of [
      { external_ids: ["discord:1"], reason: "r" },
      { agent: "drevan", external_ids: ["discord:1"] },
      { agent: "drevan", reason: "r" },
      { agent: "drevan", reason: "r", external_ids: [], correlation_ids: [] },
    ]) {
      const res = await adminRetract(req(body), env(db));
      expect(res.status).toBe(400);
    }
    expect(db.executed).toHaveLength(0);
  });

  it("archives journal rows by external_id and notes by correlation_id, one release row each", async () => {
    const db = fakeDb({ journal: [{ id: "j1" }, { id: "j2" }], notes: [{ note_id: "n1" }] });
    const res = await adminRetract(req({
      agent: "drevan",
      external_ids: ["discord:555", "judge:444"],
      correlation_ids: ["judge:444"],
      reason: "Raziel retracted it on Discord",
    }), env(db));
    expect(res.status).toBe(200);
    const out = await res.json() as { archived: { journal: string[]; notes: string[] }; release_ids: string[] };
    expect(out.archived.journal).toEqual(["j1", "j2"]);
    expect(out.archived.notes).toEqual(["n1"]);
    expect(out.release_ids).toHaveLength(3);

    const updates = db.executed.filter(e => e.sql.startsWith("UPDATE"));
    const releases = db.executed.filter(e => e.sql.includes("INSERT INTO memory_releases"));
    expect(updates.map(u => u.sql)).toEqual([
      expect.stringContaining("UPDATE companion_journal SET archived = 1"),
      expect.stringContaining("UPDATE companion_journal SET archived = 1"),
      expect.stringContaining("UPDATE wm_continuity_notes SET archived = 1"),
    ]);
    // Every archive is owner-scoped: the agent travels in the bind, never only in the WHERE text.
    for (const u of updates) expect(u.binds).toContain("drevan");
    expect(releases).toHaveLength(3);
    expect(releases.map(r => r.binds[2])).toEqual(["journal", "journal", "note"]);
    expect(releases.map(r => r.binds[3])).toEqual(["j1", "j2", "n1"]);
    for (const r of releases) expect(r.binds[4]).toBe("Raziel retracted it on Discord");
  });

  it("is honest when nothing matched: 200, empty lists, no writes", async () => {
    const db = fakeDb({});
    const res = await adminRetract(req({ agent: "drevan", external_ids: ["discord:nope"], reason: "r" }), env(db));
    expect(res.status).toBe(200);
    const out = await res.json() as { archived: { journal: string[]; notes: string[] }; release_ids: string[] };
    expect(out.archived).toEqual({ journal: [], notes: [] });
    expect(out.release_ids).toEqual([]);
    expect(db.executed).toHaveLength(0);
  });

  // Rotate-on-retract (2026-09-26): the retracted reply kept echoing from the bot's STM window
  // (stm_entries) until the daily transcript rotation. `stm` is additive: the key rule still holds,
  // and the delete is a HARD delete because stm_entries is a rolling transcript window, not memory.
  describe("stm window rows", () => {
    it("stm_deleted is 0 and no DELETE runs when `stm` is absent", async () => {
      const db = fakeDb({ journal: [{ id: "j1" }] });
      const res = await adminRetract(req({ agent: "drevan", external_ids: ["discord:1"], reason: "r" }), env(db));
      const out = await res.json() as { stm_deleted: number };
      expect(out.stm_deleted).toBe(0);
      expect(db.executed.some(e => e.sql.includes("DELETE FROM stm_entries"))).toBe(false);
    });

    it("deletes the matching assistant rows in the same batch as the archives, owner + channel scoped", async () => {
      const db = fakeDb({ journal: [{ id: "j1" }], stmChanges: 2 });
      const res = await adminRetract(req({
        agent: "drevan", external_ids: ["discord:1"], reason: "r",
        stm: { channel_id: "chan9", content: "the number was 187" },
      }), env(db));
      expect(res.status).toBe(200);
      const out = await res.json() as { stm_deleted: number; archived: { journal: string[] } };
      expect(out.archived.journal).toEqual(["j1"]);
      expect(out.stm_deleted).toBe(2);
      const del = db.executed.filter(e => e.sql.includes("DELETE FROM stm_entries"));
      expect(del).toHaveLength(1);
      expect(del[0]!.sql).toContain("role = 'assistant'");
      expect(del[0]!.sql).toContain("instr(content, ?) > 0");
      expect(del[0]!.binds).toEqual(["drevan", "chan9", "the number was 187"]);
    });

    it("still drops the window rows when nothing matched in journal or notes", async () => {
      const db = fakeDb({ stmChanges: 1 });
      const res = await adminRetract(req({
        agent: "drevan", external_ids: ["discord:nope"], reason: "r",
        stm: { channel_id: "chan9", content: "the number was 187" },
      }), env(db));
      expect(res.status).toBe(200);
      const out = await res.json() as { stm_deleted: number; archived: { journal: string[]; notes: string[] }; release_ids: string[] };
      expect(out.archived).toEqual({ journal: [], notes: [] });
      expect(out.release_ids).toEqual([]);
      expect(out.stm_deleted).toBe(1);
      expect(db.executed).toHaveLength(1);
      expect(db.executed[0]!.sql).toContain("DELETE FROM stm_entries");
    });

    it("truncates the needle to 2000 chars and ignores a malformed `stm`", async () => {
      const db = fakeDb({ stmChanges: 1 });
      const long = "x".repeat(2500);
      const res = await adminRetract(req({
        agent: "drevan", external_ids: ["discord:1"], reason: "r",
        stm: { channel_id: "chan9", content: long },
      }), env(db));
      const out = await res.json() as { stm_deleted: number };
      expect(out.stm_deleted).toBe(1);
      expect((db.executed[0]!.binds[2] as string).length).toBe(2000);

      const db2 = fakeDb({ stmChanges: 1 });
      const res2 = await adminRetract(req({
        agent: "drevan", external_ids: ["discord:1"], reason: "r",
        stm: { channel_id: "chan9" },
      }), env(db2));
      const out2 = await res2.json() as { stm_deleted: number };
      expect(out2.stm_deleted).toBe(0);
      expect(db2.executed).toHaveLength(0);
    });
  });

  it("caps the key lists so a runaway caller cannot archive by the thousand", async () => {
    const db = fakeDb({});
    const res = await adminRetract(req({ agent: "drevan", external_ids: Array.from({ length: 51 }, (_, i) => `discord:${i}`), reason: "r" }), env(db));
    expect(res.status).toBe(400);
  });
});
