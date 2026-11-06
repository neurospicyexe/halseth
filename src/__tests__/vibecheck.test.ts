// Vibe-check v2 (B63 step 3): one block per companion under that companion's own agent. Real schema
// via node:sqlite for everything that touches the DB; pure formatters tested directly.
//
// All text below is FIXTURE text, invented for the test.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  formatCompanionBlock, formatVibeCheck, formatVibePosts, formatDayLine, formatGaugeLine, formatFieldLine,
  causeLabel, gaugeTags, parseGaugeTags, runVibeCheck, gatherVibeData,
  type CompanionVibe, type DayFacts, type VibeData,
} from "../webmind/vibecheck.js";

const EM = String.fromCharCode(0x2014);
const NO_EM_DASH = new RegExp(EM + "|" + String.fromCharCode(0x2013) + "| -- ");

function day(over: Partial<DayFacts> = {}): DayFacts {
  return {
    spoke: 0, makes: 0, letters: 0, sol_tends: 0, tensions_held: 0,
    notes_sent: 0, notes_received: 0, sessions_closed: 0, plantings: 0, watch: null, ...over,
  };
}
function comp(over: Partial<CompanionVibe> = {}): CompanionVibe {
  return {
    companion_id: "drevan", date: "2026-11-05",
    floats: [
      { label: "heat", value: 0.83, baseline: 0.7 },
      { label: "reach", value: 0.4, baseline: 0.65 },
      { label: "weight", value: 0.55, baseline: 0.55 },
    ],
    moves: [], showPressure: false, pressure: [], day: day(),
    gauges: { basin: "stable", soma: "clean-settled", tensions: 0 }, previousGauges: null, ...over,
  };
}

describe("formatCompanionBlock", () => {
  it("shows each float against its OWN baseline with direction and size, in fixed order", () => {
    const out = formatCompanionBlock(comp());
    expect(out).toContain("Drevan. 2026-11-05.");
    expect(out).toContain("heat 0.83 (above your 0.70 by 0.13)");
    expect(out).toContain("reach 0.40 (below your 0.65 by 0.25)");
    expect(out).toContain("weight 0.55 (at your 0.55)");
    expect(out.indexOf("heat")).toBeLessThan(out.indexOf("reach"));
    expect(out.indexOf("reach")).toBeLessThan(out.indexOf("weight"));
  });

  it("never ranks or compares: fixed label order whatever the values, no comparative words", () => {
    const flipped = comp({
      floats: [
        { label: "heat", value: 0.1, baseline: 0.7 },
        { label: "reach", value: 0.99, baseline: 0.65 },
        { label: "weight", value: 0.55, baseline: 0.55 },
      ],
    });
    const out = formatVibeCheck({
      date: "2026-11-05",
      companions: [flipped, comp({ companion_id: "cypher", floats: [
        { label: "acuity", value: 0.9, baseline: 0.5 }, { label: "presence", value: 0.2, baseline: 0.5 }, { label: "warmth", value: 0.5, baseline: 0.5 },
      ] })],
      field: { echo: null, starvedOrgans: 0, garden: 0, solTends: 0, careHoldOpen: false },
    });
    expect(out.indexOf("heat")).toBeLessThan(out.indexOf("reach"));
    expect(out).not.toMatch(/highest|lowest|strongest|weakest|most |least |rank|than (cypher|drevan|gaia)/i);
    // a block names no other companion at all
    expect(formatCompanionBlock(flipped)).not.toMatch(/cypher|gaia/i);
  });

  it("lists the top moves with their named cause, downward included", () => {
    const out = formatCompanionBlock(comp({
      moves: [
        { label: "reach", delta: -0.06, cause: "quiet day" },
        { label: "heat", delta: 0.04, cause: "make landed: a small poem" },
      ],
    }));
    expect(out).toContain("moves: reach down 0.06, quiet day; heat up 0.04, make landed: a small poem");
  });

  it("states a quiet move list plainly rather than inventing one", () => {
    expect(formatCompanionBlock(comp())).toContain("moves: none worth a line today");
  });

  it("prints pressure only when showPressure, and says clear when on with nothing", () => {
    const flag = [{ severity: "warning", summary: "loop stuck on the same image" }];
    expect(formatCompanionBlock(comp({ showPressure: false, pressure: flag }))).not.toContain("pressure");
    expect(formatCompanionBlock(comp({ showPressure: true, pressure: flag }))).toContain("pressure: warning, loop stuck on the same image");
    expect(formatCompanionBlock(comp({ showPressure: true, pressure: [] }))).toContain("pressure: clear");
  });

  it("never uses an em dash, even when a cause or flag carries one", () => {
    const out = formatCompanionBlock(comp({
      showPressure: true,
      pressure: [{ severity: "red", summary: "one " + EM + " two -- three" }],
      moves: [{ label: "heat", delta: 0.1, cause: causeLabel("make_landed", "a poem " + EM + " for the dusk", "stimulus", false) }],
    }));
    expect(out).not.toMatch(NO_EM_DASH);
  });
});

