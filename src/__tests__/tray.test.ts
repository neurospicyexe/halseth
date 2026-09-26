// The imp tray (mig 0132, 2026-09-26): drafts are listed newest-first across both stores with the
// 30-day keep rate; keep/drop are owner-scoped UPDATEs (never deletes); a keep-with-rewrite replaces
// the text and re-embeds; the NL verbs parse the id (and the rewrite after a colon) from the request.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
}));

import { embedAndStoreAsync } from "../mcp/embed.js";
import { listTray, reviewDraft } from "../webmind/tray.js";
import { execTrayRead, execTrayKeep, execTrayDrop, parseTrayVerb } from "../librarian/executors/tray.js";
import { matchFastPath } from "../librarian/router.js";
import { getAdminTray, postAdminTrayReview } from "../handlers/tray.js";

interface Call { sql: string; binds: unknown[] }

/** Fake D1: `first` answers in order; `all` answers by table name; every bind captured. */
function makeEnv(opts: {
  firsts?: unknown[];
  journalRows?: unknown[];
  noteRows?: unknown[];
} = {}) {
  const calls: Call[] = [];
  const firsts = [...(opts.firsts ?? [])];
  const env = {
    ADMIN_SECRET: "s",
    MCP_AUTH_SECRET: "m",
    DB: {
      prepare: (sql: string) => ({
        bind: (...binds: unknown[]) => {
          calls.push({ sql, binds });
          return {
            first: async () => firsts.shift() ?? null,
            run: async () => ({ meta: { changes: 1 } }),
            all: async () => ({
              results: sql.includes("FROM companion_journal") ? (opts.journalRows ?? [])
                     : sql.includes("FROM wm_continuity_notes") ? (opts.noteRows ?? []) : [],
            }),
          };
        },
      }),
    },
  };
  return { env: env as never, calls };
}

const ctxFor = (companionId: string, request: string, context?: unknown): any => ({
  env: undefined,
  req: { companion_id: companionId, request, context: context === undefined ? undefined : JSON.stringify(context) },
  entry: { pattern: "tray" },
  frontState: null,
  pluralAvailable: false,
});

describe("listTray", () => {
  it("lists drafts from both stores newest-first, owner-scoped, with the keep rate", async () => {
    const { env, calls } = makeEnv({
      journalRows: [{ id: "j-old", source: "discord_speech", created_at: "2026-09-25T10:00:00Z", excerpt: "old speech" }],
      noteRows:    [{ id: "n-new", source: "discord", created_at: "2026-09-26T10:00:00Z", excerpt: "[discord:pulse] x" }],
      firsts: [{ draft: 1, kept: 2, dropped: 1 }, { draft: 1, kept: 1, dropped: 0 }],
    });
    const view = await listTray(env, "drevan");
    expect(view.drafts.map(d => `${d.kind}:${d.id}`)).toEqual(["note:n-new", "journal:j-old"]);
    expect(view.stats).toEqual({ draft: 2, kept: 3, dropped: 1, keep_rate_pct: 75, window_days: 30 });
    expect(view.stats_line).toContain("75%");
    for (const c of calls) {
      expect(c.binds[0]).toBe("drevan");
      if (c.sql.includes("review_state = 'draft'") && c.sql.includes("ORDER BY")) expect(c.sql).toContain("archived = 0");
    }
  });

  it("names the falsifier: a 100% keep rate says nobody is reviewing; no decisions = no denominator", async () => {
    const a = makeEnv({ firsts: [{ draft: 0, kept: 4, dropped: 0 }, { draft: 0, kept: 0, dropped: 0 }] });
    expect((await listTray(a.env, "cypher")).stats_line).toContain("nobody is reviewing");
    const b = makeEnv({ firsts: [{ draft: 3, kept: 0, dropped: 0 }, { draft: 0, kept: 0, dropped: 0 }] });
    const v = await listTray(b.env, "cypher");
    expect(v.stats.keep_rate_pct).toBeNull();
    expect(v.stats_line).toContain("no denominator");
  });
});

