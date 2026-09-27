// POST /admin/retract reaches the ledger lane (2026-09-26 last fix pass), against the REAL schema
// (every migration, node:sqlite).
//
// A retracted Discord message is a source that no longer stands. Every OPEN or KEPT clerk line that
// points at it -- a `message` source naming it, or a `window` source on its channel whose HH:MM range
// covers its snowflake time -- is dropped, so it leaves recall and reaches /ingest/ledger-ineligible
// (Second Brain purges the chunk). Kept rows drop too (a retraction outranks a keep); promoted rows are
// reported with their journal id and the journal row (the owner's own words) is left alone.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
}));

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { writeLedger } from "../ledger/door.js";
import { keepLedger, promoteLedger, snowflakeMs, windowCoversMessage } from "../ledger/store.js";
import { parseWindowRef } from "../ledger/grammar.js";
import { adminRetract } from "../handlers/retract.js";
import { getIngestLedgerIneligible } from "../handlers/ledger.js";

const CH = "1497734427298762828";
const OTHER_CH = "1400000000000000001";
const NOW = new Date("2026-09-26T12:00:00Z");

/** The snowflake Discord would mint at `iso` (worker/process/increment bits zero). */
const snow = (iso: string) => ((BigInt(Date.parse(iso)) - 1420070400000n) << 22n).toString();

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
  return { db, env };
}
const retract = (env: any, body: Record<string, unknown>) =>
  adminRetract(new Request("https://x/admin/retract", {
    method: "POST",
    headers: { Authorization: "Bearer s", "Content-Type": "application/json" },
    body: JSON.stringify({ agent: "drevan", reason: "Raziel retracted my reply", ...body }),
  }), env);

async function seed(env: any, over: Record<string, unknown>): Promise<string> {
  const r = await writeLedger(env, {
    companion_id: "drevan", function: "distiller", body: "Logged: Drevan and Raziel spoke in the couch thread.",
    source_kind: "window", source_ref: `${CH} 00:11–00:40`, observed_on: "2026-09-26", ...over,
  } as any, NOW);
  if (!r.ok) throw new Error(`seed refused: ${JSON.stringify(r)}`);
  return (r as any).id;
}
const stateOf = (db: any, id: string) =>
  (db.prepare("SELECT state, state_at, promoted_journal_id FROM ledger_entries WHERE id = ?").get(id) as any);

describe("snowflake + window math", () => {
  it("derives epoch ms from a snowflake with BigInt (19 digits overflow Number)", () => {
    expect(snowflakeMs(snow("2026-09-26T00:15:30Z"))).toBe(Date.parse("2026-09-26T00:15:30Z"));
    expect(snowflakeMs(CH)).toBe(Number((BigInt(CH) >> 22n) + 1420070400000n));
    expect(snowflakeMs("not-a-snowflake")).toBeNull();
  });

  it("parses the stored (normalised) window ref and the raw forms the door accepts", () => {
    expect(parseWindowRef(`${CH} 23:50–00:20`)).toEqual({ channelId: CH, startMin: 23 * 60 + 50, endMin: 20 });
    expect(parseWindowRef(`discord ${CH}, 00:11-00:40`)).toEqual({ channelId: CH, startMin: 11, endMin: 40 });
    expect(parseWindowRef("garbage")).toBeNull();
  });

  it("covers inclusively at minute granularity; cross-midnight runs onto observed_on + 1", () => {
    const at = (iso: string) => Date.parse(iso);
    expect(windowCoversMessage(`${CH} 00:11–00:40`, "2026-09-26", CH, at("2026-09-26T00:40:59Z"))).toBe(true);
    expect(windowCoversMessage(`${CH} 00:11–00:40`, "2026-09-26", CH, at("2026-09-26T00:10:59Z"))).toBe(false);
    expect(windowCoversMessage(`${CH} 00:11–00:40`, "2026-09-25", CH, at("2026-09-26T00:20:00Z"))).toBe(false);
    expect(windowCoversMessage(`${CH} 00:11–00:40`, "2026-09-26", OTHER_CH, at("2026-09-26T00:20:00Z"))).toBe(false);
    // 23:50 on the 25th to 00:20 on the 26th
    expect(windowCoversMessage(`${CH} 23:50–00:20`, "2026-09-25", CH, at("2026-09-25T23:55:00Z"))).toBe(true);
    expect(windowCoversMessage(`${CH} 23:50–00:20`, "2026-09-25", CH, at("2026-09-26T00:10:00Z"))).toBe(true);
    expect(windowCoversMessage(`${CH} 23:50–00:20`, "2026-09-25", CH, at("2026-09-26T00:21:00Z"))).toBe(false);
    expect(windowCoversMessage(`${CH} 23:50–00:20`, "2026-09-25", CH, at("2026-09-25T00:10:00Z"))).toBe(false);
    expect(windowCoversMessage(`${CH} 23:50–00:20`, "2026-09-25", CH, at("2026-09-27T00:10:00Z"))).toBe(false);
  });
});

