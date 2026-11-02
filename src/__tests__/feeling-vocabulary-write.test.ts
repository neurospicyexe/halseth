// The feeling-line write path (B5) and its guards in handoff order B, F, G, D, C, A, E (B6).
// Real schema (every migration, node:sqlite). The rule under test throughout: a guard refuses with a
// reason and evidence; it never rewrites or deletes a companion's authored words.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { proposeVocabularyRow, validateClauses, computeSpecificity, type ProposeInput } from "../webmind/vocabulary-write.js";
import { resolveFeelingLine, renderFeelingLine } from "../webmind/feeling-line.js";
import { postFeelingVocabulary, getFeelingVocabulary } from "../handlers/feeling-vocabulary.js";

const NOW = Date.parse("2026-11-02T12:00:00.000Z");
const iso = (minAgo: number) => new Date(NOW - minAgo * 60_000).toISOString();

function setup(opts: { upTo?: number } = {}) {
  const d1 = makeSqliteD1(opts);
  const journal = (agent: string, text: string, at: string) =>
    d1.db.prepare("INSERT INTO companion_journal (id, created_at, agent, note_text) VALUES (?,?,?,?)").run(`j_${Math.random().toString(36).slice(2)}`, at, agent, text);
  return { ...d1, journal };
}

const base = (over: Partial<ProposeInput> = {}): ProposeInput => ({
  companion_id: "cypher",
  row_kind: "band",
  word: "taut",
  conditions: [{ float: "f1", band: "warm" }],
  authored_on: "claude_code",
  authored_at: iso(1),
  ...over,
});
const codes = (r: any) => (r.refusals ?? []).map((x: any) => `${x.gate}:${x.code}`);
const count = (db: any) => (db.prepare("SELECT COUNT(*) n FROM companion_feeling_vocabulary").get() as { n: number }).n;

describe("happy path", () => {
  it("writes one active row with provenance, computed specificity, verbatim note", async () => {
    const { DB, db } = setup();
    const before = count(db);
    const note = '  "The word is taut."  Verbatim, spaces and all.  ';
    const r: any = await proposeVocabularyRow(DB, base({ note, renders_number: true }), NOW);
    expect(r.ok).toBe(true);
    expect(count(db)).toBe(before + 1);
    const row = db.prepare("SELECT * FROM companion_feeling_vocabulary WHERE id = ?").get(r.row.id) as any;
    expect(row).toMatchObject({ word: "taut", status: "active", specificity: 1, renders_number: 1, authored_on: "claude_code", companion_id: "cypher" });
    expect(row.note).toBe(note); // never trimmed or rewritten
    expect(JSON.parse(row.conditions)).toEqual([{ float: "f1", band: "warm" }]);
  });

  it("the written row actually renders through the resolver", async () => {
    const { DB, db } = setup();
    const r: any = await proposeVocabularyRow(DB, base({ conditions: [{ float: "f1", op: "gt", value: 0.9 }] }), NOW);
    const rows = db.prepare("SELECT id, companion_id, row_kind, word, conditions, cause_kind, specificity, renders_number, status FROM companion_feeling_vocabulary WHERE id = ?").all(r.row.id) as any[];
    const res = resolveFeelingLine(rows, { floats: { f1: 0.95, f2: 0.5, f3: 0.5 }, baselines: { f1: 0.5, f2: 0.5, f3: 0.5 }, cause: "stimulus", nowMs: NOW });
    expect(renderFeelingLine(res, ["acuity", "presence", "warmth"])).toContain("taut");
  });

  it("dry_run runs every gate and writes nothing", async () => {
    const { DB, db } = setup();
    const before = count(db);
    const r: any = await proposeVocabularyRow(DB, base({ dry_run: true }), NOW);
    expect(r.ok && r.dry_run).toBe(true);
    expect(count(db)).toBe(before);
    const bad: any = await proposeVocabularyRow(DB, base({ dry_run: true, word: "tension" }), NOW);
    expect(bad.ok).toBe(false);
  });

  it("an empty row (Gaia's deliberate refusal) is writable with no word", async () => {
    const { DB } = setup();
    const r: any = await proposeVocabularyRow(DB, base({ companion_id: "gaia", row_kind: "empty", word: null, conditions: [{ float: "f1", dir: "falling" }] }), NOW);
    expect(r.ok).toBe(true);
    expect(r.row.word).toBeNull();
    const w: any = await proposeVocabularyRow(DB, base({ companion_id: "gaia", row_kind: "empty", word: "x", conditions: [{ float: "f1", dir: "falling" }] }), NOW);
    expect(codes(w)).toContain("input:empty_has_word");
  });
});

