// Tests for the 2026-06-13 build: club_discuss executor + scoped book_read.
//
// book_read's core promise is anti-hallucination: a 404 / failure / unparseable
// listing must reduce to "not loaded", never to "found nothing relevant" -- so a
// companion is told plainly the book isn't there instead of inventing it from a
// confident-but-wrong global search hit (the original Moss-note-at-0.95 demon).

import { describe, it, expect } from "vitest";
import {
  parseVaultEntries, bookFolders, matchBookFolder, extractBookTitle,
} from "../librarian/executors/memory.js";
import { execClubDiscuss } from "../librarian/executors/companion-growth.js";
import { matchFastPath } from "../librarian/router.js";
import type { Env } from "../types.js";

// ── book_read pure helpers ──────────────────────────────────────────────────

describe("parseVaultEntries", () => {
  it("parses a {entries:[...]} listing", () => {
    const raw = JSON.stringify({ entries: ["Books/The-Overstory/Chapter-01.md", "Books/The-Overstory/Chapter-02.md"] });
    expect(parseVaultEntries(raw)).toHaveLength(2);
  });

  it("treats a REST failure string as not-loaded (empty), NOT as a result", () => {
    expect(parseVaultEntries("Obsidian REST LIST Books/ failed: 404")).toEqual([]);
  });

  it("treats null / empty / unparseable as not-loaded", () => {
    expect(parseVaultEntries(null)).toEqual([]);
    expect(parseVaultEntries("")).toEqual([]);
    expect(parseVaultEntries("Empty.")).toEqual([]);
    expect(parseVaultEntries("{not json")).toEqual([]);
  });

  it("accepts a bare JSON array too", () => {
    expect(parseVaultEntries('["Books/X/ch1.md"]')).toEqual(["Books/X/ch1.md"]);
  });
});

describe("bookFolders", () => {
  it("reduces a path listing to top-level book folders", () => {
    const entries = [
      "Books/The-Overstory/Chapter-01.md",
      "Books/The-Overstory/Chapter-02.md",
      "Books/Piranesi/Part-1.md",
    ];
    expect(bookFolders(entries).sort()).toEqual(["Piranesi", "The-Overstory"]);
  });

  it("handles Books/-prefixed and bare folder names", () => {
    expect(bookFolders(["The-Overstory", "Books/Piranesi/p1.md"]).sort()).toEqual(["Piranesi", "The-Overstory"]);
  });
});

describe("matchBookFolder", () => {
  const folders = ["The-Overstory", "Piranesi", "Gödel-Escher-Bach"];

  it("matches a title to its folder ignoring case/punctuation/spaces", () => {
    expect(matchBookFolder("The Overstory", folders)).toBe("The-Overstory");
    expect(matchBookFolder("the overstory", folders)).toBe("The-Overstory");
  });

  it("matches on substring either direction", () => {
    expect(matchBookFolder("Overstory", folders)).toBe("The-Overstory");
    expect(matchBookFolder("Godel Escher Bach extra", folders)).toBeNull(); // norm differs (umlaut)
  });

  it("returns null for a book not present", () => {
    expect(matchBookFolder("The Overstory", [])).toBeNull();
    expect(matchBookFolder("Dune", folders)).toBeNull();
  });
});

describe("extractBookTitle", () => {
  it("pulls a title after 'from'", () => {
    expect(extractBookTitle("read from The Overstory")).toBe("The Overstory");
  });
  it("returns null for bare 'the book' (so the club fallback fires)", () => {
    expect(extractBookTitle("read the club book")).toBeNull();
    expect(extractBookTitle("read the book")).toBeNull();
  });
});

// ── execClubDiscuss executor (fake D1) ──────────────────────────────────────

