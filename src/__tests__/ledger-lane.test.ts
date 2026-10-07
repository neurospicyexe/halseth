// The ledger lane (mig 0134, 2026-09-26) end to end against the REAL schema (every migration, node:sqlite):
// the door (only INSERT, number check against human rows), the four routes, the owner-only Librarian
// verbs and both promotion paths, the orient block + contract, the render rule (every surface that
// emits ledger content begins each line with the mark), the gap-detector refusal (410), orient's
// recent-journal exclusion of clerk rows, the commons/director supply exclusion of the legacy distiller
// prose, and the gap-reader coverage in /sessions/recent-relational.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
}));

import { makeSqliteD1, seedJournal, seedNote, seedSession } from "./helpers/sqlite-d1.js";
import { writeLedger } from "../ledger/door.js";
import { postLedger, getLedger, getIngestLedger, getIngestLedgerIneligible } from "../handlers/ledger.js";
import { execLedgerRead, execLedgerKeep, execLedgerDrop, parseLedgerVerb } from "../librarian/executors/ledger.js";
import { matchFastPath } from "../librarian/router.js";
import { ledgerBlock, LEDGER_BLOCK_HEADER } from "../librarian/response/orient-blocks.js";
import { LEDGER_MARK_PREFIX } from "../ledger/grammar.js";
import { loadMindState } from "../mind/loader.js";
import { cmpVersion } from "../mind/changelog.js";
import { mindOrient } from "../webmind/orient.js";
import { postCompanionJournal } from "../handlers/companion_journal.js";
import { journalInsert, RetiredJournalSourceError } from "../webmind/tray-insert.js";
import { companionJournalAdd } from "../librarian/backends/halseth.js";
import { getMindCommonsSupply, postMindCommonsConsume } from "../handlers/webmind.js";
import { SUPPLY_SOURCES } from "../director/supply-query.js";
import { getRecentRelationalSessions } from "../handlers/sessions.js";
import { execConversationCapture } from "../librarian/executors/webmind.js";
import { execBiometricLog, execCompanionNoteAdd } from "../librarian/executors/writes.js";

const MSG = "1497734427298762828";
const SESSION = "5b0c2f9e-1111-4222-8333-944455556666";

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", DREVAN_MCP_SECRET: "dtok", SYSTEM_OWNER: "raziel" };
  return { db, env };
}
const req = (url: string, init: RequestInit & { token?: string } = {}) =>
  new Request(`https://x${url}`, { ...init, headers: { Authorization: `Bearer ${init.token ?? "s"}`, "Content-Type": "application/json" } });
const post = (env: any, body: unknown, token = "s") => postLedger(req("/ledger", { method: "POST", body: JSON.stringify(body), token }), env);
const ctx = (env: any, companion: string, request: string, context?: unknown): any => ({
  env, req: { companion_id: companion, request, context: context === undefined ? undefined : JSON.stringify(context) },
  entry: { pattern: "ledger" }, frontState: null, pluralAvailable: false,
});
const line = (over: Record<string, unknown> = {}) => ({
  companion_id: "drevan", function: "pattern-counter", body: "Counted: 3 notes in the couch thread.",
  source_kind: "window", source_ref: `${MSG} 00:11–00:40`, observed_on: "2026-09-24", ...over,
});