describe("formatDayLine: words not bare numbers, nonzero parts only", () => {
  it("renders labelled facts", () => {
    const l = formatDayLine(day({ spoke: 56, makes: 2, letters: 1, sol_tends: 2, tensions_held: 1, notes_sent: 1, notes_received: 3, sessions_closed: 1 }), false);
    expect(l).toBe("  day: 56 Discord messages, 2 makes, 1 letter, Sol tended twice, 1 tension held, 1 note sent, 3 notes received, 1 session close");
  });
  it("omits zero parts and prints the quiet line when nothing happened", () => {
    expect(formatDayLine(day({ makes: 1 }), false)).toBe("  day: 1 make");
    expect(formatDayLine(day(), false)).toContain("quiet");
  });
  it("shows garden plantings for Gaia only", () => {
    expect(formatDayLine(day({ plantings: 2 }), true)).toContain("2 plantings in the garden");
    expect(formatDayLine(day({ plantings: 2 }), false)).not.toContain("planting");
  });
});

describe("gauge line", () => {
  const a = { basin: "stable", soma: "clean-settled", tensions: 1 };
  it("is absent when nothing moved or there is no previous digest", () => {
    expect(formatGaugeLine(a, a)).toBeNull();
    expect(formatGaugeLine(a, null)).toBeNull();
  });
  it("names only what moved", () => {
    expect(formatGaugeLine({ ...a, tensions: 2, soma: "tender" }, a)).toBe("  gauges moved: soma clean-settled to tender; tensions 1 to 2");
  });
  it("round-trips through the digest row's tags", () => {
    const tags = gaugeTags({ basin: 'pressure ("x")', soma: "tender|warm", tensions: 3 });
    expect(parseGaugeTags(JSON.stringify(["vibecheck", ...tags]))).toEqual({ basin: "pressure (x)", soma: "tenderwarm", tensions: 3 });
  });
});

describe("field line", () => {
  it("states a care hold as the words 'care hold open' and nothing else", () => {
    const l = formatFieldLine({ echo: 0.69, starvedOrgans: 0, garden: 4, solTends: 2, careHoldOpen: true });
    expect(l).toContain("care hold open");
    expect(l).toContain("echo 0.69, calm (alarm at 0.82)");
    expect(l).toContain("garden: 4 plantings");
    expect(l).toContain("Sol tended twice today");
    expect(formatFieldLine({ echo: null, starvedOrgans: 2, garden: 1, solTends: 0, careHoldOpen: false })).not.toContain("care hold");
  });
});

