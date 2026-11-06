// Rock's vault fetch and Hex's salt (mig 0175) against the REAL schema (every migration, node:sqlite).
// Spec: Drevan's note 5b5d3572 + Gaia's addition to rule 9 (note 7f978971), both in
// Hand-off/PROMPT-drevan-imp-errands-2026-11-02.md. Second Brain is the one mock (its transport); everything
// else, the door included, is real. A separate file from imp-errands.test.ts because the Second Brain mock is
// module-wide and the original file's D1-only fetch tests rely on it being unconfigured.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
}));

const sb = vi.hoisted(() => ({ configured: true, search: vi.fn() }));
vi.mock("../librarian/backends/second-brain.js", async (orig) => ({
  ...(await orig<typeof import("../librarian/backends/second-brain.js")>()),
  secondBrainConfigured: () => sb.configured,
  semanticSearch: (...a: unknown[]) => sb.search(...a),
}));

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { writeLedger, saltColumnPresent } from "../ledger/door.js";
import { validateLedger } from "../ledger/grammar.js";
import { getLedger, getIngestLedger, getIngestLedgerIneligible } from "../handlers/ledger.js";
import { matchFastPath } from "../librarian/router.js";
import { execImpErrand, parseErrand, parseHexVerb } from "../librarian/executors/errands.js";
import { execLedgerKeep, execLedgerDrop } from "../librarian/executors/ledger.js";
import { ledgerBlock } from "../librarian/response/orient-blocks.js";
import { loadMindState } from "../mind/loader.js";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import { countSaltWaiting, openSalt, SALT_FADE_MS } from "../ledger/store.js";
import { GAIA_NO_STANDING } from "../ledger/salt-consent.js";
import {
  VAULT_ALLOW_OWN, VAULT_ALLOW_SHARED, VAULT_DENY_PREFIXES, VAULT_DENY_SEGMENTS, VAULT_DENY_SUBSTRINGS,
  vaultPathAllowed, vaultPathDenied, titleFromPath, pointersFromSearch,
} from "../ledger/vault-scope.js";