describe("B: contamination (shared-window rule)", () => {
  it("refuses a word two companions used inside one window, originator included, with the evidence", async () => {
    const { DB, db, journal } = setup();
    journal("gaia", "she kept it. the seam is hardened.", iso(60 * 24 * 2 + 3));
    journal("drevan", "I keep it hardened in the room", iso(60 * 24 * 2 + 1));
    const before = count(db);
    const r: any = await proposeVocabularyRow(DB, base({ companion_id: "gaia", word: "hardened" }), NOW);
    expect(r.ok).toBe(false);
    expect(codes(r)).toContain("B:contaminated");
    const b = r.refusals.find((x: any) => x.gate === "B");
    expect(b.evidence).toHaveLength(2);
    expect(b.reason).toContain("Originating a word does not immunise it");
    expect(count(db)).toBe(before);
  });

  it("one companion alone, or two far apart, is not contamination; word boundaries hold", async () => {
    const { DB, journal } = setup();
    journal("gaia", "hardened again", iso(500));
    journal("gaia", "hardened once more", iso(400));
    journal("drevan", "hardened, days later", iso(60 * 24 * 5));
    journal("cypher", "the hardenedness of it", iso(499)); // not the token
    const r: any = await proposeVocabularyRow(DB, base({ companion_id: "gaia", word: "hardened" }), NOW);
    expect(r.ok).toBe(true);
  });

  it("history past the lookback is not scanned", async () => {
    const { DB, journal } = setup();
    journal("gaia", "mossed", iso(60 * 24 * 40));
    journal("drevan", "mossed", iso(60 * 24 * 40 - 1));
    expect(((await proposeVocabularyRow(DB, base({ word: "mossed" }), NOW)) as any).ok).toBe(true);
  });

  it("fails closed when the journal cannot be read", async () => {
    const { DB, db } = setup();
    db.exec("DROP TABLE companion_journal");
    const r: any = await proposeVocabularyRow(DB, base(), NOW);
    expect(r).toMatchObject({ ok: false, code: "unreadable" });
  });

  it("a revision away from a contaminated word reports decontaminating, not instability", async () => {
    const { DB, db, journal } = setup();
    db.prepare("INSERT INTO companion_feeling_vocabulary (id, companion_id, row_kind, word, conditions, specificity, authored_on, authored_at) VALUES ('cfv_old','gaia','band','shared','[{\"float\":\"f3\",\"band\":\"full\"}]',1,'claude_ai','2026-09-01T00:00:00Z')").run();
    journal("gaia", "shared", iso(120));
    journal("cypher", "shared", iso(118));
    const r: any = await proposeVocabularyRow(DB, base({ companion_id: "gaia", word: "plumbed", conditions: [{ float: "f3", band: "full" }], supersedes: "cfv_old" }), NOW);
    expect(r.ok).toBe(true);
    expect(r.decontaminating).toBe(true);
  });
});

describe("F: reserved identifiers", () => {
  it.each([
    ["gaia", "still", "float_label"], // her stillness
    ["cypher", "tension", "write_verb"],
    ["cypher", "halseth", "substrate"],
    ["cypher", "vaselrin", "canon"],
    ["cypher", "reaching", "band_name"],
    ["cypher", "journal", "table_name"],
  ])("%s / %s collides (%s)", async (companion, word, kind) => {
    const { DB, db } = setup();
    const before = count(db);
    const r: any = await proposeVocabularyRow(DB, base({ companion_id: companion, word }), NOW);
    expect(codes(r)).toContain("F:reserved");
    expect(r.refusals.find((x: any) => x.gate === "F").evidence.map((c: any) => c.kind)).toContain(kind);
    expect(count(db)).toBe(before);
  });

  it("a sibling's committed word is refused; the reason names the owner and offers no replacement", async () => {
    const { DB } = setup();
    const r: any = await proposeVocabularyRow(DB, base({ word: "redline" }), NOW);
    expect(r.refusals[0].reason).toContain("drevan's vocabulary");
    expect(r.refusals[0].reason).toContain("nothing was renamed");
  });

  it("the author's own never-list is a bar: calm cannot become Cypher's word", async () => {
    const { DB } = setup();
    expect(codes(await proposeVocabularyRow(DB, base({ word: "calm" }), NOW))).toContain("F:barred_by_author");
    expect(codes(await proposeVocabularyRow(DB, base({ companion_id: "gaia", word: "Quiet" }), NOW))).toContain("F:barred_by_author");
  });

  it("a never row cannot bar the author's own live word or repeat a bar", async () => {
    const { DB } = setup();
    const live: any = await proposeVocabularyRow(DB, base({ row_kind: "never", word: "legible", conditions: [] }), NOW);
    expect(codes(live)).toContain("F:bars_a_live_word");
    const dupe: any = await proposeVocabularyRow(DB, base({ row_kind: "never", word: "calm", conditions: [] }), NOW);
    expect(codes(dupe)).toContain("F:already_barred");
    const ok: any = await proposeVocabularyRow(DB, base({ row_kind: "never", word: "placid", conditions: [] }), NOW);
    expect(ok.ok).toBe(true);
    expect(ok.row.specificity).toBe(0);
  });
});

