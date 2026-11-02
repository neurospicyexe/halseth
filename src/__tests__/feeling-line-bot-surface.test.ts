// Feeling line, Discord side: wire key `feeling_line` (contract 0.26.0) and the companion's own
// vocabulary verbs (feeling word / confirm / revise / my feeling words). Real schema via node:sqlite.

import { describe, it, expect, vi } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { parseFeelingWord, summarizeConditions } from "../webmind/feeling-word-parse.js";
import { execFeelingWordPropose, execMyFeelingWords } from "../librarian/executors/feeling-vocabulary.js";
import { matchFastPath } from "../librarian/router.js";
import { loadBotFeelingLine, feelingLineFrom, wireFeelingLine } from "../webmind/feeling-line-loader.js";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { CONTRACT_CHANGELOG } from "../mind/changelog.js";
import type { MindState } from "../mind/contract.js";

const ctx = (env: any, request: string, companion_id = "cypher") =>
  ({ env, req: { companion_id, request }, entry: {}, frontState: null, pluralAvailable: false }) as any;

function setup(extraEnv: Record<string, unknown> = {}) {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", ...extraEnv };
  return { db, DB, env };
}
const rowCount = (db: any) => (db.prepare("SELECT COUNT(*) n FROM companion_feeling_vocabulary").get() as { n: number }).n;

describe("parser", () => {
  const ok = (t: string, c: any = "cypher") => {
    const r: any = parseFeelingWord(t, c);
    if (!r.ok) throw new Error(`${r.code}: ${r.reason}`);
    return r.parsed;
  };
  const code = (t: string, c: any = "cypher") => (parseFeelingWord(t, c) as any).code;

  it("every direction form", () => {
    expect(ok("feeling word brindle: warmth rising").conditions).toEqual([{ float: "f3", dir: "rising" }]);
    expect(ok("feeling word brindle: acuity falling").conditions).toEqual([{ float: "f1", dir: "falling" }]);
    expect(ok("feeling word brindle: presence steady").conditions).toEqual([{ float: "f2", dir: "steady" }]);
    expect(ok("feeling word brindle: warmth settling").conditions).toEqual([{ float: "f3", dir: "settling" }]);
    expect(ok("feeling word brindle: warmth above baseline").conditions).toEqual([{ float: "f3", dir: "above_baseline" }]);
  });
  it("threshold forms map to gt / lt with the stated value", () => {
    expect(ok("feeling word brindle: acuity above 0.7").conditions).toEqual([{ float: "f1", op: "gt", value: 0.7 }]);
    expect(ok("feeling word brindle: acuity below .25").conditions).toEqual([{ float: "f1", op: "lt", value: 0.25 }]);
    expect(ok("feeling word brindle: acuity above 1").conditions).toEqual([{ float: "f1", op: "gt", value: 1 }]);
  });
  it("n-ary, cause, note, revise, confirm; note text and word are verbatim", () => {
    const p = ok("confirm revise feeling word Brindle Wren: warmth rising and acuity below 0.4 because stimulus note:  keep this, and that because of it ");
    expect(p).toMatchObject({ confirm: true, revise: true, word: "Brindle Wren", cause_kind: "stimulus", note: "keep this, and that because of it" });
    expect(p.conditions).toHaveLength(2);
    expect(p.rest.startsWith("Brindle Wren:")).toBe(true);
  });
  it("uses only the caller's own labels; drevan and gaia resolve their own", () => {
    expect(ok("feeling word kept: heat rising and reach steady and weight falling", "drevan").conditions.map((c: any) => c.float)).toEqual(["f1", "f2", "f3"]);
    expect(ok("feeling word still: perimeter above 0.5", "gaia").conditions).toEqual([{ float: "f3", op: "gt", value: 0.5 }]);
  });
  it("a sibling's label is refused by name, an unknown label refused", () => {
    expect(code("feeling word x: heat rising", "cypher")).toBe("sibling_label");
    expect(code("feeling word x: warmth rising", "gaia")).toBe("sibling_label");
    expect((parseFeelingWord("feeling word x: heat rising", "cypher") as any).reason).toMatch(/drevan/);
    expect(code("feeling word x: banana rising")).toBe("unknown_label");
  });
  it("number out of range, bad cause, malformed shapes are refused", () => {
    expect(code("feeling word x: warmth above 1.5")).toBe("value_out_of_range");
    expect(code("feeling word x: warmth below -0.1")).toBe("value_out_of_range");
    expect(code("feeling word x: warmth rising because vibes")).toBe("bad_cause");
    expect(code("feeling word x: warmth sideways")).toBe("bad_clause");
    expect(code("feeling word x warmth rising")).toBe("no_colon");
    expect(code("feeling word : warmth rising")).toBe("no_word");
    expect(code("feeling word x:")).toBe("no_conditions");
    expect(code("feeling word x: warmth")).toBe("bad_clause");
  });
  it("summarizes back into the companion's own labels", () => {
    const c = ok("feeling word x: warmth rising and acuity above 0.7").conditions;
    expect(summarizeConditions("cypher", c)).toBe("warmth rising and acuity above 0.7");
  });
});