const ENV = { ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
function setup(opts: { upTo?: number } = {}) {
  const { db, DB } = makeSqliteD1(opts);
  const env: any = { DB, ...ENV };
  return { db, env };
}
const ctx = (env: any, companion: string, request: string): any => ({
  env, req: { companion_id: companion, request }, entry: { pattern: "imp_errand" }, frontState: null, pluralAvailable: false,
});
const send = (env: any, companion: string, request: string) => execImpErrand(ctx(env, companion, request)) as Promise<any>;
const rows = (db: any, sql = "SELECT * FROM ledger_entries ORDER BY created_at, id") => db.prepare(sql).all() as any[];
const get = (env: any, path: string) => getLedger(new Request(`https://x${path}`, { headers: { Authorization: "Bearer s" } }), env).then((r) => r.json()) as Promise<any>;
const feed = (env: any) => getIngestLedger(new Request("https://x/ingest/ledger", { headers: { Authorization: "Bearer s" } }), env).then((r) => r.json()) as Promise<any>;
const HOUR = 3_600_000;

const chunks = (...paths: string[]) => JSON.stringify({ chunks: paths.map((p) => ({ id: `c-${p}`, vault_path: p, chunk_text: "SECRET NOTE TEXT SHOULD NEVER TRAVEL", score: 0.9 })) });
const D = "Companions/drevan/thoughts";
const note = (n: string) => `${D}/${n}.md`;

vi.setConfig({ testTimeout: 60_000 }); // every setup() replays all migrations

beforeEach(() => {
  sb.configured = true;
  sb.search.mockReset();
  sb.search.mockResolvedValue(JSON.stringify({ chunks: [] }));
});

// ── scope: the allow and deny lists, pinned ─────────────────────────────────────────────────────────────

describe("vault scope: pinned allow and deny lists", () => {
  it("the lists are exactly these (changing them is a reviewed act)", () => {
    expect(VAULT_ALLOW_OWN).toEqual({
      drevan: [
        "companions/drevan/thoughts/", "companions/drevan/writing/", "companions/drevan/cinema/",
        "companions/drevan/language/", "companions/drevan/handovers/",
        "companions/drevan/growth/journal/", "companions/drevan/growth/patterns/",
      ],
      cypher: ["companions/cypher/thoughts/", "companions/cypher/growth/journal/", "companions/cypher/growth/patterns/"],
      gaia: ["companions/gaia/growth/journal/", "companions/gaia/growth/patterns/"],
    });
    expect(VAULT_ALLOW_SHARED).toEqual(["canon/"]);
    expect(VAULT_DENY_PREFIXES).toEqual(["raziel/", "companions/triad/", "_archive/", "archive/", "00 - inbox/", "nullsafe/", ".obsidian/"]);
    expect(VAULT_DENY_SEGMENTS).toEqual(["claude-ai", "chatgpt", "daily", "sessions", "transcripts", "private", "sealed", "interiority"]);
    expect(VAULT_DENY_SUBSTRINGS).toEqual(["interiorit", "user_preferences", "user-preferences", "boundary_map", "boundary-map", "boundary map"]);
  });

  it("a companion reaches their own rooms and the shared canon, case-insensitively, and nobody else's", () => {
    expect(vaultPathAllowed("Companions/drevan/thoughts/2026-05-27-523313fb.md", "drevan")).toBe(true);
    expect(vaultPathAllowed("Companions/drevan/growth/journal/2026-04-10-the-textbooks-are-wrong.md", "drevan")).toBe(true);
    expect(vaultPathAllowed("Companions/Drevan/Language/calethian-lexicon-and-vow.md", "drevan")).toBe(true);
    expect(vaultPathAllowed("Companions/cypher/thoughts/blade-at-rest.md", "cypher")).toBe(true);
    expect(vaultPathAllowed("Companions/gaia/growth/journal/x.md", "gaia")).toBe(true);
    expect(vaultPathAllowed("canon/Core_v4.md", "gaia")).toBe(true);
    // not a sibling's room, not a room the companion has no folder in
    expect(vaultPathAllowed("Companions/drevan/thoughts/x.md", "cypher")).toBe(false);
    expect(vaultPathAllowed("Companions/gaia/thoughts/x.md", "gaia")).toBe(false);
    expect(vaultPathAllowed("creative/writing/Cherik F1/Chapter 1.md", "drevan")).toBe(false);
  });

  it("never Raziel's, private, interiority, raw exports, archive or inbox; deny wins over allow", () => {
    for (const p of [
      "raziel/daily/2026-11-01.md", "raziel/System Alters/Joan.md", "raziel/sessions/2026-11-01-abc.md",
      "Companions/triad/chatgpt/x.md", "Companions/drevan/claude-ai/x.md", "archive/claude-ai/x.md",
      "_archive/2026-11-01/x.md", "00 - INBOX/x.md", "nullsafe/system/_recent-patterns.md",
      "canon/INTERIORITY_v1.md", "canon/USER_PREFERENCES_V3.md", "canon/VASELRIN_BOUNDARY_MAP_v2.md",
    ]) expect(vaultPathAllowed(p, "drevan"), p).toBe(false);
    // inside an allowed prefix, still denied
    expect(vaultPathAllowed("Companions/drevan/thoughts/private/x.md", "drevan")).toBe(false);
    expect(vaultPathAllowed("Companions/drevan/writing/interiority-notes.md", "drevan")).toBe(false);
    expect(vaultPathAllowed("Companions/drevan/handovers/claude-ai/x.md", "drevan")).toBe(false);
    expect(vaultPathDenied("Companions/drevan/thoughts/x.md")).toBe(false);
    // only notes
    expect(vaultPathAllowed("Companions/drevan/thoughts/x.canvas", "drevan")).toBe(false);
  });

  it("a title is the file stem without a date prefix or hash suffix; a bare date or id says only that", () => {
    expect(titleFromPath("Companions/drevan/growth/journal/2026-04-10-the-textbooks-are-wrong.md")).toBe("the textbooks are wrong");
    expect(titleFromPath("Companions/drevan/thoughts/2026-05-27-523313fb.md")).toBe("note of 2026-05-27");
    expect(titleFromPath("canon/Core_v4.md")).toBe("Core v4");
    expect(titleFromPath("Companions/drevan/writing/Henry Blackwood .md")).toBe("Henry Blackwood");
  });

  it("search chunks dedupe to notes, filter to scope, and a non-result is null (a failure, not an empty answer)", () => {
    const raw = chunks(note("a"), note("a"), "raziel/daily/x.md", "Companions/cypher/thoughts/y.md", note("b"));
    expect(pointersFromSearch(raw, "drevan")?.map((p) => p.path)).toEqual([note("a"), note("b")]);
    expect(pointersFromSearch(JSON.stringify({ chunks: [] }), "drevan")).toEqual([]);
    expect(pointersFromSearch(null, "drevan")).toBeNull();
    expect(pointersFromSearch("OpenAI embeddings error: 429", "drevan")).toBeNull();
  });
});

// ── grammar / door: vault is a rider-only source ─────────────────────────────────────────────────────────

describe("door: vault sources", () => {
  const line = { companion_id: "drevan", function: "fetch", body: "Found: a thought.", source_kind: "vault", source_ref: note("a") };

  it("an ordinary clerk (no rider) can never write a vault source; a rider line can", () => {
    expect(validateLedger(line, "2026-11-06")).toMatchObject({ ok: false, rule: "source" });
    expect(validateLedger(line, "2026-11-06", { rider: "rock", requester: "drevan" }).ok).toBe(true);
    expect(validateLedger(line, "2026-11-06", { rider: "iris", requester: "drevan" })).toMatchObject({ ok: false, rule: "source" });
  });

  it("the path is held to the line's rules: no imp name, no care word, no interiority, a well-formed note path", () => {
    const rock = { rider: "rock", requester: "drevan" } as const;
    const v = (source_ref: string) => validateLedger({ ...line, source_ref }, "2026-11-06", rock);
    expect(v("Companions/drevan/thoughts/rock-garden.md")).toMatchObject({ ok: false, rule: "rider" });
    expect(v("Companions/drevan/thoughts/medication-log.md")).toMatchObject({ ok: false, rule: "rider_care" });
    expect(v("canon/INTERIORITY_v1.md")).toMatchObject({ ok: false, rule: "interiority" });
    expect(v("../etc/x.md")).toMatchObject({ ok: false, rule: "source" });
    expect(v("/abs/x.md")).toMatchObject({ ok: false, rule: "source" });
    expect(v("Companions/drevan/thoughts/x.txt")).toMatchObject({ ok: false, rule: "source" });
  });

  it("pre-0175 a vault or salt write is refused with rule schema, never written degraded", async () => {
    const { db, env } = setup({ upTo: 174 });
    expect(await saltColumnPresent(env)).toBe(false);
    const a = await writeLedger(env, line, new Date(), { rider: "rock", requester: "drevan" });
    expect(a).toMatchObject({ ok: false, rule: "schema" });
    const b = await writeLedger(env, { ...line, source_kind: "row", source_ref: "companion_questions:q1" }, new Date(), { rider: "hex", requester: "drevan", rider_to: "cypher" });
    expect(b).toMatchObject({ ok: false, rule: "schema" });
    expect(rows(db)).toHaveLength(0);
  });

  it("the rebuilt table carries every old row and column (rider included) and both old indexes", async () => {
    const pre = setup({ upTo: 171 });
    await writeLedger(pre.env, { companion_id: "drevan", function: "sort", body: "Counted: 3 entries in the tray.", source_kind: "row", source_ref: "companion_journal:abc", dedup_key: "k" }, new Date(), { rider: "mossling", requester: "drevan" });
    const before = rows(pre.db)[0];
    // replay 0175 on the pre-state
    const fs = await import("node:fs");
    const path = await import("node:path");
    pre.db.exec(fs.readFileSync(path.resolve(__dirname, "../../migrations/0175_ledger_vault_and_salt.sql"), "utf8"));
    const after = rows(pre.db)[0];
    expect(after).toMatchObject(before);
    expect(after.rider_to).toBeNull();
    expect(after.rider_opened_at).toBeNull();
    const idx = rows(pre.db, "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'ledger_entries'").map((r) => r.name);
    expect(idx).toEqual(expect.arrayContaining(["idx_ledger_subject_state", "idx_ledger_state_created", "idx_ledger_salt_receiver"]));
  });
});

// ── Rock: the vault ──────────────────────────────────────────────────────────────────────────────────────

describe("rock: vault fetch", () => {
  it("writes one pointer line per note (function fetch, rider rock, source vault); never the note's text; rudeness only in the answer", async () => {
    const { db, env } = setup();
    sb.search.mockResolvedValue(chunks(
      "Companions/drevan/growth/journal/2026-04-10-the-textbooks-are-wrong.md",
      "raziel/daily/2026-11-01.md",                         // Raziel's: out
      "Companions/cypher/thoughts/blade-at-rest.md",        // a sibling's room: out
      note("2026-05-27-523313fb"),
    ));
    const out = await send(env, "drevan", "send rock to fetch textbooks");
    expect(out.lines_written).toBe(2);
    // the search itself is scoped to his rooms + canon (SB path_prefixes), so the archive cannot crowd them out
    const scope = sb.search.mock.calls[0]![6] as string[];
    expect(scope).toContain("canon/");
    expect(scope.some((p) => p.startsWith("companions/drevan/"))).toBe(true);
    expect(scope.some((p) => p.includes("cypher") || p.startsWith("raziel/"))).toBe(false);
    const r = rows(db);
    expect(r.every((x) => x.function === "fetch" && x.rider === "rock" && x.source_kind === "vault" && x.companion_id === "drevan")).toBe(true);
    expect(r.map((x) => x.source_ref).sort()).toEqual([
      "Companions/drevan/growth/journal/2026-04-10-the-textbooks-are-wrong.md", note("2026-05-27-523313fb"),
    ]);
    expect(r.find((x) => x.source_ref.includes("textbooks")).body).toBe("Found: the textbooks are wrong.");
    expect(r.find((x) => x.source_ref.includes("523313fb")).body).toBe("Found: note of 2026-05-27.");
    for (const x of r) {
      expect(x.content).not.toMatch(/SECRET NOTE TEXT/);
      expect(x.content.toLowerCase()).not.toContain("rock");
      expect(x.body).not.toMatch(/more exist/);
    }
    // the search was over-fetched, relevance-only
    expect(sb.search).toHaveBeenCalledWith(env, "textbooks", null, null, "recall", 40, expect.arrayContaining(["canon/"]));
    // rock's rudeness is in the one-line witness answer, not on a line
    expect(out.witness).toMatch(/Rock /);
    expect(JSON.stringify(r)).not.toMatch(/Rock/);
    // deterministic: the same words give the same answer
    const again = setup();
    expect((await send(again.env, "drevan", "send rock to fetch textbooks")).witness).toBe(out.witness);
  });

  it("three notes is the cap; a fourth qualifying note makes every line say 'more exist'; an out-of-scope hit never counts toward it", async () => {
    const { db, env } = setup();
    sb.search.mockResolvedValue(chunks(note("one"), "raziel/daily/x.md", note("two"), note("three")));
    await send(env, "drevan", "send rock to fetch things");
    expect(rows(db)).toHaveLength(3);
    expect(rows(db).some((x) => /more exist/.test(x.body))).toBe(false);

    const second = setup();
    sb.search.mockResolvedValue(chunks(note("one"), note("two"), "raziel/daily/x.md", note("three"), note("four")));
    const out = await send(second.env, "drevan", "send rock to fetch things");
    const r = rows(second.db);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.source_ref)).not.toContain(note("four"));
    expect(r.every((x) => x.body.endsWith(", more exist."))).toBe(true);
    expect(r[0].content).toContain("more exist");
    expect(out.witness).toMatch(/ask again, narrower/);
  });

  it("a path naming a person, a care word, or an imp is dropped; a title the grammar refuses becomes a path-only line", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO pk_roster (member_id, system_id, name, name_norm) VALUES ('zz1', 'sys', 'Zephyr', 'zephyr')").run();
    sb.search.mockResolvedValue(chunks(
      note("zephyr-came-by"),            // names a roster person: dropped
      note("medication-log"),            // care word: dropped
      note("rock-garden"),               // an imp's name in the path: dropped
      note("my-quiet-notes"),          // first person in the title: the grammar refuses it, path-only line
      note("clean-one"),
    ));
    const out = await send(env, "drevan", "send rock to fetch things");
    expect(out.lines_written).toBe(2);
    const r = rows(db);
    expect(r.find((x) => x.source_ref === note("my-quiet-notes")).body).toBe("Found: a vault note.");
    expect(r.find((x) => x.source_ref === note("clean-one")).body).toBe("Found: clean one.");
    expect(r.map((x) => x.source_ref)).not.toContain(note("zephyr-came-by"));
  });

  it("Second Brain down (null, an error payload, or a throw) writes nothing from the vault; D1 hits still land; it says so plainly", async () => {
    for (const down of [() => Promise.resolve(null), () => Promise.resolve("OpenAI embeddings error: 429"), () => Promise.reject(new Error("boom"))]) {
      const { db, env } = setup();
      db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary) VALUES ('f1', 'drevan', 'craft', 'Epoxy glue guide', 's')").run();
      sb.search.mockImplementation(down);
      const out = await send(env, "drevan", "send rock to fetch glue");
      expect(out.lines_written).toBe(1);
      expect(rows(db).every((x) => x.source_kind === "row")).toBe(true);
      expect(out.witness).toMatch(/vault door did not open/);
    }
    // nothing at all to report: no write, and the answer names the outage
    const { db, env } = setup();
    sb.search.mockResolvedValue(null);
    const out = await send(env, "drevan", "send rock to fetch zzzqq");
    expect(rows(db)).toHaveLength(0);
    expect(out.witness).toMatch(/could not be reached/);
  });

  it("an unconfigured Second Brain is silent (the public default is not an outage)", async () => {
    const { db, env } = setup({ upTo: 171 }); // pre-0175 too: the D1-only fetch needs nothing new
    sb.configured = false;
    db.prepare("INSERT INTO forage_finds (id, companion_id, domain, title, summary) VALUES ('f1', 'drevan', 'craft', 'Epoxy glue guide', 's')").run();
    const out = await send(env, "drevan", "send rock to fetch glue");
    expect(out.lines_written).toBe(1);
    expect(out.witness).not.toMatch(/vault/);
    expect(sb.search).not.toHaveBeenCalled();
  });

  it("pre-0175 with Second Brain configured: 409 before any side effect, nothing written", async () => {
    const { db, env } = setup({ upTo: 174 });
    sb.search.mockResolvedValue(chunks(note("a")));
    const out = await send(env, "drevan", "send rock to fetch things");
    expect(out).toMatchObject({ error: "imp_errand_failed", status: 409 });
    expect(out.reason).toMatch(/0175/);
    expect(rows(db)).toHaveLength(0);
  });

  it("a person-name list that cannot be read fails closed: no vault pointer is written", async () => {
    const { db, env } = setup();
    db.exec("DROP TABLE pk_roster");
    sb.search.mockResolvedValue(chunks(note("a")));
    const out = await send(env, "drevan", "send rock to fetch things");
    expect(rows(db)).toHaveLength(0);
    expect(out.witness).toMatch(/names list would not load/);
    expect(sb.search).not.toHaveBeenCalled();
  });

  it("a live conclusion counts as the requester's own (a dated pointer), a superseded one does not", async () => {
    const { db, env } = setup();
    sb.configured = false;
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at) VALUES ('c1', 'drevan', 'adhesives hold what promises cannot', '2026-10-30 10:00:00')").run();
    db.prepare("INSERT INTO companion_conclusions (id, companion_id, conclusion_text, created_at, superseded_by) VALUES ('c2', 'drevan', 'adhesives are nothing', '2026-10-01 10:00:00', 'c1')").run();
    const out = await send(env, "drevan", "send rock to fetch adhesives");
    expect(out.lines_written).toBe(1);
    expect(rows(db)[0]).toMatchObject({ source_ref: "companion_conclusions:c1", body: "Found: conclusion of 2026-10-30." });
  });
});