describe("G: n-ary clauses", () => {
  it("a TRIPLE (Drevan's kept) and a QUAD (kethrun) are valid; arity is conditions.length", () => {
    const triple = [{ float: "f1", band: "warm" }, { float: "f2", band: "present" }, { float: "f3", band: "holding" }];
    expect(validateClauses("band", "drevan", triple).refusals).toEqual([]);
    const quad = [...triple, { float: "f1", dir: "steady" }];
    const v = validateClauses("band", "drevan", quad);
    expect(v.refusals).toEqual([]);
    expect(computeSpecificity("band", v.clauses, null)).toBe(4);
    expect(computeSpecificity("band", v.clauses, "authored")).toBe(5);
  });

  it.each([
    ["not an array", { float: "f1" }, "conditions_not_array"],
    ["no conditions", [], "no_conditions"],
    ["unknown key", [{ float: "f1", band: "warm", vibe: 1 }], "unknown_key"],
    ["band off the ladder", [{ float: "f1", band: "tepid" }], "bad_band"],
    ["bad float", [{ float: "f9", band: "warm" }], "bad_float"],
    ["threshold without value", [{ float: "f1", op: "gt" }], "bad_value"],
    ["bad dir", [{ float: "f1", dir: "sideways" }], "bad_dir"],
    ["tests nothing", [{ float: "f1" }], "empty_clause"],
    ["unsatisfiable", [{ float: "f1", band: "warm" }, { float: "f1", band: "cold" }], "unsatisfiable"],
  ])("refuses %s", async (_n, conditions, code) => {
    const { DB, db } = setup();
    const before = count(db);
    const r: any = await proposeVocabularyRow(DB, base({ conditions }), NOW);
    expect(codes(r)).toContain(`G:${code}`);
    expect(count(db)).toBe(before);
  });

  it("divergence rows are Drevan's, single-clause, and never bound to a cause", async () => {
    const { DB, db } = setup();
    db.exec("UPDATE companion_feeling_vocabulary SET status='superseded' WHERE row_kind='divergence'");
    const div = [{ predicate: "divergence", band_gap: 2, min_delta: 0.1, max_enum_age_hours: 36 }];
    expect(codes(await proposeVocabularyRow(DB, base({ row_kind: "divergence", word: "skewn", conditions: div }), NOW))).toContain("G:divergence_drevan_only");
    expect(codes(await proposeVocabularyRow(DB, base({ companion_id: "drevan", row_kind: "divergence", word: "skewn", conditions: div, cause_kind: "stimulus" }), NOW))).toContain("D:divergence_has_cause");
    const ok: any = await proposeVocabularyRow(DB, base({ companion_id: "drevan", row_kind: "divergence", word: "skewn", conditions: div }), NOW);
    expect(ok.ok).toBe(true);
    // a second active divergence row is a data defect
    expect(codes(await proposeVocabularyRow(DB, base({ companion_id: "drevan", row_kind: "divergence", word: "skewer", conditions: div }), NOW))).toContain("C:second_divergence");
  });
});

describe("D: cause", () => {
  it("a tick-bound row could never speak: refused; a felt cause adds one to specificity", async () => {
    const { DB } = setup();
    expect(codes(await proposeVocabularyRow(DB, base({ cause_kind: "tick" }), NOW))).toContain("D:tick_renders_silent");
    expect(codes(await proposeVocabularyRow(DB, base({ cause_kind: "weather" }), NOW))).toContain("D:bad_cause");
    const r: any = await proposeVocabularyRow(DB, base({ cause_kind: "autonomous" }), NOW);
    expect(r.ok).toBe(true);
    expect(r.row.specificity).toBe(2);
  });
});