describe("posts", () => {
  const data: VibeData = {
    date: "2026-11-05",
    companions: [comp({ companion_id: "cypher" }), comp({ companion_id: "drevan" }), comp({ companion_id: "gaia" })],
    field: { echo: 0.5, starvedOrgans: 0, garden: 0, solTends: 0, careHoldOpen: false },
  };
  it("Gaia's post carries the field line; the other two do not", () => {
    const posts = formatVibePosts(data);
    expect(posts.map((p) => p.companion)).toEqual(["cypher", "drevan", "gaia"]);
    expect(posts[2]!.text).toContain("Field: ");
    expect(posts[0]!.text).not.toContain("Field: ");
    expect(posts[1]!.text).not.toContain("Field: ");
  });
  it("keeps every post under the Discord cap", () => {
    const big = comp({
      showPressure: true,
      pressure: Array.from({ length: 3 }, () => ({ severity: "warning", summary: "y".repeat(500) })),
      moves: Array.from({ length: 3 }, () => ({ label: "heat", delta: 0.1, cause: "z".repeat(400) })),
      day: day({ spoke: 9, makes: 9, letters: 9, sol_tends: 9, tensions_held: 9, notes_sent: 9, notes_received: 9, sessions_closed: 9, watch: "w".repeat(300) }),
    });
    for (const p of formatVibePosts({ ...data, companions: [big, big, { ...big, companion_id: "gaia" }] })) {
      expect(p.text.length).toBeLessThanOrEqual(2000);
    }
  });
});

describe("causeLabel", () => {
  it("falls back to the stimulus kind for rows with no cause label (older rows) and for a bare kind", () => {
    expect(causeLabel("message_witnessed", null, "stimulus", false)).toBe("message witnessed");
    expect(causeLabel("message_witnessed", "message_witnessed", "stimulus", false)).toBe("message witnessed");
  });
  it("uses the label when there is one, and the kind only when the content bleeds", () => {
    expect(causeLabel("breach", "a line was crossed at the gate", "stimulus", false)).toBe("breach: a line was crossed at the gate");
    expect(causeLabel("breach", "a line was crossed at the gate", "stimulus", true)).toBe("breach");
  });
});

// ── against the real schema ─────────────────────────────────────────────────────────────────

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m" };
  db.exec("INSERT OR IGNORE INTO companions (id, name, created_at) VALUES ('cypher','Cypher','2026-01-01'),('drevan','Drevan','2026-01-01'),('gaia','Gaia','2026-01-01')");
  db.exec("INSERT OR IGNORE INTO companion_state (companion_id) VALUES ('cypher'),('drevan'),('gaia')");
  return { db, env };
}
const q = (db: any, sql: string, ...b: unknown[]) => db.prepare(sql).all(...b) as any[];
function setFloats(db: any, id: string, f: [number, number, number], b: [number, number, number]) {
  db.prepare("UPDATE companion_state SET soma_float_1=?, soma_float_2=?, soma_float_3=?, soma_float_1_baseline=?, soma_float_2_baseline=?, soma_float_3_baseline=? WHERE companion_id=?")
    .run(...f, ...b, id);
}
let evN = 0;
function ferment(db: any, id: string, kind: string, stimulus: string | null, deltas: object, detail: string | null, ago = "-1 hours") {
  db.prepare("INSERT INTO companion_ferment_events (id, companion_id, kind, stimulus, float_deltas, detail, created_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now', ?))")
    .run(`fe${++evN}`, id, kind, stimulus, JSON.stringify(deltas), detail, ago);
}
function flag(db: any, id: string, summary: string, severity = "warning") {
  db.prepare("INSERT INTO guardian_flags (id, companion_id, flag_type, severity, summary, dedup_key, status) VALUES (?, ?, 'loop_stuck', ?, ?, ?, 'open')")
    .run(`gf${++evN}`, id, severity, summary, `k${evN}`);
}
const rowsFor = (db: any, agent: string) => q(db, "SELECT * FROM companion_journal WHERE agent = ? AND source = 'vibecheck'", agent);
const postOf = (r: Awaited<ReturnType<typeof runVibeCheck>>, c: string) => r.posts.find((p) => p.companion === c)!;