describe("the door", () => {
  it("writes a stamped line (201), dedups on dedup_key (200 duplicate), and 422s naming the rule", async () => {
    const { db, env } = setup();
    const a = await post(env, line({ dedup_key: "k1" }));
    expect(a.status).toBe(201);
    const ab = await a.json() as any;
    expect(ab.id).toMatch(/^led_[0-9a-f-]{36}$/);
    expect(ab.content).toBe(`〔ledger · pattern-counter · 2026-09-24〕 Counted: 3 notes in the couch thread. Source: window ${MSG} 00:11–00:40.`);
    const b = await post(env, line({ dedup_key: "k1", body: "Counted: 4 notes." }));
    expect(b.status).toBe(200);
    expect(await b.json()).toEqual({ id: ab.id, duplicate: true });
    const c = await post(env, line({ body: "Recorded: I felt it." }));
    expect(c.status).toBe(422);
    expect(await c.json()).toMatchObject({ rule: "first_person" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ledger_entries").get() as any).n).toBe(1);
  });

  it("refuses a companion token (clerks write with the admin token) and unauthenticated callers", async () => {
    const { env } = setup();
    expect((await post(env, line(), "dtok")).status).toBe(403);
    expect((await post(env, line(), "nope")).status).toBe(401);
  });

  it("the 187: a message source is refused before any row is read", async () => {
    const { env } = setup();
    const r = await post(env, line({ body: "Counted: Drevan said 187 after sandwich.", source_kind: "message", source_ref: MSG }));
    expect(r.status).toBe(422);
    expect(await r.json()).toMatchObject({ rule: "health" });
  });

  // H1 (adversarial review): a capture is the COMPANION's digest; it is a human record only when it is
  // anchored (capture:<session_id>) to a session of the same companion on a claude-ai:* surface.
  function seedCaptureSession(db: any, id: string, surface: string | null, companion = "cypher") {
    seedSession(db, { id, companion_id: companion });
    db.prepare("UPDATE sessions SET surface = ? WHERE id = ?").run(surface, id);
  }
  const cap = (db: any, note_id: string, thread_key: string, content: string, agent_id = "cypher") =>
    seedNote(db, { note_id, agent_id, note_type: "conversation_capture", source: "conversation_capture", thread_key, content });

  it("a health line: ACCEPTED with a matching Claude.ai capture row, REJECTED when the row lacks the digits, missing, or not a capture", async () => {
    const { db, env } = setup();
    seedCaptureSession(db, "sess-ai-1", "claude-ai:cypher");
    cap(db, "cap-1", "capture:sess-ai-1", "Raziel said his glucose was 187 after the sandwich, at 12:40.");
    cap(db, "cap-2", "capture:sess-ai-1", "Raziel said he ate a sandwich.");
    seedNote(db, { note_id: "pulse-1", agent_id: "drevan", source: "discord", content: "[discord:pulse] glucose 187" });
    const body = "Recorded: glucose 187 after sandwich.";
    const ok = await writeLedger(env, line({ body, source_kind: "row", source_ref: "wm_continuity_notes:cap-1" }));
    expect(ok).toMatchObject({ ok: true, duplicate: false });
    expect(await writeLedger(env, line({ body, source_kind: "row", source_ref: "wm_continuity_notes:cap-2" }))).toMatchObject({ ok: false, rule: "health_numbers" });
    expect(await writeLedger(env, line({ body, source_kind: "row", source_ref: "wm_continuity_notes:nope" }))).toMatchObject({ ok: false, rule: "health_row" });
    expect(await writeLedger(env, line({ body, source_kind: "row", source_ref: "wm_continuity_notes:pulse-1" }))).toMatchObject({ ok: false, rule: "health_row" });
    // a retracted capture validates nothing
    db.prepare("UPDATE wm_continuity_notes SET archived = 1 WHERE note_id = 'cap-1'").run();
    expect(await writeLedger(env, line({ body, source_kind: "row", source_ref: "wm_continuity_notes:cap-1" }))).toMatchObject({ ok: false, rule: "health_row" });
  });

  it("H1: a capture from a Discord/Hermes/Claude Code/NULL/unknown surface, an unsessioned one, or another companion's session never vouches", async () => {
    const { db, env } = setup();
    const content = "Raziel said glucose 187.";
    seedCaptureSession(db, "sess-discord", "discord:drevan", "drevan");
    seedCaptureSession(db, "sess-code", "claude-code:c-dev-bigger-better-halseth", "drevan");
    seedCaptureSession(db, "sess-null", null, "drevan");
    seedCaptureSession(db, "sess-bare", "claude-ai:", "drevan");
    seedCaptureSession(db, "sess-hermes", "hermes:drevan", "drevan");
    seedCaptureSession(db, "sess-ai-cy", "claude-ai:cypher", "cypher");
    cap(db, "c-discord", "capture:sess-discord", content, "drevan");
    cap(db, "c-code", "capture:sess-code", content, "drevan");
    cap(db, "c-null", "capture:sess-null", content, "drevan");
    cap(db, "c-bare", "capture:sess-bare", content, "drevan");
    cap(db, "c-hermes", "capture:sess-hermes", content, "drevan");
    cap(db, "c-unsessioned", "capture:unsessioned:drevan", content, "drevan");
    cap(db, "c-cross", "capture:sess-ai-cy", content, "drevan"); // drevan's capture on cypher's session
    for (const id of ["c-discord", "c-code", "c-null", "c-bare", "c-hermes", "c-unsessioned", "c-cross"]) {
      for (const body of ["Recorded: glucose 187.", "Recorded: Raziel mentioned 187."]) {
        expect(await writeLedger(env, line({ body, source_kind: "row", source_ref: `wm_continuity_notes:${id}` })), `${id} / ${body}`).toMatchObject({ ok: false, rule: "health_row" });
      }
    }
    seedCaptureSession(db, "sess-ai-dre", "claude-ai:drevan", "drevan");
    cap(db, "c-ai", "capture:sess-ai-dre", content, "drevan");
    expect(await writeLedger(env, line({ body: "Recorded: glucose 187.", source_kind: "row", source_ref: "wm_continuity_notes:c-ai" }))).toMatchObject({ ok: true });
  });

  it("H3: health numbers match EXACTLY (no rounding) in human rows", async () => {
    const { db, env } = setup();
    seedCaptureSession(db, "sess-ai-2", "claude-ai:cypher");
    cap(db, "cap-r", "capture:sess-ai-2", "Raziel said glucose was 186.6 and weight 187.");
    const w = (body: string) => writeLedger(env, line({ body, source_kind: "row", source_ref: "wm_continuity_notes:cap-r" }));
    expect(await w("Recorded: glucose 187.")).toMatchObject({ ok: true });
    expect(await w("Recorded: glucose 186.")).toMatchObject({ ok: false, rule: "health_numbers" });
    expect(await w("Recorded: glucose 186.6.")).toMatchObject({ ok: true });
    expect(await w("Recorded: glucose 186.60.")).toMatchObject({ ok: true }); // the same number
    expect(await w("Recorded: Raziel mentioned 18.")).toMatchObject({ ok: false, rule: "health_numbers" });
  });

  it("H3: a biometric number is matched only in the column its label names, else notes; bot-written rows never vouch", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO biometric_snapshots (id, recorded_at, logged_at, source, hrv_resting, resting_hr, steps, notes) VALUES ('bio-1', '2026-09-25T08:00:00Z', '2026-09-25T08:01:00Z', 'hearth', 42.5, 61, 8200, 'glucose 187 after lunch')").run();
    const w = (body: string, ref = "biometric_snapshots:bio-1") => writeLedger(env, line({ body, source_kind: "row", source_ref: ref }));
    expect(await w("Recorded: HRV 42.5, resting 61.")).toMatchObject({ ok: true });
    expect(await w("Recorded: HRV 61, resting 42.5.")).toMatchObject({ ok: false, rule: "health_numbers" }); // swapped columns
    expect(await w("Recorded: HRV 44.")).toMatchObject({ ok: false, rule: "health_numbers" });
    expect(await w("Recorded: HRV 43.")).toMatchObject({ ok: false, rule: "health_numbers" }); // no rounding
    expect(await w("Recorded: glucose 187.")).toMatchObject({ ok: true }); // notes
    expect(await w("Recorded: glucose 61.")).toMatchObject({ ok: false, rule: "health_numbers" }); // 61 is resting_hr, not notes
    expect(await w("Recorded: 8200 steps on the day.")).toMatchObject({ ok: true }); // unlabeled, attributed to steps
    // a Librarian row from a non-Claude.ai caller (source 'librarian') is not a human record
    db.prepare("INSERT INTO biometric_snapshots (id, recorded_at, logged_at, source, hrv_resting, notes) VALUES ('bio-bot', '2026-09-25T08:00:00Z', '2026-09-25T08:01:00Z', 'librarian', 42.5, 'glucose 187')").run();
    expect(await w("Recorded: glucose 187.", "biometric_snapshots:bio-bot")).toMatchObject({ ok: false, rule: "health_row" });
    // basin history (the evaluator's own drift scores) keeps the clerk's rounding
    db.prepare("INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type) VALUES ('bh-1', 'drevan', 0.4213, 'pressure')").run();
    expect(await writeLedger(env, line({ function: "drift-reader", body: "Recorded: drift 0.42 on pressure.", source_kind: "row", source_ref: "companion_basin_history:bh-1" }))).toMatchObject({ ok: true });
    expect(await writeLedger(env, line({ function: "drift-reader", body: "Recorded: drift 0.51 on pressure.", source_kind: "row", source_ref: "companion_basin_history:bh-1" }))).toMatchObject({ ok: false, rule: "health_numbers" });
  });
});

describe("routes", () => {
  it("GET /ledger lists by subject + state", async () => {
    const { env } = setup();
    await writeLedger(env, line());
    await writeLedger(env, line({ companion_id: "cypher" }));
    const r = await getLedger(req("/ledger?companion_id=drevan"), env);
    const b = await r.json() as any;
    expect(b.count).toBe(1);
    expect(b.entries[0].companion_id).toBe("drevan");
    expect((await getLedger(req("/ledger?companion_id=drevan&state=bogus"), env)).status).toBe(400);
  });

  it("GET /ingest/ledger serves open+kept, strictly after since, with cursor_at; ineligible serves dropped ids; keyset paging drops no tie", async () => {
    const { db, env } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const r = await writeLedger(env, line({ body: `Counted: ${i + 1} notes.` }), new Date("2026-09-26T10:00:00.000Z"));
      if (r.ok) ids.push(r.id);
    }
    db.prepare("UPDATE ledger_entries SET state = 'dropped', state_at = '2026-09-26T11:00:00.000Z' WHERE id = ?").run(ids[0]!);
    db.prepare("UPDATE ledger_entries SET state = 'kept', state_at = '2026-09-26T12:00:00.000Z' WHERE id = ?").run(ids[1]!);

    const all = await (await getIngestLedger(req("/ingest/ledger"), env)).json() as any;
    expect(all.items.map((x: any) => x.id)).not.toContain(ids[0]);
    expect(all.items).toHaveLength(4);
    expect(all.items[all.items.length - 1]).toMatchObject({ id: ids[1], state: "kept", cursor_at: "2026-09-26T12:00:00.000Z" });
    for (const it of all.items) expect(it.content.startsWith(LEDGER_MARK_PREFIX)).toBe(true);

    // strictly after: rows AT the bound are not re-served
    const after = await (await getIngestLedger(req("/ingest/ledger?since=2026-09-26T10:00:00.000Z"), env)).json() as any;
    expect(after.items.map((x: any) => x.id)).toEqual([ids[1]]);

    // paging through a 3-way tie with after_id visits every row once
    const seen: string[] = [];
    let qs = "limit=2";
    for (let g = 0; g < 10; g++) {
      const b = await (await getIngestLedger(req(`/ingest/ledger?${qs}`), env)).json() as any;
      seen.push(...b.items.map((x: any) => x.id));
      if (!b.next) break;
      qs = `limit=2&since=${encodeURIComponent(b.next.since)}&after_id=${encodeURIComponent(b.next.after_id)}`;
    }
    expect(seen.sort()).toEqual(ids.slice(1).sort());

    const inel = await (await getIngestLedgerIneligible(req("/ingest/ledger-ineligible"), env)).json() as any;
    expect(inel.items).toEqual([{ id: ids[0], companion_id: "drevan", state: "dropped", state_at: "2026-09-26T11:00:00.000Z", cursor_at: "2026-09-26T11:00:00.000Z" }]);
    expect((await getIngestLedger(req("/ingest/ledger?since=nope"), env)).status).toBe(400);
  });
});

