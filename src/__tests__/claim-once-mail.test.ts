// Claim-once inter-companion mail (T3, 2026-10-13). Real SQLite, real schema (every migration).
//
// Before: the consuming reads were SELECT (unreadNotesFor) then INSERT (ackNotesForCompanion). Two
// consumers for one companion landing inside that gap both saw the note unread and both delivered it.
// claimNotesFor makes the receipt insert carry the unread predicate and RETURN only what it wrote.
//
// Pinned here: a note is claimed once per recipient; concurrent claimers split the mail, never
// duplicate it; a broadcast is still claimable once by EACH sibling; the sender never claims its own;
// directed notes still stamp read_at; and a claimed note stays readable through the history read.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { claimNotesFor, unreadNotesFor } from "../db/inter_companion_note_reads.js";
import type { Env } from "../types.js";

function seed() {
  const h = makeSqliteD1();
  const env = { DB: h.DB } as unknown as Env;
  const add = (id: string, from: string, to: string | null, at: string) =>
    h.db.prepare(
      "INSERT INTO inter_companion_notes (id, from_id, to_id, content, created_at) VALUES (?, ?, ?, ?, ?)",
    ).run(id, from, to, `body ${id}`, at);
  return { h, env, add };
}

describe("claimNotesFor", () => {
  it("delivers a note once, oldest first, and never again to the same companion", async () => {
    const { env, add } = seed();
    add("n2", "drevan", "cypher", "2026-10-13T02:00:00Z");
    add("n1", "gaia", "cypher", "2026-10-13T01:00:00Z");
    const first = await claimNotesFor(env, "cypher", 10, "claude-ai:orient");
    expect(first.map((n) => n.id)).toEqual(["n1", "n2"]);
    expect(await claimNotesFor(env, "cypher", 10, "claude-code:x")).toEqual([]);
    expect(await unreadNotesFor(env, "cypher", 10)).toEqual([]);
  });

  it("two concurrent claimers never both receive the same note", async () => {
    const { env, add } = seed();
    for (let i = 0; i < 6; i++) add(`n${i}`, "drevan", "cypher", `2026-10-13T0${i}:00:00Z`);
    const [a, b] = await Promise.all([
      claimNotesFor(env, "cypher", 4, "claude-ai:orient"),
      claimNotesFor(env, "cypher", 4, "claude-code:boot"),
    ]);
    const ids = [...a, ...b].map((n) => n.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBe(6);
  });

  it("a broadcast is claimable once by EACH sibling and never by its sender", async () => {
    const { env, add } = seed();
    add("b1", "drevan", null, "2026-10-13T01:00:00Z");
    expect(await claimNotesFor(env, "drevan", 10, null)).toEqual([]);
    expect((await claimNotesFor(env, "cypher", 10, null)).map((n) => n.id)).toEqual(["b1"]);
    expect(await claimNotesFor(env, "cypher", 10, null)).toEqual([]);
    expect((await claimNotesFor(env, "gaia", 10, null)).map((n) => n.id)).toEqual(["b1"]);
  });

  it("respects the limit and leaves the rest unread", async () => {
    const { env, add } = seed();
    for (let i = 0; i < 3; i++) add(`n${i}`, "gaia", "drevan", `2026-10-13T0${i}:00:00Z`);
    expect((await claimNotesFor(env, "drevan", 2, null)).map((n) => n.id)).toEqual(["n0", "n1"]);
    expect((await unreadNotesFor(env, "drevan", 10)).map((n) => n.id)).toEqual(["n2"]);
  });

  it("stamps read_at on directed notes only, and records the claiming surface", async () => {
    const { h, env, add } = seed();
    add("d1", "gaia", "cypher", "2026-10-13T01:00:00Z");
    add("b1", "gaia", null, "2026-10-13T02:00:00Z");
    await claimNotesFor(env, "cypher", 10, "claude-ai:orient");
    const row = (id: string) =>
      h.db.prepare("SELECT read_at FROM inter_companion_notes WHERE id = ?").get(id) as { read_at: string | null };
    expect(row("d1").read_at).not.toBeNull();
    expect(row("b1").read_at).toBeNull();
    const rcpt = h.db.prepare("SELECT surface FROM inter_companion_note_reads WHERE note_id = 'b1' AND companion_id = 'cypher'").get() as { surface: string };
    expect(rcpt.surface).toBe("claude-ai:orient");
  });

  it("a claimed note stays readable by explicit request (history read is receipt-blind)", async () => {
    const { h, env, add } = seed();
    add("d1", "gaia", "cypher", "2026-10-13T01:00:00Z");
    await claimNotesFor(env, "cypher", 10, null);
    const hist = h.db.prepare(
      "SELECT id FROM inter_companion_notes WHERE to_id = ? OR from_id = ? OR to_id IS NULL ORDER BY created_at DESC LIMIT ?",
    ).all("cypher", "cypher", 10);
    expect(hist.map((r) => r.id)).toEqual(["d1"]);
  });

  it("is a no-op with nothing unread", async () => {
    const { env } = seed();
    expect(await claimNotesFor(env, "cypher", 10, null)).toEqual([]);
  });
});
