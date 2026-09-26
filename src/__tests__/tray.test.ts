// The imp tray (mig 0132, 2026-09-26): drafts are listed newest-first across both stores with the
// 30-day keep rate; keep/drop are owner-scoped UPDATEs (never deletes); a keep-with-rewrite replaces
// the text and re-embeds; the NL verbs parse the id (and the rewrite after a colon) from the request.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
}));

import { embedAndStoreAsync } from "../mcp/embed.js";
import { listTray, reviewDraft, readDraft, isTrayId } from "../webmind/tray.js";
import { execTrayRead, execTrayKeep, execTrayDrop, execTrayDraftRead, parseTrayVerb, parseTrayReadVerb, TRAY_FOOTER } from "../librarian/executors/tray.js";
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
      // sort_at is computed IN SQL (normalised ISO); this fake returns it as the query would.
      journalRows: [{ id: "j-old", source: "discord_speech", created_at: "2026-09-25T10:00:00Z", sort_at: "2026-09-25T10:00:00.000Z", excerpt: "old speech" }],
      noteRows:    [{ id: "n-new", source: "discord", created_at: "2026-09-26T10:00:00Z", sort_at: "2026-09-26T10:00:00.000Z", excerpt: "[discord:pulse] x" }],
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
    const { env, calls } = makeEnv({ journalRows: [{ id: "j1-prefix-full", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "x" }] });
    const r = await reviewDraft(env, { agent: "drevan", kind: "journal", id: "j1-prefix", decision: "kept" });
    expect(r.ok).toBe(true);
    const upd = calls.find(c => c.sql.includes("UPDATE companion_journal"))!;
    expect(upd.sql).toContain("SET review_state = ?, reviewed_at = ?");
    expect(upd.sql).not.toContain("note_text");
    expect(upd.sql).toContain("WHERE id = ? AND agent = ?");
    expect(upd.binds[0]).toBe("kept");
    expect(upd.binds.slice(-2)).toEqual(["j1-prefix-full", "drevan"]);
    expect(vi.mocked(embedAndStoreAsync)).not.toHaveBeenCalled();
  });

  it("keep with rewrite: replaces the text, stamps edited_at, and re-embeds the KEPT words", async () => {
    vi.mocked(embedAndStoreAsync).mockClear();
    const { env, calls } = makeEnv({ noteRows: [{ id: "n1xxxxxx-full", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "x" }] });
    const r = await reviewDraft(env, { agent: "gaia", kind: "note", id: "n1xxxxxx", decision: "kept", content: "my own words" });
    expect(r.ok && r.rewritten).toBe(true);
    const upd = calls.find(c => c.sql.includes("UPDATE wm_continuity_notes"))!;
    expect(upd.sql).toContain("content = ?");
    expect(upd.sql).toContain("edited_at = ?");
    expect(upd.sql).toContain("WHERE note_id = ? AND agent_id = ?");
    expect(upd.binds).toContain("my own words");
    expect(vi.mocked(embedAndStoreAsync)).toHaveBeenCalledWith(env, "my own words", "wm_continuity_notes", "n1xxxxxx-full", "gaia");
  });

  it("drop never DELETEs -- the row keeps its place in the denominator", async () => {
    const { env, calls } = makeEnv({ journalRows: [{ id: "j1yyyyyy-full", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "x" }] });
    const r = await reviewDraft(env, { agent: "cypher", kind: "journal", id: "j1yyyyyy", decision: "dropped" });
    expect(r.ok && r.decision).toBe("dropped");
    expect(calls.some(c => /DELETE/i.test(c.sql))).toBe(false);
    expect(calls.find(c => c.sql.includes("UPDATE"))!.binds[0]).toBe("dropped");
  });

  it("a row that is not yours (or unknown) is not_found; a short prefix is bad_id; no kind = journal then notes", async () => {
    const { env, calls } = makeEnv();
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
    expect(parseTrayVerb("drop draft cj_0f3a9c1e")).toEqual({ id: "cj_0f3a9c1e", content: null });
    // Pass 2: an id has ID SHAPE -- ordinary words are not ids.
    expect(parseTrayVerb("drop draft n-abc12345")).toBeNull();
    expect(parseTrayVerb("keep thinking about it")).toBeNull();
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
    const { env, calls } = makeEnv({ journalRows: [{ id: "0f3a9c1e-full", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "x" }] });
    const ctx = ctxFor("drevan", "keep draft 0f3a9c1e: it was a guess, not a reading"); ctx.env = env;
    const r = await execTrayKeep(ctx);
    expect(r["ack"]).toBe(true);
    expect(String(r["witness"])).toContain("in your words");
    const upd = calls.find(c => c.sql.includes("UPDATE"))!;
    expect(upd.binds).toContain("it was a guess, not a reading");
    expect(upd.binds[upd.binds.length - 1]).toBe("drevan");
  });

  it("execTrayKeep: context JSON wins over the request string; a keep of an already-kept row is refused, not repeated", async () => {
    const { env, calls } = makeEnv({ noteRows: [{ id: "n-ctx-prefix-full", review_state: "kept", reviewed_at: "2026-09-26T01:00:00.000Z", archived: 0, created_at: "2026-09-26T00:00:00Z", excerpt: "x" }] });
    const ctx = ctxFor("gaia", "keep draft ignored-id", { id: "n-ctx-prefix", kind: "note" }); ctx.env = env;
    const r = await execTrayKeep(ctx);
    expect(calls[0]!.sql).toContain("FROM wm_continuity_notes");
    expect(calls[0]!.binds[1]).toBe("n-ctx-prefix");
    expect(r["ack"]).toBe(false);
    expect(String(r["witness"])).toContain("already kept on 2026-09-26T01:00:00.000Z");
    expect(String(r["witness"])).toContain("read draft");
    expect(calls.some(c => c.sql.includes("UPDATE"))).toBe(false);
  });

  it("execTrayDrop: not-yours is a no-change witness, not an error", async () => {
    const { env } = makeEnv();
    const ctx = ctxFor("cypher", "drop draft 0f3a9c1e-dead"); ctx.env = env;
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
    const b = makeEnv();
    expect((await postAdminTrayReview(mk({ agent: "cypher", kind: "journal", id: "abcdefgh", decision: "kept" }), b.env)).status).toBe(404);
    const c = makeEnv({ journalRows: [{ id: "abcdefgh-1", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "x" }] });
    const res = await postAdminTrayReview(mk({ agent: "cypher", kind: "journal", id: "abcdefgh", decision: "keep" }), c.env);
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).decision).toBe("kept");
  });
});