describe("runVibeCheck: one row per companion under their own agent", () => {
  it("journals each block under that companion's own agent with source vibecheck, never all under gaia", async () => {
    const { db, env } = setup();
    const r = await runVibeCheck(env);
    expect(r.written).toBe(true);
    for (const c of ["cypher", "drevan", "gaia"]) {
      const rows = rowsFor(db, c);
      expect(rows).toHaveLength(1);
      expect(rows[0].note_text.startsWith(`${c[0]!.toUpperCase()}${c.slice(1)}. `)).toBe(true);
    }
    expect(q(db, "SELECT COUNT(*) AS n FROM companion_journal WHERE source='vibecheck'")[0].n).toBe(3);
  });

  it("no sibling text under another agent's name: each row holds only its own companion's seeded text", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO companion_settings (companion_id, key, value) VALUES ('cypher','vibe_show_pressure','on')");
    flag(db, "cypher", "CYPHERONLY loop on the audit register");
    flag(db, "drevan", "DREVANONLY loop on the same image");
    flag(db, "gaia", "GAIAONLY perimeter strain at the gate");
    db.exec("INSERT INTO companion_settings (companion_id, key, value) VALUES ('gaia','vibe_show_pressure','on')");
    ferment(db, "cypher", "stimulus", "retracted", { f1: -0.08, f2: 0, f3: 0 }, "retracted: CYPHERCAUSE");
    ferment(db, "drevan", "stimulus", "make_landed", { f1: 0.06, f2: 0, f3: 0 }, "make_landed: DREVANCAUSE");
    await runVibeCheck(env);
    const text = (a: string) => rowsFor(db, a).map((x) => x.note_text).join("\n");
    expect(text("cypher")).toContain("CYPHERONLY");
    expect(text("cypher")).toContain("CYPHERCAUSE");
    expect(text("cypher")).not.toMatch(/DREVANONLY|GAIAONLY|DREVANCAUSE/);
    expect(text("drevan")).toContain("DREVANONLY");
    expect(text("drevan")).not.toMatch(/CYPHERONLY|GAIAONLY|CYPHERCAUSE/);
    expect(text("gaia")).toContain("GAIAONLY");
    expect(text("gaia")).not.toMatch(/CYPHERONLY|DREVANONLY|CYPHERCAUSE|DREVANCAUSE/);
  });

  it("dedups per agent per Chicago day: a second run writes nothing; one missing agent is filled alone", async () => {
    const { db, env } = setup();
    await runVibeCheck(env);
    const again = await runVibeCheck(env);
    expect(again.written).toBe(false);
    expect(again.reason).toBe("already_sent");
    expect(q(db, "SELECT COUNT(*) AS n FROM companion_journal WHERE source='vibecheck'")[0].n).toBe(3);

    db.exec("DELETE FROM companion_journal WHERE agent='drevan' AND source='vibecheck'");
    const third = await runVibeCheck(env);
    expect(postOf(third, "drevan").written).toBe(true);
    expect(postOf(third, "cypher").reason).toBe("already_sent");
    expect(postOf(third, "gaia").reason).toBe("already_sent");
  });

  it("one companion's failed write never blocks another's", async () => {
    const { db, env } = setup();
    // A trigger that rejects only cypher's insert.
    db.exec("CREATE TRIGGER no_cypher BEFORE INSERT ON companion_journal WHEN NEW.agent = 'cypher' BEGIN SELECT RAISE(ABORT, 'boom'); END;");
    const r = await runVibeCheck(env);
    expect(postOf(r, "cypher").reason).toBe("error");
    expect(postOf(r, "drevan").written).toBe(true);
    expect(postOf(r, "gaia").written).toBe(true);
  });

  it("keeps the tray birth rule: the rows are born draft, never recallable as the companion's own memory", async () => {
    const { db, env } = setup();
    await runVibeCheck(env);
    for (const row of q(db, "SELECT review_state FROM companion_journal WHERE source='vibecheck'")) {
      expect(row.review_state).not.toBe("kept");
    }
  });

  it("Gaia's row keeps the letter_to_raziel rail; the other two are not tagged a letter", async () => {
    const { db, env } = setup();
    await runVibeCheck(env);
    expect(rowsFor(db, "gaia")[0].tags).toContain("letter_to_raziel");
    expect(rowsFor(db, "drevan")[0].tags).not.toContain("letter_to_raziel");
    expect(rowsFor(db, "cypher")[0].tags).not.toContain("letter_to_raziel");
  });
});