describe("POST /admin/retract drops ledger rows sourced to the retracted message", () => {
  it("drops a message-sourced row and a covering window; leaves a non-covering window; feeds the SB purge", async () => {
    const { db, env } = setup();
    const msg = snow("2026-09-26T00:15:30Z");
    const byMsg = await seed(env, { function: "seen-log", body: 'Logged: Drevan said "held" in the couch thread.', source_kind: "message", source_ref: msg });
    const covering = await seed(env, {});
    const later = await seed(env, { source_ref: `${CH} 01:00–01:30`, dedup_key: "later" });
    const unrelatedMsg = await seed(env, { source_kind: "message", source_ref: snow("2026-09-26T00:16:00Z"), dedup_key: "u" });

    const res = await retract(env, { external_ids: [`discord:${msg}`], channel_id: CH });
    expect(res.status).toBe(200);
    const b = await res.json() as any;
    expect(b.ledger_dropped).toBe(2);
    expect(new Set(b.ledger_ids)).toEqual(new Set([byMsg, covering]));
    expect(b.ledger_promoted).toEqual([]);
    expect(stateOf(db, byMsg).state).toBe("dropped");
    expect(stateOf(db, byMsg).state_at).toMatch(/^2\d{3}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(stateOf(db, covering).state).toBe("dropped");
    expect(stateOf(db, later).state).toBe("open");
    expect(stateOf(db, unrelatedMsg).state).toBe("open");

    const inel = await (await getIngestLedgerIneligible(new Request("https://x/ingest/ledger-ineligible", { headers: { Authorization: "Bearer s" } }), env)).json() as any;
    expect(new Set(inel.items.map((i: any) => i.id))).toEqual(new Set([byMsg, covering]));
  });

  it("cross-midnight: a window started on the 25th covers a message on the 26th", async () => {
    const { db, env } = setup();
    const w = await seed(env, { source_ref: `${CH} 23:50–00:20`, observed_on: "2026-09-25" });
    const b = await (await retract(env, { external_ids: [`discord:${snow("2026-09-26T00:10:00Z")}`], channel_id: CH })).json() as any;
    expect(b.ledger_dropped).toBe(1);
    expect(stateOf(db, w).state).toBe("dropped");
    // ...and not one past its end
    const { db: db2, env: env2 } = setup();
    const w2 = await seed(env2, { source_ref: `${CH} 23:50–00:20`, observed_on: "2026-09-25" });
    const b2 = await (await retract(env2, { external_ids: [`discord:${snow("2026-09-26T00:21:00Z")}`], channel_id: CH })).json() as any;
    expect(b2.ledger_dropped).toBe(0);
    expect(stateOf(db2, w2).state).toBe("open");
  });

  it("a covering window on a DIFFERENT channel is not touched", async () => {
    const { db, env } = setup();
    const other = await seed(env, { source_ref: `${OTHER_CH} 00:11–00:40` });
    const b = await (await retract(env, { external_ids: [`discord:${snow("2026-09-26T00:15:00Z")}`], channel_id: CH })).json() as any;
    expect(b.ledger_dropped).toBe(0);
    expect(stateOf(db, other).state).toBe("open");
  });

  it("drops KEPT rows (a retraction outranks a keep) and reports PROMOTED rows without touching the journal", async () => {
    const { db, env } = setup();
    const msg = snow("2026-09-26T00:20:00Z");
    const kept = await seed(env, {});
    expect((await keepLedger(env, "drevan", kept)).ok).toBe(true);
    const promoted = await seed(env, { source_kind: "message", source_ref: msg });
    const p = await promoteLedger(env, "drevan", promoted, "we talked on the couch") as any;
    expect(p.ok).toBe(true);

    const b = await (await retract(env, { external_ids: [`discord:${msg}`], channel_id: CH })).json() as any;
    expect(b.ledger_dropped).toBe(2);
    expect(stateOf(db, kept).state).toBe("dropped");
    expect(stateOf(db, promoted).state).toBe("dropped");
    expect(stateOf(db, promoted).promoted_journal_id).toBe(p.promoted_journal_id);
    expect(b.ledger_promoted).toEqual([{ id: promoted, promoted_journal_id: p.promoted_journal_id }]);
    const j = db.prepare("SELECT archived, note_text FROM companion_journal WHERE id = ?").get(p.promoted_journal_id) as any;
    expect(j).toMatchObject({ archived: 0, note_text: "we talked on the couch" });
    // No memory_releases row for ledger drops (kind CHECK; the state move is the record).
    expect((db.prepare("SELECT COUNT(*) AS n FROM memory_releases").get() as any).n).toBe(0);
  });

  it("without a channel only message sources match; stm.channel_id is the fallback; judge: keys never match", async () => {
    const { db, env } = setup();
    const msg = snow("2026-09-26T00:15:00Z");
    const byMsg = await seed(env, { source_kind: "message", source_ref: msg });
    const covering = await seed(env, {});
    const judged = await seed(env, { source_kind: "message", source_ref: snow("2026-09-26T00:14:00Z"), dedup_key: "j" });

    const b = await (await retract(env, { external_ids: [`discord:${msg}`, `judge:${snow("2026-09-26T00:14:00Z")}`] })).json() as any;
    expect(b.ledger_ids).toEqual([byMsg]);
    expect(stateOf(db, covering).state).toBe("open");
    expect(stateOf(db, judged).state).toBe("open"); // Raziel's own prompt stands

    const b2 = await (await retract(env, {
      external_ids: [`discord:${msg}`],
      stm: { channel_id: CH, content: "a reply long enough to be a needle, not a phrase" },
    })).json() as any;
    expect(b2.ledger_ids).toEqual([covering]);
    expect(stateOf(db, covering).state).toBe("dropped");
  });

  it("a repeat retract is idempotent: already-dropped rows are not counted again", async () => {
    const { env } = setup();
    const msg = snow("2026-09-26T00:15:00Z");
    await seed(env, { source_kind: "message", source_ref: msg });
    expect(((await (await retract(env, { external_ids: [`discord:${msg}`], channel_id: CH })).json()) as any).ledger_dropped).toBe(1);
    const again = await (await retract(env, { external_ids: [`discord:${msg}`], channel_id: CH })).json() as any;
    expect(again.ledger_dropped).toBe(0);
    expect(again.ledger_ids).toEqual([]);
  });
});