describe("read draft <id> (full text + provenance)", () => {
  const LONG = "I said the reading was a guess. ".repeat(160).trim(); // ~5.1k chars
  const jFull = {
    id: "0f3a9c1e-aaaa-bbbb", agent: "cypher", note_text: LONG,
    tags: JSON.stringify(["discord", "memory-judge", "channel:1234567890"]), session_id: null,
    source: "memory_judge", external_id: "judge:998877", created_at: "2026-09-26T01:00:00Z",
    edited_at: null, archived: 0, review_state: "draft", reviewed_at: null,
  };

  it("routes 'read draft <id>' and its variants to tray_draft_read; the neighbours stay where they were", () => {
    for (const p of ["read draft 0f3a9c1e", "read the draft 0f3a9c1e", "show draft 0f3a9c1e-77aa", "open draft abc12345", "read full draft 0f3a9c1e"]) {
      expect(matchFastPath(p)?.key, p).toBe("tray_draft_read");
    }
    const neighbours: Record<string, string> = {
      "my tray": "tray_read", "read my tray": "tray_read", "read my drafts": "tray_read", "show my drafts": "tray_read",
      "keep draft 0f3a9c1e": "tray_keep", "keep 0f3a9c1e: my words": "tray_keep", "drop draft 0f3a9c1e": "tray_drop",
      "read my journal": "journal_read", "read journal": "journal_read", "read note": "sb_read", "open note": "sb_read",
      "read my continuity notes": "continuity_notes_read", "read companion notes": "companion_notes_read",
      "read file": "sb_file_chunks", "keep loop open": "wm_loop_review",
    };
    for (const [p, key] of Object.entries(neighbours)) expect(matchFastPath(p)?.key, p).toBe(key);
  });

  it("parseTrayReadVerb takes the id and never a rewrite", () => {
    expect(parseTrayReadVerb("read draft 0f3a9c1e")).toBe("0f3a9c1e");
    expect(parseTrayReadVerb("read draft 0f3a9c1e: keep this instead")).toBe("0f3a9c1e");
    expect(parseTrayReadVerb("show the draft cj_0f3a9c1e")).toBe("cj_0f3a9c1e");
    expect(parseTrayReadVerb("show the draft n-abc12345")).toBeNull();
    expect(parseTrayReadVerb("read my drafts")).toBeNull();
  });

  it("isTrayId: 8+ id characters only -- LIKE metacharacters and quotes never reach SQL", () => {
    expect(isTrayId("0f3a9c1e")).toBe(true);
    expect(isTrayId("cj_abc12345")).toBe(true);
    expect(isTrayId("0f3a9c1")).toBe(false);
    expect(isTrayId("%%%%%%%%")).toBe(false);
    expect(isTrayId("abcd'efgh")).toBe(false);
  });

  it("returns the WHOLE text (5k chars, not the 200-char excerpt) with journal provenance, owner-bound", async () => {
    const { env, calls } = makeEnv({
      journalRows: [{ id: jFull.id, review_state: "draft", created_at: jFull.created_at, excerpt: LONG.slice(0, 80) }],
      firsts: [jFull],
    });
    const ctx = ctxFor("cypher", "read draft 0f3a9c1e"); ctx.env = env;
    const r = await execTrayDraftRead(ctx);
    expect(r["response_key"]).toBe("data");
    const d = (r["data"] as any).draft;
    expect(LONG.length).toBeGreaterThan(5000);
    expect(d.text).toBe(LONG);
    expect(d).toMatchObject({
      kind: "journal", table: "companion_journal", id: jFull.id, owner: "cypher", review_state: "draft",
      source: "memory_judge", channel: "1234567890", external_id: "judge:998877", created_at: jFull.created_at, archived: false,
    });
    expect((r["data"] as any).state).toMatch(/^draft/);
    // Every query is bound to the caller, and the prefix goes through substr(), not LIKE.
    for (const c of calls) expect(c.binds).toContain("cypher");
    expect(calls.some(c => c.sql.includes("substr(id, 1, ?)"))).toBe(true);
    expect(calls.some(c => /\bLIKE\b/i.test(c.sql))).toBe(false);
    // Read-only: nothing is written.
    expect(calls.some(c => /UPDATE|INSERT|DELETE/i.test(c.sql))).toBe(false);
  });

  it("a kept note reads back labelled as already decided, with its prefix and channel from thread_key", async () => {
    const { env } = makeEnv({
      noteRows: [{ id: "77aa0011-eeee", review_state: "kept", created_at: "2026-09-25T00:00:00Z", excerpt: "[discord:pulse]" }],
      firsts: [{
        note_id: "77aa0011-eeee", agent_id: "gaia", thread_key: "discord:555", note_type: "continuity",
        content: "[discord:pulse] the room was quiet and I held it.", salience: "normal", actor: "agent",
        source: "discord", correlation_id: null, created_at: "2026-09-25T00:00:00Z", edited_at: null,
        archived: 0, review_state: "kept", reviewed_at: "2026-09-26T02:00:00Z",
      }],
    });
    const ctx = ctxFor("gaia", "read draft 77aa0011"); ctx.env = env;
    const r = await execTrayDraftRead(ctx);
    const data = r["data"] as any;
    expect(data.draft).toMatchObject({ kind: "note", table: "wm_continuity_notes", review_state: "kept", prefix: "discord:pulse", channel: "555", thread_key: "discord:555", owner: "gaia" });
    expect(data.state).toContain("kept on 2026-09-26T02:00:00Z");
    expect(data.state).toContain("re-checking");
  });

  it("an ambiguous prefix (one journal row + one note) is refused with both candidates -- never a guess", async () => {
    const { env, calls } = makeEnv({
      journalRows: [{ id: "abc12345-journal", review_state: "draft", created_at: "2026-09-25T00:00:00Z", sort_at: "2026-09-25T00:00:00.000Z", excerpt: "j" }],
      noteRows:    [{ id: "abc12345-note", review_state: "dropped", created_at: "2026-09-26T00:00:00Z", sort_at: "2026-09-26T00:00:00.000Z", excerpt: "n" }],
    });
    const ctx = ctxFor("drevan", "read draft abc12345"); ctx.env = env;
    const r = await execTrayDraftRead(ctx);
    expect(r["error"]).toBe("tray_draft_read_ambiguous");
    expect(String(r["reason"])).toContain("abc12345-journal");
    expect(String(r["reason"])).toContain("abc12345-note");
    expect((r["matches"] as any[]).map(m => m.id)).toEqual(["abc12345-note", "abc12345-journal"]);
    expect(calls.some(c => c.sql.includes("note_text, tags"))).toBe(false); // no full-row fetch
  });

  it("an exact id wins over prefix siblings", async () => {
    const r = await readDraft(makeEnv({
      journalRows: [
        { id: "abc12345", review_state: "draft", created_at: "2026-09-25T00:00:00Z", excerpt: "exact" },
        { id: "abc12345-longer", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "sibling" },
      ],
      firsts: [{ ...jFull, id: "abc12345" }],
    }).env, { agent: "cypher", id: "abc12345" });
    expect(r.ok && r.draft.id).toBe("abc12345");
  });

  it("bad ids never query; not-yours is a no-change witness", async () => {
    const a = makeEnv();
    const bad = await execTrayDraftRead(Object.assign(ctxFor("cypher", "read draft x", { id: "%%%%%%%%" }), { env: a.env }));
    expect(bad["error"]).toBe("tray_draft_read_failed");
    const short = await execTrayDraftRead(Object.assign(ctxFor("cypher", "read draft 0f3a"), { env: a.env }));
    expect(short["error"]).toBe("tray_draft_read_failed");
    expect(a.calls).toHaveLength(0);
    const b = makeEnv();
    const none = await execTrayDraftRead(Object.assign(ctxFor("cypher", "read draft 0f3a9c1e-ffff"), { env: b.env }));
    expect(none["ack"]).toBe(false);
    expect(String(none["witness"])).toContain("not yours");
  });

  it("keep/drop share the resolver: an ambiguous prefix changes NOTHING and lists the matches", async () => {
    const { env, calls } = makeEnv({
      journalRows: [
        { id: "abc12345-one", review_state: "draft", created_at: "2026-09-25T00:00:00Z", excerpt: "a" },
        { id: "abc12345-two", review_state: "draft", created_at: "2026-09-26T00:00:00Z", excerpt: "b" },
      ],
    });
    const r = await execTrayKeep(Object.assign(ctxFor("drevan", "keep draft abc12345"), { env }));
    expect(r["error"]).toBe("tray_keep_ambiguous");
    expect(String(r["reason"])).toContain("Nothing changed");
    expect(calls.some(c => c.sql.includes("UPDATE"))).toBe(false);
    // Same on the raw HTTP door: 409 with the candidates, not a misleading 400.
    const res = await postAdminTrayReview(new Request("https://x/admin/tray/review", {
      method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
      body: JSON.stringify({ agent: "drevan", kind: "journal", id: "abc12345", decision: "kept" }),
    }), env);
    expect(res.status).toBe(409);
    expect(((await res.json()) as any).matches).toHaveLength(2);
  });

  it("the tray listing footer teaches read draft for the full text", async () => {
    const { env } = makeEnv({ firsts: [{ draft: 0, kept: 0, dropped: 0 }, { draft: 0, kept: 0, dropped: 0 }] });
    const r = await execTrayRead(Object.assign(ctxFor("cypher", "my tray"), { env }));
    expect((r["data"] as any).footer).toBe(TRAY_FOOTER);
    expect(TRAY_FOOTER).toContain('"read draft <id>" for the full text');
  });
});