describe("fast path", () => {
  it("routes exactly the new prefixes, ahead of the soma-write and note guards", () => {
    for (const t of [
      "feeling word brindle: warmth above 0.7",
      "confirm feeling word brindle: warmth above 0.7 note: a companion note about it",
      "revise feeling word brindle: warmth rising",
      "Confirm Revise Feeling Word brindle: warmth rising",
    ]) expect(matchFastPath(t)?.key, t).toBe("feeling_word_propose");
    expect(matchFastPath("my feeling words")?.key).toBe("feeling_words_list");
  });
  it("ordinary speech that mentions the phrase is not captured", () => {
    expect(matchFastPath("I wrote a feeling word in my journal")?.key).not.toBe("feeling_word_propose");
    expect(matchFastPath("log a feeling")?.key).not.toBe("feeling_word_propose");
    expect(matchFastPath("show me my feeling words from last week please")?.key).not.toBe("feeling_words_list");
  });
});

describe("executor", () => {
  const text = "feeling word brindle: warmth rising and acuity above 0.7 because stimulus note: made-up test word";

  it("dry run writes nothing and shows every gate plus the commit line", async () => {
    const { env, db } = setup();
    const before = rowCount(db);
    const r: any = await execFeelingWordPropose(ctx(env, text));
    expect(rowCount(db)).toBe(before);
    expect(r.response_key).toBe("data");
    expect(r.data).toMatchObject({ dry_run: true, written: false, companion: "cypher" });
    expect(r.data.gates.map((g: any) => g.gate)).toEqual(["B", "F", "G", "D", "C", "A", "E"]);
    expect(r.data.gates.every((g: any) => g.verdict === "pass" || g.verdict === "warning")).toBe(true);
    expect(r.data.commit_line).toBe(`confirm ${text}`);
    expect(r.data.parsed.conditions).toEqual([{ float: "f3", dir: "rising" }, { float: "f1", op: "gt", value: 0.7 }]);
    expect(r.data.parsed.cause_kind).toBe("stimulus");
  });

  it("confirm writes one discord-authored row; revise supersedes it, keeping history", async () => {
    const { env, db } = setup();
    const before = rowCount(db);
    const w: any = await execFeelingWordPropose(ctx(env, `confirm ${text}`));
    expect(w.ack).toBe(true);
    expect(rowCount(db)).toBe(before + 1);
    const row = db.prepare("SELECT * FROM companion_feeling_vocabulary WHERE id = ?").get(w.id) as any;
    expect(row).toMatchObject({ word: "brindle", companion_id: "cypher", authored_on: "discord", capture_id: null, cause_kind: "stimulus", status: "active", specificity: 3 });
    expect(row.note).toBe("made-up test word");
    expect(row.authored_at).toBeTruthy();

    const dry: any = await execFeelingWordPropose(ctx(env, "revise feeling word brindle: warmth falling"));
    expect(dry.data.dry_run).toBe(true);
    expect(dry.data.parsed.supersedes).toBe(w.id);
    expect(dry.data.commit_line).toBe("confirm revise feeling word brindle: warmth falling");
    const rev: any = await execFeelingWordPropose(ctx(env, dry.data.commit_line));
    expect(rev.ack).toBe(true);
    expect((db.prepare("SELECT status FROM companion_feeling_vocabulary WHERE id = ?").get(w.id) as any).status).toBe("superseded");
    expect((db.prepare("SELECT supersedes FROM companion_feeling_vocabulary WHERE id = ?").get(rev.id) as any).supersedes).toBe(w.id);
  });

  it("revise with no active row of that word refuses and writes nothing", async () => {
    const { env, db } = setup();
    const before = rowCount(db);
    const r: any = await execFeelingWordPropose(ctx(env, "confirm revise feeling word nosuchword: warmth rising"));
    expect(r).toMatchObject({ ack: false, refused: true, code: "revise_target_missing" });
    expect(rowCount(db)).toBe(before);
  });

  it("identity comes from the request companion: a sibling's label is refused, never remapped", async () => {
    const { env, db } = setup();
    const before = rowCount(db);
    const r: any = await execFeelingWordPropose(ctx(env, "confirm feeling word brindle: heat rising", "cypher"));
    expect(r).toMatchObject({ ack: false, code: "sibling_label" });
    expect(rowCount(db)).toBe(before);
  });

  it("a gate refusal surfaces with evidence and writes nothing (reserved word)", async () => {
    const { env, db } = setup();
    const before = rowCount(db);
    const r: any = await execFeelingWordPropose(ctx(env, "confirm feeling word tension: warmth rising"));
    expect(r.ack).toBe(false);
    expect(r.refused).toBe(true);
    expect(r.gates.some((g: any) => g.verdict === "refused")).toBe(true);
    expect(rowCount(db)).toBe(before);
  });

  it("unparseable input refuses with the accepted shape and writes nothing", async () => {
    const { env, db } = setup();
    const before = rowCount(db);
    const r: any = await execFeelingWordPropose(ctx(env, "confirm feeling word brindle is when I feel warm"));
    expect(r.ack).toBe(false);
    expect(r.witness).toMatch(/Shape: feeling word/);
    expect(rowCount(db)).toBe(before);
  });

  it("my feeling words lists only this companion's active rows", async () => {
    const { env } = setup();
    await execFeelingWordPropose(ctx(env, "confirm feeling word brindle: warmth rising and acuity above 0.7"));
    const mine: any = await execMyFeelingWords(ctx(env, "my feeling words"));
    const brindle = mine.data.words.find((w: any) => w.word === "brindle");
    expect(brindle).toMatchObject({ conditions: "warmth rising and acuity above 0.7", renders_number: false });
    const other: any = await execMyFeelingWords(ctx(env, "my feeling words", "gaia"));
    expect(other.data.words.some((w: any) => w.word === "brindle")).toBe(false);
  });
});