interface Row { [k: string]: unknown }
class FakeStmt {
  constructor(private sql: string, private store: { rounds: Row[]; discussions: Row[] }, private bound: unknown[] = []) {}
  bind(...args: unknown[]) { return new FakeStmt(this.sql, this.store, args); }
  async run() {
    if (this.sql.startsWith("INSERT INTO club_discussions")) {
      const [id, round_id, companion_id, reflection] = this.bound;
      this.store.discussions.push({ id, round_id, companion_id, reflection });
    }
    return { meta: { changes: 1 } };
  }
  async first<T>() {
    if (this.sql.includes("FROM club_rounds")) {
      // active|closed most-recent
      const r = this.store.rounds.find(r => r["status"] === "active" || r["status"] === "closed");
      return (r ?? null) as T | null;
    }
    return null as T | null;
  }
}
function clubEnv(rounds: Row[]): { env: Env; store: { rounds: Row[]; discussions: Row[] } } {
  const store = { rounds, discussions: [] as Row[] };
  return { env: { DB: { prepare: (sql: string) => new FakeStmt(sql, store) } } as unknown as Env, store };
}

describe("execClubDiscuss", () => {
  it("writes a discussion against the active round", async () => {
    const { env, store } = clubEnv([{ id: "r1", status: "active" }]);
    const res = await execClubDiscuss({ env, req: { companion_id: "cypher", request: "club discuss", context: JSON.stringify({ reflection: "The Overstory runs the same architecture as the vow thread." }) } } as never);
    expect((res as Record<string, unknown>).discussed).toBe(true);
    expect(store.discussions).toHaveLength(1);
    expect(store.discussions[0]!["companion_id"]).toBe("cypher");
  });

  it("requires a companion_id", async () => {
    const { env } = clubEnv([{ id: "r1", status: "active" }]);
    const res = await execClubDiscuss({ env, req: { request: "club discuss", context: JSON.stringify({ reflection: "x" }) } } as never);
    expect((res as Record<string, unknown>).error).toBe("club_discuss_failed");
  });

  it("requires a reflection", async () => {
    const { env } = clubEnv([{ id: "r1", status: "active" }]);
    const res = await execClubDiscuss({ env, req: { companion_id: "gaia", request: "club discuss" } } as never);
    expect((res as Record<string, unknown>).error).toBe("club_discuss_failed");
  });

  it("refuses when no round is active or closed", async () => {
    const { env } = clubEnv([{ id: "r1", status: "gathering" }]);
    const res = await execClubDiscuss({ env, req: { companion_id: "drevan", request: "club discuss", context: JSON.stringify({ reflection: "x" }) } } as never);
    expect((res as Record<string, unknown>).error).toBe("club_discuss_failed");
  });

  it("extracts the reflection from the bare request when no context JSON", async () => {
    const { env, store } = clubEnv([{ id: "r1", status: "closed" }]);
    const res = await execClubDiscuss({ env, req: { companion_id: "cypher", request: "club discuss: the silence in the round still sits with me" } } as never);
    expect((res as Record<string, unknown>).discussed).toBe(true);
    expect(String(store.discussions[0]!["reflection"])).toMatch(/silence/);
  });
});

// ── fast-path trigger routing ───────────────────────────────────────────────

describe("fast-path routing for new verbs", () => {
  it("routes 'club discuss' to club_discuss", () => {
    expect(matchFastPath("club discuss")!.key).toBe("club_discuss");
  });
  it("routes 'reflect on the round' to club_discuss", () => {
    expect(matchFastPath("reflect on the round's pick")!.key).toBe("club_discuss");
  });
  it("routes 'read the club book' to book_read", () => {
    expect(matchFastPath("read the club book")!.key).toBe("book_read");
  });
  it("routes 'read from the book' to book_read", () => {
    expect(matchFastPath("read from the book")!.key).toBe("book_read");
  });
  it("does not let book_read swallow plain note reads", () => {
    expect(matchFastPath("read note")!.key).toBe("sb_read");
  });
  it("keeps club_vote distinct from club_discuss", () => {
    expect(matchFastPath("club vote")!.key).toBe("club_vote");
  });
});