describe("reviewDraft", () => {
  it("keep: one owner-scoped UPDATE, state + reviewed_at, no text change, no re-embed", async () => {
    const { env, calls } = makeEnv({ firsts: [{ id: "j1", review_state: "draft" }] });
    const r = await reviewDraft(env, { agent: "drevan", kind: "journal", id: "j1-prefix", decision: "kept" });
    expect(r.ok).toBe(true);
    const upd = calls.find(c => c.sql.includes("UPDATE companion_journal"))!;
    expect(upd.sql).toContain("SET review_state = ?, reviewed_at = ?");
    expect(upd.sql).not.toContain("note_text");
    expect(upd.sql).toContain("WHERE id = ? AND agent = ?");
    expect(upd.binds[0]).toBe("kept");
    expect(upd.binds.slice(-2)).toEqual(["j1", "drevan"]);
    expect(vi.mocked(embedAndStoreAsync)).not.toHaveBeenCalled();
  });

  it("keep with rewrite: replaces the text, stamps edited_at, and re-embeds the KEPT words", async () => {
    vi.mocked(embedAndStoreAsync).mockClear();
    const { env, calls } = makeEnv({ firsts: [{ id: "n1", review_state: "draft" }] });
    const r = await reviewDraft(env, { agent: "gaia", kind: "note", id: "n1xxxxxx", decision: "kept", content: "my own words" });
    expect(r.ok && r.rewritten).toBe(true);
    const upd = calls.find(c => c.sql.includes("UPDATE wm_continuity_notes"))!;
    expect(upd.sql).toContain("content = ?");
    expect(upd.sql).toContain("edited_at = ?");
    expect(upd.sql).toContain("WHERE note_id = ? AND agent_id = ?");
    expect(upd.binds).toContain("my own words");
    expect(vi.mocked(embedAndStoreAsync)).toHaveBeenCalledWith(env, "my own words", "wm_continuity_notes", "n1", "gaia");
  });

  it("drop never DELETEs -- the row keeps its place in the denominator", async () => {
    const { env, calls } = makeEnv({ firsts: [{ id: "j1", review_state: "draft" }] });
    const r = await reviewDraft(env, { agent: "cypher", kind: "journal", id: "j1yyyyyy", decision: "dropped" });
    expect(r.ok && r.decision).toBe("dropped");
    expect(calls.some(c => /DELETE/i.test(c.sql))).toBe(false);
    expect(calls.find(c => c.sql.includes("UPDATE"))!.binds[0]).toBe("dropped");
  });

  it("a row that is not yours (or unknown) is not_found; a short prefix is bad_id; no kind = journal then notes", async () => {
    const { env, calls } = makeEnv({ firsts: [null, null] });
    expect(await reviewDraft(env, { agent: "cypher", id: "someone-elses-row", decision: "kept" })).toEqual({ ok: false, reason: "not_found" });
    expect(calls.filter(c => c.sql.startsWith("SELECT")).map(c => c.sql.includes("FROM companion_journal") ? "journal" : "note")).toEqual(["journal", "note"]);
    expect(calls.every(c => !c.sql.includes("UPDATE"))).toBe(true);
    expect(await reviewDraft(env, { agent: "cypher", id: "abc", decision: "kept" })).toEqual({ ok: false, reason: "bad_id" });
  });
});