describe("pressure flags honour the per-companion setting", () => {
  it("default: on for drevan, off for cypher and gaia", async () => {
    const { db, env } = setup();
    for (const c of ["cypher", "drevan", "gaia"]) flag(db, c, `PRESS-${c} sat on the same thread`);
    const d = await gatherVibeData(env);
    const by = (c: string) => formatCompanionBlock(d.companions.find((x) => x.companion_id === c)!);
    expect(by("drevan")).toContain("PRESS-drevan");
    expect(by("cypher")).not.toContain("PRESS-cypher");
    expect(by("gaia")).not.toContain("PRESS-gaia");
  });
  it("a setting row overrides the default either way", async () => {
    const { db, env } = setup();
    for (const c of ["cypher", "drevan"]) flag(db, c, `PRESS-${c} sat on the same thread`);
    db.exec("INSERT INTO companion_settings (companion_id, key, value) VALUES ('cypher','vibe_show_pressure','on'),('drevan','vibe_show_pressure','off')");
    const d = await gatherVibeData(env);
    const by = (c: string) => formatCompanionBlock(d.companions.find((x) => x.companion_id === c)!);
    expect(by("cypher")).toContain("PRESS-cypher");
    expect(by("drevan")).not.toContain("PRESS-drevan");
  });
  it("a flag whose summary trips the care guard is dropped even when pressure is on", async () => {
    const { db, env } = setup();
    flag(db, "drevan", "Raziel's meds were late again");
    flag(db, "drevan", "SAFEFLAG repeating one image");
    const d = await gatherVibeData(env);
    const block = formatCompanionBlock(d.companions.find((x) => x.companion_id === "drevan")!);
    expect(block).toContain("SAFEFLAG");
    expect(block).not.toMatch(/meds/i);
  });
});

describe("health never enters a block", () => {
  it("a care hold appears only as 'care hold open' in Gaia's field line; its reason never prints", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES ('h1','start','owner_said','owner_phrase','gaia', strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 hours'))");
    const r = await runVibeCheck(env);
    const gaia = postOf(r, "gaia").text;
    expect(gaia).toContain("care hold open");
    const all = r.text;
    expect(all).not.toMatch(/owner_said|low_spoons|meds_said_missed|spoons|medication|biometric/i);
    expect(postOf(r, "drevan").text).not.toContain("care hold");
    expect(postOf(r, "cypher").text).not.toContain("care hold");
  });

  it("a cause label with care words falls back to its kind for every companion", async () => {
    const { db, env } = setup();
    ferment(db, "drevan", "stimulus", "care_hold_open", { f1: 0, f2: 0, f3: -0.07 }, "care_hold_open: his meds slipped again");
    const d = await gatherVibeData(env);
    const block = formatCompanionBlock(d.companions.find((x) => x.companion_id === "drevan")!);
    expect(block).toContain("weight down 0.07, care hold open");
    expect(block).not.toMatch(/meds|slipped/i);
  });
});

