// GET /notes?note_type= (Hearth P5 Archive): exact match, or `prefix*` trailing-star prefix match.
// The value is always bound, never spliced into SQL.

import { describe, it, expect } from "vitest";
import { getNotes, noteTypeClause } from "../handlers/notes.js";

function makeEnv() {
  const calls: Array<{ sql: string; args: unknown[] }> = [];
  const env = {
    ADMIN_SECRET: "t",
    DB: {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          all: async () => {
            calls.push({ sql, args });
            return { results: [{ id: "n1", author: "cypher", content: "x", note_type: "letter:cypher", created_at: "2026-11-01" }] };
          },
        }),
      }),
    },
  };
  return { env: env as never, calls };
}

const get = (env: never, qs: string) =>
  getNotes(new Request(`https://h.test/notes${qs}`, { headers: { Authorization: "Bearer t" } }), env);

describe("GET /notes note_type filter", () => {
  it("exact type", async () => {
    const { env, calls } = makeEnv();
    const res = await get(env, "?note_type=message");
    expect(res.status).toBe(200);
    expect(calls[0]!.sql).toContain("note_type = ?");
    expect(calls[0]!.args).toEqual(["message", 20]);
  });

  it("prefix form", async () => {
    const { env, calls } = makeEnv();
    await get(env, "?note_type=" + encodeURIComponent("letter:*"));
    expect(calls[0]!.sql).toContain("note_type LIKE ? ESCAPE");
    expect(calls[0]!.args).toEqual(["letter:%", 20]);
  });

  it("escapes wildcards in the literal prefix", async () => {
    const { env, calls } = makeEnv();
    await get(env, "?note_type=" + encodeURIComponent("a%_b\\*"));
    expect(calls[0]!.args[0]).toBe("a\\%\\_b\\\\%");
  });

  it("star mid-value is literal exact", async () => {
    const { env, calls } = makeEnv();
    await get(env, "?note_type=" + encodeURIComponent("a*b"));
    expect(calls[0]!.sql).toContain("note_type = ?");
    expect(calls[0]!.args).toEqual(["a*b", 20]);
  });

  it("keeps the 100 clamp", async () => {
    const { env, calls } = makeEnv();
    await get(env, "?limit=500&note_type=" + encodeURIComponent("letter:*"));
    expect(calls[0]!.args.at(-1)).toBe(100);
  });

  it("rejects empty and 65-char values", async () => {
    const { env, calls } = makeEnv();
    for (const v of ["", "   ", "a".repeat(65)]) {
      const res = await get(env, "?note_type=" + encodeURIComponent(v));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "note_type must be 1 to 64 characters" });
    }
    expect(calls).toHaveLength(0);
  });

  it("no filter is unchanged", async () => {
    const { env, calls } = makeEnv();
    await get(env, "");
    expect(calls[0]!.sql).not.toContain("WHERE");
    expect(calls[0]!.args).toEqual([20]);
  });
});

describe("noteTypeClause", () => {
  it("exact", () => {
    expect(noteTypeClause("message")).toEqual({ sql: "note_type = ?", bind: "message" });
  });
  it("prefix", () => {
    expect(noteTypeClause("letter:*")).toEqual({ sql: "note_type LIKE ? ESCAPE '\\'", bind: "letter:%" });
  });
  it("escapes", () => {
    expect(noteTypeClause("a%_b\\*")?.bind).toBe("a\\%\\_b\\\\%");
  });
  it("mid star literal", () => {
    expect(noteTypeClause("a*b")).toEqual({ sql: "note_type = ?", bind: "a*b" });
  });
  it("invalid", () => {
    expect(noteTypeClause("")).toBeNull();
    expect(noteTypeClause("  ")).toBeNull();
    expect(noteTypeClause("a".repeat(65))).toBeNull();
  });
});