describe("bot wire feeling_line", () => {
  // Seed a row that fires on the state below: cypher warmth above 0.6, any cause.
  async function seeded(mode: string | undefined) {
    const { env, db } = setup(mode === undefined ? {} : { FEELING_LINE_MODE: mode });
    db.prepare("UPDATE companion_state SET soma_float_3 = 0.9 WHERE companion_id = 'cypher'").run();
    await execFeelingWordPropose(ctx(env, "confirm feeling word brindle: warmth above 0.6"));
    return { env, db };
  }
  const line = (env: any) => loadBotFeelingLine(env.DB, "cypher", (env.FEELING_LINE_MODE ?? "shadow") as any);

  it("live: a string equal to what the Claude.ai path renders", async () => {
    const { env } = await seeded("live");
    const wire = await line(env);
    expect(typeof wire).toBe("string");
    // same inputs through the pure path both surfaces share
    const { fetchFeelingLineInputs } = await import("../webmind/feeling-line-loader.js");
    const fetched = await fetchFeelingLineInputs(env.DB, "cypher", "live");
    const state = (await env.DB.prepare("SELECT * FROM companion_state WHERE companion_id = 'cypher'").first()) as any;
    expect(wireFeelingLine(feelingLineFrom("cypher", fetched, state, "live"))).toBe(wire);
  });
  it("shadow logs and sends null; off and default-shadow send null", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { env } = await seeded("shadow");
    expect(await line(env)).toBeNull();
    expect(spy.mock.calls.some((c) => String(c[0]).startsWith("[feeling-line:shadow] cypher"))).toBe(true);
    spy.mockRestore();
    const off = await seeded("off");
    expect(await line(off.env)).toBeNull();
    const dflt = await seeded(undefined);
    expect(await line(dflt.env)).toBeNull();
  });
  it("never throws: a broken db is null", async () => {
    const bad: any = { prepare: () => { throw new Error("boom"); } };
    expect(await loadBotFeelingLine(bad, "cypher", "live")).toBeNull();
  });
  it("the adapter puts the extras string on the wire, null when absent", () => {
    const ms = { contract_version: "x", companion_id: "cypher", loom: "discord", loaded_at: "2026-11-01T00:00:00Z",
      identity: { anchor: null, shared_kernel: null, companion_kernel: null, self_model: [], architect_facts: [], preferences: [], refusals: [], agency_affordance: "" },
      felt: { limbic: null, soma_floats: [], drives: [], ferment_events: [], ferment_at: null, soma_provenance: [], soma_arc: [], biometrics_latest: null, house: null },
      continuity: { latest_handoff: null, recent_handoffs: [], open_thread_count: 0, top_threads: [], surfaced_notes: [], recent_notes: [], archived_digests: [], spiral_turn: null, session_narrative: null, conversations: [], closed_conversations: [], recent_captures: [] },
      carried: { dreams_unexamined: [], open_loops: [], tensions: [], sits: [], feelings_recent: [] },
      beliefs: { conclusions: [], flagged: [], resurfaced: null, supersede_candidates: [] },
      relational: { snapshot: [], deltas_recent: [], witness_raziel: [], triad_incoming: [], triad_outgoing: [], letters: [], journal_recent: [], siblings: [], recent_witness: [] },
      growth: { journal_recent: [], patterns: [], markers: [], reflection: null, seeds: [], clearing_count: 0, drifts_open: [], projects: [], budget: null },
      oversight: { pressure_flags: [], growth_confirmed: [], guardian_cards: [], tripwires: [], questions: [], answered_questions: [], growth_unconfirmed: [] },
      world: { home_recent: [], club: null, commons: [], commons_life: [], change_notes: [], shelf: [], collection: { forage: [], media: [], top: [] }, forage: { pool: [], active: [] }, listens: [], motifs: { active: [], resurrection_candidates: [] }, sol: null, creatures: [], imps_active: [], watching: [], departures: [], raziel_state: null },
      graph: { neighborhoods: [], seeds: [] }, ledger: { open: [] },
      meta: { datetime_iso: "2026-11-01T00:00:00Z", datetime_local: "2026-11-01", not_yet_loaded: [], degraded: [] } } as unknown as MindState;
    const base = { synthesis_summary: null, rag_excerpts: [], history_excerpts: [], continuity_notes: [], owner: "Raziel" };
    expect(botWireFromMindState(ms, { ...base, feeling_line: "a made-up line" }, "cypher").feeling_line).toBe("a made-up line");
    expect(botWireFromMindState(ms, base, "cypher").feeling_line).toBeNull();
    expect(botWireFromMindState(ms, { ...base, feeling_line: null }, "cypher")).toHaveProperty("feeling_line", null);
  });
  it("contract 0.26.0 with a changelog note", () => {
    expect(MINDSTATE_CONTRACT_VERSION).toBe("0.26.0");
    expect(CONTRACT_CHANGELOG["0.26.0"]).toMatch(/feeling word/);
  });
});