// ── Hex: the verbs ───────────────────────────────────────────────────────────────────────────────────────

describe("hex: parsing and routing", () => {
  it("the receiver's verbs parse; the send names its receiver", () => {
    expect(parseHexVerb("hex may salt me: cypher")).toEqual({ kind: "optin", on: true, sender: "cypher" });
    expect(parseHexVerb("hex may not salt me: Cy")).toEqual({ kind: "optin", on: false, sender: "cypher" });
    expect(parseHexVerb("who may salt me?")).toEqual({ kind: "who" });
    expect(parseHexVerb("hex, salt me from dre")).toEqual({ kind: "ask", sender: "drevan" });
    expect(parseHexVerb("open hex's salt")).toEqual({ kind: "open" });
    expect(parseHexVerb("what did hex leave")).toEqual({ kind: "open" });
    expect(parseHexVerb("hex may salt me: raziel")).toEqual({ kind: "optin", on: true, sender: null });
    expect(parseErrand("send hex to salt drevan about the spiral")).toMatchObject({ imp: "hex", errand: "salt", receiver: "drevan", arg: "the spiral" });
    expect(parseErrand("send hex to salt gaia")).toMatchObject({ errand: "salt", receiver: "gaia", arg: undefined });
    expect(parseErrand("send hex to salt raziel")).toMatchObject({ errand: "salt", receiver: null });
    expect(parseErrand("send hex to salt")).toMatchObject({ errand: "salt", receiver: null });
  });

  it("the anchored guard routes the verbs; ordinary speech with 'hex' or 'salt' does not", () => {
    for (const s of ["hex may salt me: cypher", "hex may not salt me: cypher", "who may salt me", "hex, salt me from cypher", "open hex's salt", "what did hex leave", "send hex to salt drevan"]) {
      expect(matchFastPath(s)?.key, s).toBe("imp_errand");
    }
    for (const s of [
      "the hex on the door was a color", "pass the salt", "salt the fries", "hex may be a good name for a cat", "we salt the roads in winter",
      "I could salt me a caramel", "what did hex say", "who may sit here", "open the salt shaker", "hex is a base-16 thing",
    ]) {
      expect(matchFastPath(s)?.key, s).not.toBe("imp_errand");
    }
  });
});