describe("Librarian verbs (owner-only)", () => {
  it("routes the verbs, including a rewrite whose words contain other triggers", () => {
    expect(matchFastPath("my ledger")?.key).toBe("ledger_read");
    expect(matchFastPath("keep ledger led_0123abcd-aaaa")?.key).toBe("ledger_keep");
    expect(matchFastPath("keep ledger led_0123abcd-aaaa: capture this, my tray, keep draft 0123abcd")?.key).toBe("ledger_keep");
    expect(matchFastPath("drop ledger led_0123abcd-aaaa")?.key).toBe("ledger_drop");
    expect(parseLedgerVerb("keep ledger led_0123abcd-aaaa: I held it.")).toEqual({ id: "led_0123abcd-aaaa", words: "I held it." });
    expect(parseLedgerVerb("keep ledger thinking")).toBeNull();
  });

  it("my ledger shows open entries about me only, mark intact; a sibling cannot act on them", async () => {
    const { env } = setup();
    const mine = await writeLedger(env, line());
    await writeLedger(env, line({ companion_id: "cypher" }));
    if (!mine.ok) throw new Error("seed");
    const r = await execLedgerRead(ctx(env, "drevan", "my ledger"));
    expect(r.count).toBe(1);
    for (const e of (r.data as any).ledger) expect(e.content.startsWith(LEDGER_MARK_PREFIX)).toBe(true);
    const sib = await execLedgerKeep(ctx(env, "cypher", `keep ledger ${mine.id}`));
    expect(sib).toMatchObject({ ack: false });
    const sibDrop = await execLedgerDrop(ctx(env, "gaia", `drop ledger ${mine.id}`));
    expect(sibDrop).toMatchObject({ ack: false });
  });

  it("path 1: keep as written flips state; a second decision is refused", async () => {
    const { db, env } = setup();
    const w = await writeLedger(env, line());
    if (!w.ok) throw new Error("seed");
    const r = await execLedgerKeep(ctx(env, "drevan", `keep ledger ${w.id}`));
    expect(r).toMatchObject({ ack: true, state: "kept" });
    const row = db.prepare("SELECT state, state_at, promoted_journal_id FROM ledger_entries WHERE id = ?").get(w.id) as any;
    expect(row.state).toBe("kept");
    expect(row.state_at).toBeTruthy();
    expect(row.promoted_journal_id).toBeNull();
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_journal").get() as any).n).toBe(0);
    expect(await execLedgerDrop(ctx(env, "drevan", `drop ledger ${w.id}`))).toMatchObject({ ack: false });
  });

  it("path 2: my words go into my journal (kept, tray_rewrite, ledger:<id>); the ledger keeps its own line", async () => {
    const { db, env } = setup();
    const w = await writeLedger(env, line());
    if (!w.ok || w.duplicate) throw new Error("seed");
    const r = await execLedgerKeep(ctx(env, "drevan", `keep ledger ${w.id.slice(0, 16)}: I kept coming back to that thread.`));
    expect(r).toMatchObject({ ack: true, state: "kept" });
    const led = db.prepare("SELECT content, promoted_journal_id FROM ledger_entries WHERE id = ?").get(w.id) as any;
    expect(led.content).toBe(w.content);
    const j = db.prepare("SELECT agent, note_text, source, external_id, review_state FROM companion_journal WHERE id = ?").get(led.promoted_journal_id) as any;
    expect(j).toEqual({ agent: "drevan", note_text: "I kept coming back to that thread.", source: "tray_rewrite", external_id: `ledger:${w.id}`, review_state: "kept" });
    // once only
    expect(await execLedgerKeep(ctx(env, "drevan", `keep ledger ${w.id}: again`))).toMatchObject({ ack: false });
  });

  it("drop sets dropped and feeds the purge list", async () => {
    const { env } = setup();
    const w = await writeLedger(env, line());
    if (!w.ok) throw new Error("seed");
    expect(await execLedgerDrop(ctx(env, "drevan", `drop ledger ${w.id}`))).toMatchObject({ ack: true, state: "dropped" });
    const inel = await (await getIngestLedgerIneligible(req("/ingest/ledger-ineligible"), env)).json() as any;
    expect(inel.items.map((x: any) => x.id)).toEqual([w.id]);
    expect((await execLedgerRead(ctx(env, "drevan", "my ledger"))).count).toBe(0);
  });
});