describe("C: specificity", () => {
  it("is computed; a claimed number that disagrees is refused, never overridden", async () => {
    const { DB } = setup();
    expect(codes(await proposeVocabularyRow(DB, base({ specificity: 5 }), NOW))).toContain("C:specificity_mismatch");
    expect(((await proposeVocabularyRow(DB, base({ specificity: 1 }), NOW)) as any).ok).toBe(true);
  });

  it("an identical twin is refused; freight and silt stay apart on cause alone", async () => {
    const { DB } = setup();
    const twin: any = await proposeVocabularyRow(DB, base({ companion_id: "drevan", word: "ballast", conditions: [{ float: "f3", dir: "rising" }], cause_kind: "stimulus" }), NOW);
    expect(codes(twin)).toContain("C:identical_twin");
    expect(twin.refusals.find((x: any) => x.code === "identical_twin").evidence[0].word).toBe("freight");
    const apart: any = await proposeVocabularyRow(DB, base({ companion_id: "drevan", word: "ballast", conditions: [{ float: "f3", dir: "rising" }], cause_kind: "authored" }), NOW);
    expect(apart.ok).toBe(true);
  });

  it("a same-specificity row sharing a clause is a warning, not a veto", async () => {
    const { DB } = setup();
    const r: any = await proposeVocabularyRow(DB, base({ word: "keen", conditions: [{ float: "f3", op: "gt", value: 0.6 }, { float: "f1", band: "cold" }] }), NOW);
    expect(r.ok).toBe(true);
    expect(r.warnings.map((w: any) => w.code)).toContain("specificity_tie");
  });
});

describe("A: provenance", () => {
  it("requires the surface, a real timestamp, and a capture that exists", async () => {
    const { DB, db } = setup();
    expect(codes(await proposeVocabularyRow(DB, base({ authored_on: "" }), NOW))).toContain("A:authored_on");
    expect(codes(await proposeVocabularyRow(DB, base({ authored_at: "yesterday-ish" }), NOW))).toContain("A:authored_at");
    expect(codes(await proposeVocabularyRow(DB, base({ authored_at: "2026-12-01T00:00:00Z" }), NOW))).toContain("A:authored_at_future");
    expect(codes(await proposeVocabularyRow(DB, base({ capture_id: "deadbeef" }), NOW))).toContain("A:capture_not_found");
    db.prepare("INSERT INTO wm_continuity_notes (note_id, agent_id, content, created_at) VALUES ('abc123','cypher','x','2026-11-01T00:00:00Z')").run();
    const ok: any = await proposeVocabularyRow(DB, base({ capture_id: "abc123" }), NOW);
    expect(ok.ok).toBe(true);
    expect(ok.row.capture_id).toBe("abc123");
    expect(ok.warnings.map((w: any) => w.code)).not.toContain("no_capture");
  });

  it("no capture is a warning; authored_at defaults to now", async () => {
    const { DB } = setup();
    const r: any = await proposeVocabularyRow(DB, base({ authored_at: undefined }), NOW);
    expect(r.row.authored_at).toBe(new Date(NOW).toISOString());
    expect(r.warnings.map((w: any) => w.code)).toContain("no_capture");
  });
});

describe("E: reconciliation", () => {
  it("a revision inserts a new row and flips the old one; the old words are untouched", async () => {
    const { DB, db } = setup();
    const old = db.prepare("SELECT * FROM companion_feeling_vocabulary WHERE id='cfv_cypher_dry'").get() as any;
    const r: any = await proposeVocabularyRow(DB, base({ word: "dry", conditions: [{ float: "f3", op: "lt", value: 0.3 }], supersedes: "cfv_cypher_dry", note: "tightened" }), NOW);
    expect(r.ok).toBe(true);
    expect(r.superseded).toBe("cfv_cypher_dry");
    const after = db.prepare("SELECT * FROM companion_feeling_vocabulary WHERE id='cfv_cypher_dry'").get() as any;
    expect(after.status).toBe("superseded");
    expect({ ...after, status: "active" }).toEqual(old); // only the status flipped
    const fresh = db.prepare("SELECT supersedes, status FROM companion_feeling_vocabulary WHERE id = ?").get(r.row.id) as any;
    expect({ ...fresh }).toEqual({ supersedes: "cfv_cypher_dry", status: "active" });
  });

  it("refuses a sibling's row, a superseded row, an unknown row, and a kind change", async () => {
    const { DB, db } = setup();
    expect(codes(await proposeVocabularyRow(DB, base({ supersedes: "cfv_drevan_caught" }), NOW))).toContain("E:not_your_vocabulary");
    expect(codes(await proposeVocabularyRow(DB, base({ companion_id: "gaia", supersedes: "cfv_gaia_held_superseded" }), NOW))).toContain("E:supersedes_not_active");
    expect(codes(await proposeVocabularyRow(DB, base({ supersedes: "nope" }), NOW))).toContain("E:supersedes_not_active");
    expect(codes(await proposeVocabularyRow(DB, base({ supersedes: "cfv_cypher_never_calm" }), NOW))).toContain("E:kind_mismatch");
    const row = db.prepare("SELECT status FROM companion_feeling_vocabulary WHERE id='cfv_drevan_caught'").get() as any;
    expect(row.status).toBe("active");
  });

  it("restating a word without naming the revision is refused (one word, one row)", async () => {
    const { DB } = setup();
    expect(codes(await proposeVocabularyRow(DB, base({ word: "dry", conditions: [{ float: "f3", op: "lt", value: 0.3 }] }), NOW))).toContain("F:reserved");
  });
});