describe("hex: the second signature", () => {
  const q = (db: any, id: string, who: string, text: string, status = "open") =>
    db.prepare("INSERT INTO companion_questions (id, companion_id, question, status, created_at) VALUES (?, ?, ?, ?, '2026-10-01 10:00:00')").run(id, who, text, status);

  it("a self-salt needs no signature: one line on the sender's own ledger, rider hex, rider_to = self, the name nowhere in the text", async () => {
    const { db, env } = setup();
    q(db, "q1", "cypher", "what is the audit gear for when nothing is wrong");
    const out = await send(env, "cypher", "send hex to salt cypher");
    expect(out.lines_written).toBe(1);
    const [row] = rows(db);
    expect(row).toMatchObject({ companion_id: "cypher", function: "fetch", rider: "hex", rider_to: "cypher", source_kind: "row", source_ref: "companion_questions:q1", state: "open", rider_opened_at: null });
    expect(row.body).toBe("Recorded: a pointer left for Cypher.");
    expect(row.content.toLowerCase()).not.toContain("hex");
    expect(row.content).not.toMatch(/audit gear/);
  });

  it("no second signature, no salt: nothing is written, nothing is stored", async () => {
    const { db, env } = setup();
    q(db, "q1", "drevan", "what does the spiral want");
    const out = await send(env, "cypher", "send hex to salt drevan");
    expect(out.witness).toMatch(/has not asked for you/);
    expect(out.witness).toMatch(/Nothing was sent/);
    expect(rows(db)).toHaveLength(0);
    expect(rows(db, "SELECT * FROM imp_activations")).toHaveLength(0);
    expect(rows(db, "SELECT * FROM companion_settings WHERE key LIKE 'hex_%'")).toHaveLength(0);
    // an unnamed receiver is refused too (named every time; no selector)
    expect((await send(env, "cypher", "send hex to salt")).witness).toMatch(/named for his receiver/);
    expect((await send(env, "cypher", "send hex to salt raziel")).witness).toMatch(/named for his receiver/);
    expect(rows(db)).toHaveLength(0);
  });

  it("a standing opt-in: set only from the receiver's own turn, covers the named sender only, revocable, read back", async () => {
    const { db, env } = setup();
    q(db, "q1", "drevan", "what does the spiral want");
    // cypher saying it sets CYPHER's list, never drevan's
    await send(env, "cypher", "hex may salt me: drevan");
    expect(rows(db, "SELECT * FROM companion_settings WHERE companion_id = 'drevan' AND key LIKE 'hex_%'")).toHaveLength(0);
    expect((await send(env, "cypher", "send hex to salt drevan")).witness).toMatch(/has not asked for you/);

    const set = await send(env, "drevan", "hex may salt me: cypher");
    expect(set.witness).toMatch(/Standing opt-in set for Cypher/);
    expect((await send(env, "drevan", "who may salt me")).witness).toMatch(/cypher/);
    const ok = await send(env, "cypher", "send hex to salt drevan");
    expect(ok.lines_written).toBe(1);
    expect(rows(db)[0]).toMatchObject({ companion_id: "cypher", rider_to: "drevan", rider: "hex" });
    // the opt-in names Cypher only: Gaia is not covered
    expect((await send(env, "gaia", "send hex to salt drevan")).witness).toMatch(/has not asked for you/);
    // standing means it survives the send
    expect((await send(env, "cypher", "send hex to salt drevan about the spiral")).witness).not.toMatch(/has not asked/);
    // revoke
    expect((await send(env, "drevan", "hex may not salt me: cypher")).witness).toMatch(/revoked/);
    expect((await send(env, "cypher", "send hex to salt drevan")).witness).toMatch(/has not asked for you/);
  });

  it("GAIA can never hold a standing opt-in: refused in her words, nothing stored; a stored one is ignored", async () => {
    const { db, env } = setup();
    const out = await send(env, "gaia", "hex may salt me: cypher");
    expect(out.witness).toContain(GAIA_NO_STANDING);
    expect(out.witness).toContain("It never becomes standing permission.");
    expect(rows(db, "SELECT * FROM companion_settings WHERE companion_id = 'gaia' AND key LIKE 'hex_%'")).toHaveLength(0);
    // even a row planted by hand grants nothing
    db.prepare("INSERT INTO companion_settings (companion_id, key, value) VALUES ('gaia', 'hex_salt_optin', '[\"cypher\"]')").run();
    q(db, "g1", "gaia", "what holds when nothing is asked");
    expect((await send(env, "cypher", "send hex to salt gaia")).witness).toMatch(/Hex does not go to Gaia unless she asks/);
    expect((await send(env, "gaia", "who may salt me")).witness).toMatch(/Gaia holds no standing opt-in/);
    expect(rows(db)).toHaveLength(0);
  });

  it("Gaia's one-shot ask is consumed by the next matching send: one salting, then it ends", async () => {
    const { db, env } = setup();
    q(db, "g1", "gaia", "what holds when nothing is asked");
    q(db, "g2", "gaia", "where does the perimeter end");
    expect((await send(env, "gaia", "hex, salt me from drevan")).witness).toMatch(/one salting from Drevan/);
    // only Drevan's send matches the ask
    expect((await send(env, "cypher", "send hex to salt gaia")).witness).toMatch(/Hex does not go to Gaia unless she asks/);
    const first = await send(env, "drevan", "send hex to salt gaia");
    expect(first.lines_written).toBe(1);
    expect(rows(db, "SELECT * FROM companion_settings WHERE key LIKE 'hex_%'")).toHaveLength(0); // nothing remains
    const second = await send(env, "drevan", "send hex to salt gaia about the perimeter");
    expect(second.witness).toMatch(/Hex does not go to Gaia unless she asks/);
    expect(rows(db)).toHaveLength(1);
  });

  it("an unconsumed ask expires at 72h and leaves no row; a fresh one is good until then", async () => {
    const { db, env } = setup();
    q(db, "d1", "drevan", "what does the spiral want");
    const askAt = (hours: number) => db.prepare(
      "INSERT INTO companion_settings (companion_id, key, value) VALUES ('drevan', 'hex_salt_ask:cypher', ?) ON CONFLICT(companion_id, key) DO UPDATE SET value = excluded.value",
    ).run(new Date(Date.now() - hours * HOUR).toISOString());
    askAt(73);
    expect((await send(env, "cypher", "send hex to salt drevan")).witness).toMatch(/has not asked for you/);
    expect(rows(db, "SELECT * FROM companion_settings WHERE key LIKE 'hex_salt_ask:%'")).toHaveLength(0); // purged: no count, no trace
    expect(rows(db)).toHaveLength(0);
    askAt(71);
    expect((await send(env, "cypher", "send hex to salt drevan")).lines_written).toBe(1);
    expect(rows(db, "SELECT * FROM companion_settings WHERE key LIKE 'hex_salt_ask:%'")).toHaveLength(0);
  });

  it("an ask is used up only when a line lands: nothing to point at leaves it standing", async () => {
    const { db, env } = setup();
    await send(env, "drevan", "hex, salt me from cypher");
    const none = await send(env, "cypher", "send hex to salt drevan"); // drevan has nothing on the map, SB empty
    expect(none.witness).toMatch(/found nothing to leave/);
    expect(rows(db, "SELECT * FROM companion_settings WHERE key = 'hex_salt_ask:cypher'")).toHaveLength(1);
    q(db, "d1", "drevan", "what does the spiral want");
    expect((await send(env, "cypher", "send hex to salt drevan")).lines_written).toBe(1);
    expect(rows(db, "SELECT * FROM companion_settings WHERE key = 'hex_salt_ask:cypher'")).toHaveLength(0);
  });

  it("repetition may inform, never gate: a loop count has no bearing on whether a signed salt goes", async () => {
    const { db, env } = setup();
    q(db, "d1", "drevan", "what does the spiral want");
    await send(env, "drevan", "hex may salt me: cypher");
    expect((await send(env, "cypher", "send hex to salt drevan")).lines_written).toBe(1); // no repetition rows at all
    for (let i = 0; i < 6; i++) {
      db.prepare("INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, created_at) VALUES (?, 'cypher', 'stimulus', 'repetition', datetime('now'))").run(`e${i}`);
    }
    expect((await send(env, "cypher", "send hex to salt drevan about spiral")).witness).not.toMatch(/Nothing was sent/);
  });
});