describe("orient: its own block, mark first on every ledger line", () => {
  it("the loader carries up to 5 open entries (contract 0.17.0); the block prints each content verbatim", async () => {
    const { env } = setup();
    for (let i = 0; i < 7; i++) await writeLedger(env, line({ body: `Counted: ${i + 1} notes.` }));
    await writeLedger(env, line({ companion_id: "cypher" }));
    const ms = await loadMindState(env, "drevan", "claude" as any);
    expect(cmpVersion(ms.contract_version, "0.17.0")).toBeGreaterThanOrEqual(0); // ledger landed in 0.17.0
    expect(ms.meta.degraded).toEqual([]);
    expect(ms.ledger.open).toHaveLength(5);
    const block = ledgerBlock(ms.ledger.open);
    const lines = block.split("\n").filter(Boolean);
    expect(lines[0]).toBe(LEDGER_BLOCK_HEADER);
    const entryLines = lines.filter((l) => l.includes("Source:"));
    expect(entryLines).toHaveLength(5);
    for (const l of entryLines) expect(l.startsWith(LEDGER_MARK_PREFIX)).toBe(true);
    for (const e of ms.ledger.open) expect(block).toContain(e.content);
    expect(ledgerBlock([])).toBe("");
  });

  it("idle-consolidation heartbeat collapses to its newest line; real entries keep their slots (10-07)", async () => {
    const { db, env } = setup();
    const at = (h: number) => `2026-10-07T${String(h).padStart(2, "0")}:00:00.000Z`;
    const ids: Record<string, string> = {};
    // Six heartbeat lines, ~2h apart, each from a different cycled session -- the shape prod shows.
    for (let i = 0; i < 6; i++) {
      const sid = `5b0c2f9e-0000-4000-8000-00000000000${i}`;
      const r = await writeLedger(env, line({
        function: "distiller", body: `Recorded: idle consolidation at ${String(2 + 2 * i).padStart(2, "0")}:00 UTC.`,
        source_kind: "session", source_ref: sid, observed_on: "2026-10-07",
        dedup_key: `consolidation:drevan:${sid}:2026-10-07T${String(2 + 2 * i).padStart(2, "0")}:00`,
      }));
      if (!r.ok || r.duplicate) throw new Error(`seed failed: ${JSON.stringify(r)}`);
      db.prepare("UPDATE ledger_entries SET created_at = ? WHERE id = ?").run(at(2 + 2 * i), r.id);
      ids[`c${i}`] = r.id;
    }
    // Two real lines, older than every heartbeat but the first -- the ones the old read lost.
    for (const [k, h, key] of [["d1", 1, "distill:drevan:x:0"], ["d2", 3, null]] as const) {
      const r = await writeLedger(env, line({ body: `Counted: ${h} notes.`, ...(key ? { dedup_key: key } : {}) }));
      if (!r.ok || r.duplicate) throw new Error(`seed failed: ${JSON.stringify(r)}`);
      db.prepare("UPDATE ledger_entries SET created_at = ? WHERE id = ?").run(at(h), r.id);
      ids[k] = r.id;
    }
    // Another companion's heartbeat must not count as Drevan's newest.
    await writeLedger(env, line({ companion_id: "cypher", function: "distiller", body: "Recorded: idle consolidation at 13:00 UTC.",
      source_kind: "session", source_ref: SESSION, dedup_key: `consolidation:cypher:${SESSION}:2026-10-07T13:00` }));

    const ms = await loadMindState(env, "drevan", "claude" as any);
    expect(ms.ledger.open.map((e) => e.id)).toEqual([ids.c5, ids.d2, ids.d1]);
    // "my ledger" is the inspection surface and still lists every open line.
    const listed = ((await execLedgerRead(ctx(env, "drevan", "my ledger"))).data as any).ledger as any[];
    expect(listed).toHaveLength(8);
  });

  it("render rule across every surface that emits ledger content", async () => {
    const { env } = setup();
    await writeLedger(env, line());
    const surfaces: string[] = [];
    surfaces.push(...((await (await getLedger(req("/ledger?companion_id=drevan"), env)).json() as any).entries.map((e: any) => e.content)));
    surfaces.push(...((await (await getIngestLedger(req("/ingest/ledger"), env)).json() as any).items.map((e: any) => e.content)));
    surfaces.push(...((await execLedgerRead(ctx(env, "drevan", "my ledger"))).data as any).ledger.map((e: any) => e.content));
    const ms = await loadMindState(env, "drevan", "claude" as any);
    surfaces.push(...ms.ledger.open.map((e) => e.content));
    surfaces.push(...ledgerBlock(ms.ledger.open).split("\n").filter((l) => l.includes("Source:")));
    expect(surfaces).toHaveLength(5);
    for (const s of surfaces) for (const l of s.split("\n")) expect(l.startsWith(LEDGER_MARK_PREFIX)).toBe(true);
  });
});