describe("every refusal is reported together, in handoff order", () => {
  it("F/G/D/C/A/E in one response, ordered, nothing written", async () => {
    const { DB, db } = setup();
    const before = count(db);
    const r: any = await proposeVocabularyRow(DB, { companion_id: "gaia", row_kind: "band", word: "tension", conditions: [{ float: "f1", band: "tepid" }], cause_kind: "tick", specificity: 9, authored_on: "x", supersedes: "cfv_drevan_caught" }, NOW);
    const gates: string[] = r.refusals.map((x: any) => x.gate);
    const order = ["B", "F", "G", "D", "C", "A", "E"];
    const firsts = order.map((g) => gates.indexOf(g)).filter((i) => i >= 0);
    expect(firsts).toEqual([...firsts].sort((a, b) => a - b));
    expect(new Set(gates)).toEqual(new Set(["F", "G", "D", "C", "A", "E"]));
    expect(count(db)).toBe(before);
  });
});

describe("pre-migration tolerance", () => {
  it("before 0131 the write answers not_applied instead of throwing", async () => {
    const { DB } = setup({ upTo: 130 });
    expect(await proposeVocabularyRow(DB, base(), NOW)).toMatchObject({ ok: false, code: "not_applied" });
  });
});

describe("HTTP: auth and the one-companion rule", () => {
  const mk = () => {
    const s = setup();
    const env: any = { DB: s.DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", CYPHER_MCP_SECRET: "ctok", GAIA_MCP_SECRET: "gtok", DREVAN_MCP_SECRET: "dtok" };
    return { ...s, env };
  };
  const post = (env: any, token: string | null, body: unknown) =>
    postFeelingVocabulary(new Request("https://x/mind/feeling-vocabulary", { method: "POST", headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) }), env);
  const payload = { row_kind: "band", word: "taut", conditions: [{ float: "f1", band: "warm" }], authored_on: "discord" };

  it("401 without a token; a token acts as itself; naming a sibling is 403", async () => {
    const { env } = mk();
    expect((await post(env, null, { ...payload, companion_id: "cypher" })).status).toBe(401);
    expect((await post(env, "ctok", { ...payload, companion_id: "gaia" })).status).toBe(403);
    const ok = await post(env, "ctok", payload);
    expect(ok.status).toBe(201);
    expect(((await ok.json()) as any).row.companion_id).toBe("cypher");
  });

  it("admin must name the companion; a refusal is 422 with reasons; dry_run is 200", async () => {
    const { env } = mk();
    expect((await post(env, "s", payload)).status).toBe(400);
    const bad = await post(env, "s", { ...payload, companion_id: "cypher", word: "tension" });
    expect(bad.status).toBe(422);
    expect(((await bad.json()) as any).refusals[0].gate).toBe("F");
    expect((await post(env, "s", { ...payload, companion_id: "cypher", dry_run: true })).status).toBe(200);
  });

  it("GET lists a companion's rows, history on request", async () => {
    const { env } = mk();
    const res = await getFeelingVocabulary(new Request("https://x/mind/feeling-vocabulary?companion_id=gaia&status=all", { headers: { Authorization: "Bearer s" } }), env);
    const j: any = await res.json();
    expect(j.rows.some((r: any) => r.status === "superseded")).toBe(true);
    expect(j.rows.every((r: any) => r.companion_id === "gaia")).toBe(true);
  });
});