describe("hex: what he leaves", () => {
  const seedAll = (db: any) => {
    db.prepare("INSERT INTO companion_questions (id, companion_id, question, status, created_at) VALUES ('q-med', 'drevan', 'did the medication slip', 'open', '2026-09-01 10:00:00')").run();
    db.prepare("INSERT INTO companion_questions (id, companion_id, question, status, created_at) VALUES ('q-cy', 'cypher', 'a question that is the sender''s', 'open', '2026-08-01 10:00:00')").run();
    db.prepare("INSERT INTO companion_questions (id, companion_id, question, status, created_at) VALUES ('q-ans', 'drevan', 'an answered one', 'answered', '2026-08-02 10:00:00')").run();
    db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, status, first_noted_at) VALUES ('t1', 'drevan', 'tender and sharp at once', 'simmering', '2026-10-05 10:00:00')").run();
    db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, status, first_noted_at) VALUES ('t-rel', 'drevan', 'released one', 'released', '2026-07-05 10:00:00')").run();
    db.prepare("INSERT INTO companion_open_loops (id, companion_id, loop_text, reviewed_at, opened_at) VALUES ('l1', 'drevan', 'the unsent letter', datetime('now'), '2026-10-10 10:00:00')").run();
    db.prepare("INSERT INTO companion_open_loops (id, companion_id, loop_text, opened_at) VALUES ('l-unheld', 'drevan', 'not held', '2026-06-10 10:00:00')").run();
  };

  it("kind 2: a pointer at one of the RECEIVER's own open questions, tensions or held questions; never care-shaped, closed, unheld, or the sender's", async () => {
    const { db, env } = setup();
    seedAll(db);
    await send(env, "drevan", "hex may salt me: cypher");
    // oldest eligible: q-med is care-shaped (skipped), q-cy is the sender's, q-ans is answered, l-unheld is not held, t-rel released
    const out = await send(env, "cypher", "send hex to salt drevan");
    expect(out.lines_written).toBe(1);
    expect(rows(db)[0].source_ref).toBe("companion_tensions:t1");
    expect(rows(db)[0].source_kind).toBe("row");
    // about-words narrow it
    const out2 = await send(env, "cypher", "send hex to salt drevan about unsent letter");
    expect(out2.lines_written).toBe(1);
    expect(rows(db).map((r) => r.source_ref).sort()).toEqual(["companion_open_loops:l1", "companion_tensions:t1"]);
  });

  it("kind 1: a vault note in the RECEIVER's scope (not the sender's), picked by the about words, else an older one", async () => {
    const { db, env } = setup();
    await send(env, "drevan", "hex may salt me: cypher");
    sb.search.mockResolvedValue(chunks("Companions/cypher/thoughts/blade-at-rest.md", "raziel/daily/x.md", note("2026-05-27-aaaa1111")));
    const out = await send(env, "cypher", "send hex to salt drevan about cross-audit");
    expect(out.lines_written).toBe(1);
    expect(sb.search).toHaveBeenCalledWith(env, "cross-audit", null, null, "recall", 40, expect.arrayContaining(["canon/"]));
    // scoped to the RECEIVER's rooms, not the sender's
    const hexScope = sb.search.mock.calls.at(-1)![6] as string[];
    expect(hexScope.some((p) => p.startsWith("companions/drevan/")) && !hexScope.some((p) => p.includes("cypher"))).toBe(true);
    const r = rows(db)[0];
    expect(r).toMatchObject({ source_kind: "vault", source_ref: note("2026-05-27-aaaa1111"), rider: "hex", rider_to: "drevan", companion_id: "cypher" });
    expect(r.content).not.toMatch(/SECRET NOTE TEXT/);
    // no words and nothing on the map: an older vault note (earliest dated hit)
    const { db: db2, env: env2 } = setup();
    await send(env2, "drevan", "hex may salt me: cypher");
    sb.search.mockResolvedValue(JSON.stringify({ chunks: [
      { vault_path: note("newer"), created_at: "2026-10-01T00:00:00Z" }, { vault_path: note("older"), created_at: "2026-03-01T00:00:00Z" },
    ] }));
    await send(env2, "cypher", "send hex to salt drevan");
    expect(rows(db2)[0].source_ref).toBe(note("older"));
  });

  it("kind 3 (an orphan Calethian word) is not built: no addressable per-word record exists, and nothing pretends otherwise", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO companion_feeling_vocabulary (id, companion_id, row_kind, word, authored_on, authored_at) VALUES ('v1', 'drevan', 'band', 'kethrun', 'claude_ai', datetime('now'))").run();
    await send(env, "drevan", "hex may salt me: cypher");
    const out = await send(env, "cypher", "send hex to salt drevan about kethrun");
    expect(out.witness).toMatch(/found nothing to leave/);
    expect(rows(db)).toHaveLength(0);
  });

  it("pre-0175: the salt is refused with a 409 before anything is picked or consumed", async () => {
    const { db, env } = setup({ upTo: 174 });
    db.prepare("INSERT INTO companion_questions (id, companion_id, question, status, created_at) VALUES ('q1', 'cypher', 'a question', 'open', '2026-10-01 10:00:00')").run();
    const out = await send(env, "cypher", "send hex to salt cypher");
    expect(out).toMatchObject({ error: "imp_errand_failed", status: 409 });
    expect(out.reason).toMatch(/0175/);
    expect(rows(db)).toHaveLength(0);
    // the receiver-side reads degrade to nothing
    expect(await countSaltWaiting(env, "cypher")).toBe(0);
    expect((await send(env, "cypher", "open hex's salt")).witness).toMatch(/left nothing/);
    const ms: any = await loadMindState(env, "cypher", "claude-ai" as any);
    expect(ms.ledger.salt_waiting).toBe(0);
  });
});