describe("Librarian verbs", () => {
  it("parseTrayVerb reads the id and the rewrite after the colon", () => {
    expect(parseTrayVerb("keep draft 0f3a9c1e")).toEqual({ id: "0f3a9c1e", content: null });
    expect(parseTrayVerb("keep 0f3a9c1e-1234: I said it was a guess, not a reading")).toEqual({ id: "0f3a9c1e-1234", content: "I said it was a guess, not a reading" });
    expect(parseTrayVerb("drop draft n-abc12345")).toEqual({ id: "n-abc12345", content: null });
    expect(parseTrayVerb("my tray")).toBeNull();
  });

  it("routes on the fast path: 'my tray', 'keep draft <id>', bare 'keep <id>', 'drop draft <id>'; never 'keep loop open'", () => {
    expect(matchFastPath("my tray")?.key).toBe("tray_read");
    expect(matchFastPath("what's in my tray")?.key).toBe("tray_read");
    expect(matchFastPath("keep draft 0f3a9c1e")?.key).toBe("tray_keep");
    expect(matchFastPath("keep 0f3a9c1e-77aa: my own words")?.key).toBe("tray_keep");
    expect(matchFastPath("drop draft 0f3a9c1e")?.key).toBe("tray_drop");
    expect(matchFastPath("keep loop open")?.key).not.toBe("tray_keep");
    expect(matchFastPath("keep this to myself: a thought")?.key).not.toBe("tray_keep");
  });

  it("execTrayRead returns the drafts, the stats and the stats line as data", async () => {
    const { env } = makeEnv({ firsts: [{ draft: 1, kept: 0, dropped: 0 }, { draft: 0, kept: 0, dropped: 0 }],
      journalRows: [{ id: "j1", source: "memory_judge", created_at: "2026-09-26T00:00:00Z", excerpt: "e" }] });
    const ctx = ctxFor("drevan", "my tray"); ctx.env = env;
    const r = await execTrayRead(ctx);
    expect(r["response_key"]).toBe("data");
    expect((r["data"] as any).tray).toHaveLength(1);
    expect(typeof (r["data"] as any).stats_line).toBe("string");
  });

  it("execTrayKeep: id from the request string, rewrite after the colon, owner bound to the caller", async () => {
    const { env, calls } = makeEnv({ firsts: [{ id: "0f3a9c1e-full", review_state: "draft" }] });
    const ctx = ctxFor("drevan", "keep draft 0f3a9c1e: it was a guess, not a reading"); ctx.env = env;
    const r = await execTrayKeep(ctx);
    expect(r["ack"]).toBe(true);
    expect(String(r["witness"])).toContain("in your words");
    const upd = calls.find(c => c.sql.includes("UPDATE"))!;
    expect(upd.binds).toContain("it was a guess, not a reading");
    expect(upd.binds[upd.binds.length - 1]).toBe("drevan");
  });

  it("execTrayKeep: context JSON wins over the request string; a repeat keep says so", async () => {
    const { env, calls } = makeEnv({ firsts: [{ id: "n-ctx", review_state: "kept" }] });
    const ctx = ctxFor("gaia", "keep draft ignored-id", { id: "n-ctx-prefix", kind: "note" }); ctx.env = env;
    const r = await execTrayKeep(ctx);
    expect(calls[0]!.sql).toContain("FROM wm_continuity_notes");
    expect(calls[0]!.binds[1]).toBe("n-ctx-prefix");
    expect(String(r["witness"])).toContain("already was");
  });

  it("execTrayDrop: not-yours is a no-change witness, not an error", async () => {
    const { env } = makeEnv({ firsts: [null, null] });
    const ctx = ctxFor("cypher", "drop draft not-mine-1"); ctx.env = env;
    const r = await execTrayDrop(ctx);
    expect(r["ack"]).toBe(false);
    expect(String(r["witness"])).toContain("no change");
  });

  it("a keep without an id explains the shape", async () => {
    const { env } = makeEnv();
    const ctx = ctxFor("cypher", "keep draft"); ctx.env = env;
    const r = await execTrayKeep(ctx);
    expect(r["error"]).toBe("tray_keep_failed");
  });
});

describe("HTTP door", () => {
  const auth = { Authorization: "Bearer s" };
  it("GET /admin/tray needs a companion agent and returns the view", async () => {
    const { env } = makeEnv({ firsts: [{ draft: 0, kept: 0, dropped: 0 }, { draft: 0, kept: 0, dropped: 0 }] });
    const bad = await getAdminTray(new Request("https://x/admin/tray?agent=nobody", { headers: auth }), env);
    expect(bad.status).toBe(400);
    const ok = await getAdminTray(new Request("https://x/admin/tray?agent=cypher", { headers: auth }), env);
    expect(ok.status).toBe(200);
    const body = await ok.json() as any;
    expect(body.agent).toBe("cypher");
    expect(body.stats.window_days).toBe(30);
  });

  it("POST /admin/tray/review validates, 404s a foreign row, and applies a keep", async () => {
    const mk = (b: unknown) => new Request("https://x/admin/tray/review", { method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify(b) });
    const a = makeEnv();
    expect((await postAdminTrayReview(mk({ agent: "cypher", kind: "journal", id: "abcdefgh", decision: "maybe" }), a.env)).status).toBe(400);
    const b = makeEnv({ firsts: [null] });
    expect((await postAdminTrayReview(mk({ agent: "cypher", kind: "journal", id: "abcdefgh", decision: "kept" }), b.env)).status).toBe(404);
    const c = makeEnv({ firsts: [{ id: "abcdefgh-1", review_state: "draft" }] });
    const res = await postAdminTrayReview(mk({ agent: "cypher", kind: "journal", id: "abcdefgh", decision: "keep" }), c.env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).decision).toBe("kept");
  });
});