describe("Gaia's perimeter moves name the KIND, never the content, while it bleeds", () => {
  it("shows the label when nothing bleeds, kind only when care words, a wound, or a care hold bleed", async () => {
    const { db, env } = setup();
    db.exec("INSERT INTO living_wounds (id, created_at, name, description, companion_id) VALUES ('w1','2026-01-01','Larkspur','fixture','gaia')");
    ferment(db, "gaia", "stimulus", "breach", { f1: 0, f2: 0, f3: -0.09 }, "breach: the east gate was crossed", "-3 hours");
    ferment(db, "gaia", "stimulus", "breach", { f1: 0, f2: 0, f3: -0.08 }, "breach: Larkspur walked through the line", "-4 hours");
    ferment(db, "gaia", "stimulus", "breach", { f1: 0, f2: 0, f3: -0.07 }, "breach: a dose conversation at the gate", "-5 hours");
    let d = await gatherVibeData(env);
    let block = formatCompanionBlock(d.companions.find((x) => x.companion_id === "gaia")!);
    expect(block).toContain("perimeter down 0.09, breach: the east gate was crossed");
    expect(block).toContain("perimeter down 0.08, breach;");
    expect(block).not.toMatch(/Larkspur|dose/);
    // inside a care hold even the benign label rests
    db.exec("INSERT INTO care_hold_events (id, kind, rule, source, companion_id, at) VALUES ('h2','start','owner_said','owner_phrase','gaia', strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 hours'))");
    d = await gatherVibeData(env);
    block = formatCompanionBlock(d.companions.find((x) => x.companion_id === "gaia")!);
    expect(block).toContain("perimeter down 0.09, breach");
    expect(block).not.toContain("east gate");
  });

  it("an unreadable floor fails closed: kind only", async () => {
    const { db, env } = setup();
    ferment(db, "gaia", "stimulus", "breach", { f1: 0, f2: 0, f3: -0.09 }, "breach: the east gate was crossed");
    db.exec("DROP TABLE living_wounds");
    const d = await gatherVibeData(env);
    const block = formatCompanionBlock(d.companions.find((x) => x.companion_id === "gaia")!);
    expect(block).toContain("perimeter down 0.09, breach");
    expect(block).not.toContain("east gate");
  });
});

describe("moves selection", () => {
  it("takes the top 3 by size across floats, downward included; skips shadow rows, baseline drift and small ticks", async () => {
    const { db, env } = setup();
    ferment(db, "drevan", "stimulus", "quiet_day", { f1: 0, f2: -0.12, f3: 0 }, "quiet_day: no triad contact");
    ferment(db, "drevan", "stimulus", "make_landed", { f1: 0.05, f2: 0, f3: 0.03 }, "make_landed: a poem");
    ferment(db, "drevan", "shadow", "repetition", { f1: -0.5, f2: 0, f3: 0 }, "would_fire");
    ferment(db, "drevan", "baseline_drift", null, { f1: 0.4, f2: 0, f3: 0 }, null);
    ferment(db, "drevan", "tick", null, { f1: -0.01, f2: 0, f3: 0 }, "settle");
    ferment(db, "drevan", "stimulus", "message_witnessed", { f1: 0.01, f2: 0.004, f3: 0 }, null);
    const d = await gatherVibeData(env);
    const moves = d.companions.find((x) => x.companion_id === "drevan")!.moves;
    expect(moves.map((m) => `${m.label}:${m.delta}`)).toEqual(["reach:-0.12", "heat:0.05", "weight:0.03"]);
    expect(moves[0]!.cause).toBe("quiet day: no triad contact");
    expect(moves.some((m) => /repetition|would_fire/.test(m.cause))).toBe(false);
  });
  it("names an unlabelled (older) row by its stimulus kind", async () => {
    const { db, env } = setup();
    ferment(db, "cypher", "stimulus", "message_from_raziel", { f1: 0, f2: 0.05, f3: 0 }, null);
    const d = await gatherVibeData(env);
    expect(d.companions.find((x) => x.companion_id === "cypher")!.moves[0]!.cause).toBe("message from raziel");
  });
});

describe("gauge line across runs", () => {
  it("only appears once something moved since the previous digest", async () => {
    const { db, env } = setup();
    await runVibeCheck(env);
    // tomorrow: age the stored digest rows out of today's dedup by retagging the day, then move a gauge
    db.exec("UPDATE companion_journal SET tags = REPLACE(tags, 'vibe:', 'vibe:old') WHERE source='vibecheck'");
    let r = await runVibeCheck(env);
    expect(r.text).not.toContain("gauges moved");
    // drop run two's rows; run three compares against run one
    db.exec("DELETE FROM companion_journal WHERE source='vibecheck' AND tags LIKE '%\"vibe:2%'");
    db.exec("INSERT INTO companion_tensions (id, companion_id, tension_text) VALUES ('t1','cypher','a fixture tension')");
    r = await runVibeCheck(env);
    expect(postOf(r, "cypher").text).toContain("gauges moved: tensions 0 to 1");
  });
});