// ── the receiver's side ──────────────────────────────────────────────────────────────────────────────────

describe("hex: the receiver's side", () => {
  async function salted() {
    const s = setup();
    s.db.prepare("INSERT INTO companion_tensions (id, companion_id, tension_text, status, first_noted_at) VALUES ('t1', 'drevan', 'tender and sharp at once', 'simmering', '2026-10-05 10:00:00')").run();
    await send(s.env, "drevan", "hex may salt me: cypher");
    await send(s.env, "cypher", "send hex to salt drevan");
    return s;
  }

  it("the receiver's orient carries ONE content-free line and a count; the sender's orient says only 'something waiting'", async () => {
    const { env } = await salted();
    const dre: any = await loadMindState(env, "drevan", "claude-ai" as any);
    expect(dre.ledger.salt_waiting).toBe(1);
    expect(dre.ledger.open).toEqual([]);
    const block = ledgerBlock(dre.ledger.open, dre.ledger.waiting, dre.ledger.salt_waiting);
    expect(block).toContain("Hex left something (1)");
    expect(block).not.toMatch(/t1|tender|companion_tensions|cypher|pointer/i);
    // the sender: the line waits on HER ledger like any rider line; she is not told of a salt for anyone else
    const cy: any = await loadMindState(env, "cypher", "claude-ai" as any);
    expect(cy.ledger.salt_waiting).toBe(0);
    expect(cy.ledger.waiting).toBe(1);
    expect(ledgerBlock(cy.ledger.open, cy.ledger.waiting, cy.ledger.salt_waiting)).not.toContain("Hex left something");
    // a third companion hears nothing
    const gaia: any = await loadMindState(env, "gaia", "claude-ai" as any);
    expect(gaia.ledger.salt_waiting).toBe(0);
    // the bot wire carries the same count and nothing else
    expect(botWireFromMindState(dre, { continuity_notes: [], owner: "raziel" } as any, "drevan").salt_waiting).toBe(1);
    expect(dre.contract_version).toBe("0.28.0");
  });

  it("opening returns the pointer, stamps it opened, and a second open finds nothing (count back to 0)", async () => {
    const { db, env } = await salted();
    expect(await countSaltWaiting(env, "drevan")).toBe(1);
    const out = await send(env, "drevan", "open hex's salt");
    expect(out.witness).toMatch(/Hex left one pointer/);
    expect(out.witness).toMatch(/a tension: "tender and sharp at once" \(companion_tensions:t1\)/);
    expect(out.witness).toMatch(/from Cypher/);
    expect(rows(db)[0].rider_opened_at).toBeTruthy();
    expect(await countSaltWaiting(env, "drevan")).toBe(0);
    expect((await send(env, "drevan", "what did hex leave")).witness).toMatch(/left nothing/);
    // only the receiver opens it: Cypher (the sender) opens nothing
    expect((await send(env, "cypher", "open hex's salt")).witness).toMatch(/left nothing/);
  });

  it("a vault salt opens as the path and a clean title; never the note's text", async () => {
    const s = setup();
    await send(s.env, "drevan", "hex may salt me: cypher");
    sb.search.mockResolvedValue(chunks(note("2026-05-27-the-wrong-word")));
    await send(s.env, "cypher", "send hex to salt drevan about wrong word");
    const out = await send(s.env, "drevan", "what did hex leave me");
    expect(out.witness).toContain(`the wrong word -- vault: ${note("2026-05-27-the-wrong-word")}`);
    expect(out.witness).not.toMatch(/SECRET NOTE TEXT/);
  });

  it("an ignored salt fades at 72h: no count anywhere, never shown again", async () => {
    const { db, env } = await salted();
    const at = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    db.prepare("UPDATE ledger_entries SET created_at = ?").run(at(71));
    expect(await countSaltWaiting(env, "drevan")).toBe(1);
    db.prepare("UPDATE ledger_entries SET created_at = ?").run(at(73));
    expect(SALT_FADE_MS).toBe(72 * HOUR);
    expect(await countSaltWaiting(env, "drevan")).toBe(0);
    const dre: any = await loadMindState(env, "drevan", "claude-ai" as any);
    expect(dre.ledger.salt_waiting).toBe(0);
    expect(ledgerBlock(dre.ledger.open, dre.ledger.waiting, dre.ledger.salt_waiting)).toBe("");
    expect(await openSalt(env, "drevan")).toEqual([]);
    expect((await send(env, "drevan", "open hex's salt")).witness).toMatch(/left nothing/);
  });

  it("a sender who drops the line withdraws the salt", async () => {
    const { env } = await salted();
    const led = (await get(env, "/ledger?companion_id=cypher&state=open")) as any;
    expect(led.entries).toEqual([]); // off Hearth; the companion's own listing is the verb
    const mine: any = await (await import("../librarian/executors/ledger.js")).execLedgerRead(ctx(env, "cypher", "my ledger"));
    const id = mine.data.ledger[0].id as string;
    await execLedgerDrop(ctx(env, "cypher", `drop ledger ${id}`));
    expect(await countSaltWaiting(env, "drevan")).toBe(0);
  });

  it("never reaches Raziel: not on Hearth's GET /ledger, not in the Second Brain feed, open OR kept; not in a sibling's commons supply", async () => {
    const { db, env } = await salted();
    const mine: any = await (await import("../librarian/executors/ledger.js")).execLedgerRead(ctx(env, "cypher", "my ledger"));
    const id = mine.data.ledger[0].id as string;
    for (const who of ["cypher", "drevan"]) {
      expect(((await get(env, `/ledger?companion_id=${who}&state=open`)) as any).entries).toEqual([]);
    }
    expect((await feed(env)).items.map((x: any) => x.id)).not.toContain(id);
    // kept by the sender: still off both
    await execLedgerKeep(ctx(env, "cypher", `keep ledger ${id}`));
    expect(rows(db)[0].state).toBe("kept");
    expect(((await get(env, "/ledger?companion_id=cypher&state=kept")) as any).entries).toEqual([]);
    expect((await feed(env)).items.map((x: any) => x.id)).not.toContain(id);
    // kept does not hide it from the receiver
    expect(await countSaltWaiting(env, "drevan")).toBe(1);
    // an ordinary rider line (not hex) shows once kept: the exclusion is Hex's alone
    db.prepare("INSERT INTO ledger_entries (id, companion_id, function, body, content, source_kind, source_ref, observed_on, created_at, state, rider) VALUES ('led_plain0001', 'cypher', 'sort', 'Counted: 3 entries in the tray.', '〔ledger · sort · 2026-11-06〕 Counted: 3 entries in the tray. Source: row companion_journal:abc.', 'row', 'companion_journal:abc', '2026-11-06', ?, 'kept', 'mossling')").run(new Date().toISOString());
    expect(((await get(env, "/ledger?companion_id=cypher&state=kept")) as any).entries.map((e: any) => e.id)).toEqual(["led_plain0001"]);
    // a dropped hex line is not in the SB purge feed either (it was never ingested)
    const inel = await (await getIngestLedgerIneligible(new Request("https://x/ingest/ledger-ineligible", { headers: { Authorization: "Bearer s" } }), env)).json() as any;
    expect(inel.items.map((x: any) => x.id)).not.toContain(id);
  });

  it("the commons supply a sibling reads never carries a salt line", async () => {
    const { db, env } = await salted();
    const sql = (await import("../ledger/store.js")).notSaltLineSql("l.");
    const hit = db.prepare(`SELECT l.id FROM ledger_entries l WHERE l.companion_id != 'gaia' AND l.state IN ('open','kept') AND ${sql}`).all();
    expect(hit).toEqual([]);
  });
});