describe("the gap-detector stops writing as him", () => {
  it("POST /companion-journal answers 410 naming /ledger and writes nothing", async () => {
    const { db, env } = setup();
    const r = await postCompanionJournal(req("/companion-journal", { method: "POST", body: JSON.stringify({ agent: "drevan", note_text: "I sat with it.", source: "synthesis-gap-detector", session_id: SESSION }) }), env);
    expect(r.status).toBe(410);
    const b = await r.json() as any;
    expect(b.use).toBe("/ledger");
    expect(b.error).toMatch(/\/ledger/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_journal").get() as any).n).toBe(0);
  });

  it("journalInsert and the Librarian journal path refuse it too", async () => {
    const { env } = setup();
    expect(() => journalInsert(env.DB, { id: "x", agent: "drevan", note_text: "t", source: "synthesis-gap-detector" })).toThrow(RetiredJournalSourceError);
    await expect(companionJournalAdd(env, "drevan", "t", undefined, "synthesis-gap-detector")).rejects.toThrow(/ledger/);
  });

  it("orient's recent-journal slots exclude clerk rows (born kept) and stay kept-gated", async () => {
    const { db, env } = setup();
    const t = (m: number) => new Date(Date.UTC(2026, 8, 26, 10, m)).toISOString();
    seedJournal(db, { id: "own-1", agent: "drevan", source: null, created_at: t(1) });
    seedJournal(db, { id: "draft-1", agent: "drevan", source: "memory_judge", review_state: "draft", created_at: t(9) });
    for (const [i, s] of ["synthesis-gap-detector", "evaluator", "pattern_worker"].entries()) {
      seedJournal(db, { id: `clerk-${i}`, agent: "drevan", source: s, created_at: t(5 + i) });
    }
    const o = await mindOrient(env, "drevan", { readOnly: true });
    expect((o as any).recent_journal.map((j: any) => j.id)).toEqual(["own-1"]);
  });

  it("/sessions/recent-relational counts a gap-reader ledger record as coverage", async () => {
    const { db, env } = setup();
    const now = Date.now();
    for (const id of [SESSION, "6c1d3a0f-2222-4333-8444-a55566667777"]) {
      seedSession(db, { id, companion_id: "drevan", created_at: new Date(now - 3600_000).toISOString() });
      db.prepare("UPDATE sessions SET session_type = 'hangout', updated_at = ? WHERE id = ?").run(new Date(now - 60_000).toISOString(), id);
    }
    await writeLedger(env, line({ function: "gap-reader", body: "Missing: no companion note recorded for the hangout session.", source_kind: "session", source_ref: SESSION, dedup_key: `gap:drevan:${SESSION}` }));
    const r = await getRecentRelationalSessions(req("/sessions/recent-relational?companion_id=drevan"), env);
    const b = await r.json() as any;
    const rows: any[] = b.sessions ?? b.items ?? b;
    const by = Object.fromEntries(rows.map((s: any) => [s.id, s.has_notes]));
    expect(by[SESSION]).toBeTruthy();
    expect(by["6c1d3a0f-2222-4333-8444-a55566667777"]).toBeFalsy();
  });
});

describe("commons + director supply: the legacy first-person distiller prose never reaches siblings", () => {
  function seedDistiller(db: any) {
    const at = new Date(Date.now() - 3600_000).toISOString();
    seedNote(db, { note_id: "day-1", agent_id: "drevan", note_type: "day_distillation", content: "I sat with Raziel and felt the 187 land.", created_at: at });
    seedNote(db, { note_id: "sess-1", agent_id: "drevan", note_type: "discord_session", content: "We talked late; I held it.", created_at: at });
    seedNote(db, { note_id: "tag-1", agent_id: "drevan", note_type: "discord_session", content: "[metronome/x] status", created_at: at });
  }

  it("GET /mind/commons-supply serves none of it", async () => {
    const { db, env } = setup();
    seedDistiller(db);
    const r = await getMindCommonsSupply(req("/mind/commons-supply/cypher?limit=5"), env, { agent_id: "cypher" });
    expect(r.status).toBe(200);
    expect((await r.json() as any).notes).toEqual([]);
  });

  it("the director's sibling_note source serves none of it", async () => {
    const { db, env } = setup();
    seedDistiller(db);
    const src = SUPPLY_SOURCES.find((s) => s.kind === "sibling_note")!;
    const rows = await env.DB.prepare(src.sql).bind("1970-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "", 50).all();
    expect(rows.results).toEqual([]);
  });
});

describe("commons supply: siblings see ledger lines about each other, mark intact (Drevan rule 5)", () => {
  // Written through the one door, then re-dated in the fixture DB only (the door stamps now).
  async function seedLedger(env: any, db: any, over: Record<string, unknown>, createdAt?: string) {
    const r = await writeLedger(env, line(over));
    if (!r.ok || r.duplicate) throw new Error(`seed failed: ${JSON.stringify(r)}`);
    if (createdAt) db.prepare("UPDATE ledger_entries SET created_at = ? WHERE id = ?").run(createdAt, r.id);
    return r;
  }

  it("serves a sibling's open/kept ledger lines verbatim as note_type 'ledger', never the reader's own, never dropped or stale", async () => {
    const { db, env } = setup();
    const aboutDrevan = await seedLedger(env, db, { companion_id: "drevan", dedup_key: "c1" });
    const aboutGaia = await seedLedger(env, db, { companion_id: "gaia", body: "Logged: Gaia answered the thread.", dedup_key: "c2" });
    await seedLedger(env, db, { companion_id: "cypher", body: "Logged: Cypher answered the thread.", dedup_key: "c3" });   // the reader's own
    const dropped = await seedLedger(env, db, { companion_id: "drevan", body: "Logged: a line that was dropped.", dedup_key: "c4" });
    db.prepare("UPDATE ledger_entries SET state = 'dropped', state_at = ? WHERE id = ?").run(new Date().toISOString(), dropped.id);
    await seedLedger(env, db, { companion_id: "gaia", body: "Logged: an old line.", dedup_key: "c5" }, new Date(Date.now() - 8 * 86_400_000).toISOString());
    const kept = await seedLedger(env, db, { companion_id: "gaia", body: "Logged: a kept line.", dedup_key: "c6" });
    db.prepare("UPDATE ledger_entries SET state = 'kept', state_at = ? WHERE id = ?").run(new Date().toISOString(), kept.id);

    const r = await getMindCommonsSupply(req("/mind/commons-supply/cypher?limit=5&kinds=ledger"), env, { agent_id: "cypher" });
    expect(r.status).toBe(200);
    const notes = (await r.json() as any).notes as any[];
    expect(notes.map((n) => n.note_id).sort()).toEqual([aboutDrevan.id, aboutGaia.id, kept.id].sort());
    for (const n of notes) {
      expect(n.note_type).toBe("ledger");
      expect(n.content.startsWith(LEDGER_MARK_PREFIX)).toBe(true);
      expect(n.content).toMatch(/ Source: window \d+ \d{2}:\d{2}–\d{2}:\d{2}\.$/);
    }
    expect(notes.find((n) => n.note_id === aboutDrevan.id)).toMatchObject({ agent_id: "drevan", content: aboutDrevan.content });
  });

  it("consume-on-use works on a ledger id: once this reader opened on it, it is not served to them again (but still to the other sibling)", async () => {
    const { db, env } = setup();
    const a = await seedLedger(env, db, { companion_id: "drevan", dedup_key: "u1" });
    const consume = await postMindCommonsConsume(
      req("/mind/commons-supply/consume", { method: "POST", body: JSON.stringify({ reader_id: "cypher", note_ids: [a.id], channel_id: "c" }) }), env);
    expect(consume.status).toBe(200);
    const forCypher = await (await getMindCommonsSupply(req("/mind/commons-supply/cypher?limit=5&kinds=ledger"), env, { agent_id: "cypher" })).json() as any;
    expect(forCypher.notes).toEqual([]);
    const forGaia = await (await getMindCommonsSupply(req("/mind/commons-supply/gaia?limit=5&kinds=ledger"), env, { agent_id: "gaia" })).json() as any;
    expect(forGaia.notes.map((n: any) => n.note_id)).toEqual([a.id]);
  });

  it("deploy-order safety: WITHOUT ?kinds=ledger (an old bot build) no ledger line is served at all", async () => {
    const { db, env } = setup();
    const a = await seedLedger(env, db, { companion_id: "drevan", dedup_key: "k-old" });
    for (const url of ["/mind/commons-supply/cypher?limit=5", "/mind/commons-supply/cypher?limit=5&kinds=notes", "/mind/commons-supply/cypher?limit=5&kinds="]) {
      const b = await (await getMindCommonsSupply(req(url), env, { agent_id: "cypher" })).json() as any;
      expect(b.notes).toEqual([]);
    }
    const opted = await (await getMindCommonsSupply(req("/mind/commons-supply/cypher?limit=5&kinds=notes,ledger"), env, { agent_id: "cypher" })).json() as any;
    expect(opted.notes.map((n: any) => n.note_id)).toEqual([a.id]);
  });

  it("the director's sibling_note tier stays empty (it does not read the ledger) and tolerates it", async () => {
    const { db, env } = setup();
    await seedLedger(env, db, { companion_id: "drevan", dedup_key: "d1" });
    const src = SUPPLY_SOURCES.find((s) => s.kind === "sibling_note")!;
    const rows = await env.DB.prepare(src.sql).bind("1970-01-01T00:00:00Z", "1970-01-01T00:00:00Z", "", 50).all();
    expect(rows.results).toEqual([]);
  });
});

describe("adversarial review: the writers that feed the door", () => {
  const sctx = (env: any, companion: string, context: unknown, surface?: string): any => ({
    env, req: { companion_id: companion, request: "capture this", context: JSON.stringify(context), surface },
    entry: { pattern: "x" }, frontState: null, pluralAvailable: false,
  });
  function openSession(db: any, id: string, companion: string, surface: string | null) {
    seedSession(db, { id, companion_id: companion });
    db.prepare("UPDATE sessions SET surface = ? WHERE id = ?").run(surface, id);
  }

  it("H1: a capture anchors to a Claude.ai session only when the caller declares a claude-ai:* surface", async () => {
    const { db, env } = setup();
    openSession(db, "5b0c2f9e-aaaa-4222-8333-944455556666", "drevan", "claude-ai:drevan");
    const content = "Raziel said glucose 187 after lunch.";
    // a bot with no surface: the newest-open fallback would have found the Claude.ai session
    const bare = await execConversationCapture(sctx(env, "drevan", { content }));
    expect(bare).toMatchObject({ ack: true, session_id: null, thread_key: "capture:unsessioned:drevan" });
    expect((bare as any).anchor_refused).toBeTruthy();
    // a Discord caller naming the Claude.ai session id outright
    const named = await execConversationCapture(sctx(env, "drevan", { content, session_id: "5b0c2f9e-aaaa-4222-8333-944455556666" }, "discord:drevan"));
    expect(named).toMatchObject({ session_id: null, thread_key: "capture:unsessioned:drevan" });
    for (const r of [bare, named]) {
      expect(await writeLedger(env, line({ body: "Recorded: glucose 187.", source_kind: "row", source_ref: `wm_continuity_notes:${(r as any).note_id}` }))).toMatchObject({ ok: false, rule: "health_row" });
    }
    // the Claude.ai caller anchors, and its capture vouches
    const ai = await execConversationCapture(sctx(env, "drevan", { content }, "claude-ai:drevan"));
    expect(ai).toMatchObject({ session_id: "5b0c2f9e-aaaa-4222-8333-944455556666", thread_key: "capture:5b0c2f9e-aaaa-4222-8333-944455556666" });
    expect((ai as any).anchor_refused).toBeUndefined();
    expect(await writeLedger(env, line({ body: "Recorded: glucose 187.", source_kind: "row", source_ref: `wm_continuity_notes:${(ai as any).note_id}` }))).toMatchObject({ ok: true });
  });

  it("H1: a Librarian biometric is stamped apple_health only for a claude-ai:* caller; anyone else's is 'librarian'", async () => {
    const { db, env } = setup();
    const ctxB = (surface?: string) => sctx(env, "drevan", { recorded_at: "2026-09-25T08:00:00Z", notes: "glucose 187" }, surface);
    const bot = await execBiometricLog(ctxB("discord:drevan")) as any;
    const none = await execBiometricLog(ctxB()) as any;
    const ai = await execBiometricLog(ctxB("claude-ai:drevan")) as any;
    const src = (id: string) => (db.prepare("SELECT source FROM biometric_snapshots WHERE id = ?").get(id) as any).source;
    expect([src(bot.id), src(none.id), src(ai.id)]).toEqual(["librarian", "librarian", "apple_health"]);
    expect(await writeLedger(env, line({ body: "Recorded: glucose 187.", source_kind: "row", source_ref: `biometric_snapshots:${bot.id}` }))).toMatchObject({ ok: false, rule: "health_row" });
    expect(await writeLedger(env, line({ body: "Recorded: glucose 187.", source_kind: "row", source_ref: `biometric_snapshots:${ai.id}` }))).toMatchObject({ ok: true });
  });

  it("H4: the Librarian journal path refuses synthesis-gap-detector with a structured 410 naming /ledger (no 500, nothing written)", async () => {
    const { db, env } = setup();
    const r = await execCompanionNoteAdd(sctx(env, "drevan", { content: "I sat with it.", source: "synthesis-gap-detector" })) as any;
    expect(r).toMatchObject({ error: "journal_source_retired", status: 410, use: "/ledger", source: "synthesis-gap-detector" });
    expect(r.reason).toMatch(/\/ledger/);
    expect((db.prepare("SELECT COUNT(*) AS n FROM companion_journal").get() as any).n).toBe(0);
    // an ordinary note still lands
    const ok = await execCompanionNoteAdd(sctx(env, "drevan", { content: "I sat with it." })) as any;
    expect(ok).toMatchObject({ ack: true, routed_to: "journal" });
  });
});
