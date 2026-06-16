// Tests for the Unified Guardian (migration 0073): deterministic detectors,
// dedup + auto-resolve run semantics, flag lifecycle, weekly letter.

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Env } from "../types.js";

// Handler tests mock the detector module so run semantics are isolated from SQL.
vi.mock("../guardian/detectors.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../guardian/detectors.js")>();
  return { ...actual, runAllDetectors: vi.fn(async () => []) };
});

import {
  detectVoiceDrift, detectStarvedOrgans, detectRunCadence, detectOrphanedMemories,
  detectStuckLoops, detectBasinPressure, runAllDetectors, type CandidateFlag,
} from "../guardian/detectors.js";
import { postGuardianRun, getGuardianFlags, patchGuardianFlag } from "../handlers/guardian.js";

const mockedRunAll = vi.mocked(runAllDetectors);

interface Row { [k: string]: unknown }
type Matcher = { when: (sql: string, bound: unknown[]) => boolean; first?: Row | null; all?: Row[] };

const LIVE = ["open", "surfaced", "acknowledged"];

/** Scripted D1 fake: reads answer from matchers; guardian_flags/runs/journal
 *  writes hit real in-memory stores so dedup + resolve semantics are testable. */
class FakeDb {
  matchers: Matcher[] = [];
  flags: Row[] = [];
  runs: Row[] = [];
  journal: Row[] = [];

  prepare(sql: string) {
    return new FakeStatement(sql, this);
  }
}

class FakeStatement {
  constructor(private sql: string, private db: FakeDb, private bound: unknown[] = []) {}
  bind(...args: unknown[]): FakeStatement {
    return new FakeStatement(this.sql, this.db, args);
  }

  async first(): Promise<Row | null> {
    if (this.sql.includes("COUNT(*) AS n FROM guardian_flags")) {
      return { n: this.db.flags.filter(f => LIVE.includes(f["status"] as string)).length };
    }
    const m = this.db.matchers.find(m => m.when(this.sql, this.bound));
    return m?.first ?? null;
  }

  async all(): Promise<{ results: Row[] }> {
    if (this.sql.includes("FROM guardian_flags")) {
      let rows = this.db.flags;
      if (this.sql.includes("status IN ('open','surfaced','acknowledged')")) {
        rows = rows.filter(f => LIVE.includes(f["status"] as string));
      }
      return { results: rows };
    }
    const m = this.db.matchers.find(m => m.when(this.sql, this.bound));
    return { results: m?.all ?? [] };
  }

  async run(): Promise<{ meta: { changes: number } }> {
    if (this.sql.includes("INSERT OR IGNORE INTO guardian_flags")) {
      const [id, companion_id, flag_type, severity, summary, evidence_json, dedup_key] = this.bound as (string | null)[];
      const liveDup = this.db.flags.find(f => f["dedup_key"] === dedup_key && LIVE.includes(f["status"] as string));
      if (liveDup) return { meta: { changes: 0 } };
      this.db.flags.push({ id, companion_id, flag_type, severity, summary, evidence_json, dedup_key, status: "open", surfaced_at: null, resolved_at: null });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("UPDATE guardian_flags") && this.sql.includes("dedup_key NOT IN")) {
      const keep = new Set(this.bound as string[]);
      let changes = 0;
      for (const f of this.db.flags) {
        if (LIVE.includes(f["status"] as string) && !keep.has(f["dedup_key"] as string)) {
          f["status"] = "resolved";
          f["resolved_at"] = new Date().toISOString();
          changes++;
        }
      }
      return { meta: { changes } };
    }
    if (this.sql.includes("UPDATE guardian_flags SET status = 'resolved'")) {
      // resolve-all variant (no NOT IN clause -- zero candidates this run)
      let changes = 0;
      for (const f of this.db.flags) {
        if (LIVE.includes(f["status"] as string)) { f["status"] = "resolved"; changes++; }
      }
      return { meta: { changes } };
    }
    if (this.sql.includes("UPDATE guardian_flags SET status = ?")) {
      const [status, , id] = this.bound as [string, string, string];
      const row = this.db.flags.find(f => f["id"] === id && f["status"] !== "resolved");
      if (!row) return { meta: { changes: 0 } };
      row["status"] = status;
      if (status === "resolved") row["resolved_at"] = new Date().toISOString();
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO guardian_runs")) {
      const [id, mode, flags_created, flags_resolved, stats_json] = this.bound;
      this.db.runs.push({ id, mode, flags_created, flags_resolved, stats_json });
      return { meta: { changes: 1 } };
    }
    if (this.sql.includes("INSERT INTO companion_journal")) {
      // agent is a SQL literal ('guardian'), not a binding
      const [id, note_text, tags] = this.bound as string[];
      this.db.journal.push({ id, agent: "guardian", note_text, tags });
      return { meta: { changes: 1 } };
    }
    return { meta: { changes: 0 } };
  }
}

function makeEnv(db: FakeDb): Env {
  // no ADMIN_SECRET -> authGuard skips (local-dev path)
  return { DB: db } as unknown as Env;
}

function postReq(body?: unknown): Request {
  return new Request("http://local/mind/guardian/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}

let db: FakeDb;
let env: Env;
beforeEach(() => {
  db = new FakeDb();
  env = makeEnv(db);
  mockedRunAll.mockReset();
  mockedRunAll.mockResolvedValue([]);
});

// ── Detector: starved organs ─────────────────────────────────────────────────

function scriptHealthyOrgans(db: FakeDb): void {
  db.matchers.push(
    { when: sql => sql.includes("FROM companion_tensions"), first: { n: 1 } },
    { when: sql => sql.includes("FROM metronome_actions"), first: { palette: 18, fired_recent: 4 } },
    { when: sql => sql.includes("FROM autonomy_seeds"), first: { n: 7 } },
    { when: sql => sql.includes("FROM forage_finds"), first: { unconsumed: 3, oldest: new Date(Date.now() - 86400_000).toISOString() } },
    { when: sql => sql.includes("FROM club_rounds"), first: { id: "r1", status: "gathering", opened_at: new Date(Date.now() - 86400_000).toISOString() } },
  );
}

describe("detectStarvedOrgans", () => {
  it("flags starved:dialectic when the tension pool has zero simmering", async () => {
    scriptHealthyOrgans(db);
    db.matchers.unshift({ when: sql => sql.includes("FROM companion_tensions"), first: { n: 0 } });
    const flags = await detectStarvedOrgans(env);
    expect(flags.map(f => f.dedup_key)).toContain("starved:dialectic");
  });

  it("stays silent when every organ is fed", async () => {
    scriptHealthyOrgans(db);
    const flags = await detectStarvedOrgans(env);
    expect(flags).toHaveLength(0);
  });

  it("flags a silent metronome and an empty seed queue", async () => {
    scriptHealthyOrgans(db);
    db.matchers.unshift(
      { when: sql => sql.includes("FROM metronome_actions"), first: { palette: 18, fired_recent: 0 } },
      { when: (sql, bound) => sql.includes("FROM autonomy_seeds") && bound[0] === "drevan", first: { n: 0 } },
    );
    const flags = await detectStarvedOrgans(env);
    const keys = flags.map(f => f.dedup_key);
    expect(keys).toContain("starved:metronome");
    expect(keys).toContain("starved:seeds:drevan");
    expect(keys).not.toContain("starved:seeds:cypher");
  });

  it("flags a club round stuck in gathering past the threshold", async () => {
    scriptHealthyOrgans(db);
    db.matchers.unshift({
      when: sql => sql.includes("FROM club_rounds"),
      first: { id: "r1", status: "gathering", opened_at: new Date(Date.now() - 5 * 86400_000).toISOString() },
    });
    const flags = await detectStarvedOrgans(env);
    expect(flags.some(f => f.dedup_key.startsWith("stuck:club:r1"))).toBe(true);
  });
});

// ── Detector: voice drift ────────────────────────────────────────────────────

describe("detectVoiceDrift", () => {
  function voiceRow(companion: string, row: Row): Matcher {
    return { when: (sql, bound) => sql.includes("FROM voice_scores") && bound[0] === companion, first: row };
  }

  it("requires the minimum sample count before judging", async () => {
    db.matchers.push(
      voiceRow("cypher", { recent_avg: 0.1, recent_n: 4, contaminated_n: 0, baseline_avg: null }),
      voiceRow("drevan", { recent_avg: null, recent_n: 0, contaminated_n: 0, baseline_avg: null }),
      voiceRow("gaia", { recent_avg: null, recent_n: 0, contaminated_n: 0, baseline_avg: null }),
    );
    expect(await detectVoiceDrift(env)).toHaveLength(0);
  });

  it("warns below the absolute floor and on a drop vs baseline", async () => {
    db.matchers.push(
      voiceRow("cypher", { recent_avg: 0.45, recent_n: 8, contaminated_n: 0, baseline_avg: null }),
      voiceRow("drevan", { recent_avg: 0.6, recent_n: 8, contaminated_n: 0, baseline_avg: 0.8 }),
      voiceRow("gaia", { recent_avg: 0.75, recent_n: 8, contaminated_n: 0, baseline_avg: 0.78 }),
    );
    const flags = await detectVoiceDrift(env);
    expect(flags.map(f => f.dedup_key).sort()).toEqual(["voice_drift:cypher", "voice_drift:drevan"]);
    expect(flags.every(f => f.severity === "warning")).toBe(true);
  });

  it("goes red on contamination rate above threshold", async () => {
    db.matchers.push(
      voiceRow("cypher", { recent_avg: 0.7, recent_n: 10, contaminated_n: 3, baseline_avg: 0.7 }),
      voiceRow("drevan", { recent_avg: 0.7, recent_n: 10, contaminated_n: 0, baseline_avg: 0.7 }),
      voiceRow("gaia", { recent_avg: 0.7, recent_n: 10, contaminated_n: 0, baseline_avg: 0.7 }),
    );
    const flags = await detectVoiceDrift(env);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe("red");
    expect(flags[0]!.dedup_key).toBe("voice_contamination:cypher");
  });

  it("does NOT flag when contamination is high only because clean rows are 10%-sampled", async () => {
    // Real 06-15 prod shape: cypher 4 contaminated, 2 clean stored, n=7. The naive
    // ratio 4/7=57% would red-flag; un-biasing the 2 clean rows (x10) gives
    // 4/(5+20)=16% < 20%, so no flag. Same correction clears drevan 8/(8+70)=10%.
    db.matchers.push(
      voiceRow("cypher", { recent_avg: 0.86, recent_n: 7, contaminated_n: 4, clean_n: 2, baseline_avg: 0.86 }),
      voiceRow("drevan", { recent_avg: 0.89, recent_n: 15, contaminated_n: 8, clean_n: 7, baseline_avg: 0.89 }),
      voiceRow("gaia", { recent_avg: 0.88, recent_n: 5, contaminated_n: 0, clean_n: 1, baseline_avg: 0.88 }),
    );
    const flags = await detectVoiceDrift(env);
    expect(flags.filter(f => f.dedup_key.startsWith("voice_contamination:"))).toHaveLength(0);
  });
});

// ── Detector: orphan-memory rescue ───────────────────────────────────────────

describe("detectOrphanedMemories", () => {
  it("re-surfaces never-accessed continuity notes for known companions only", async () => {
    db.matchers.push({
      when: sql => sql.includes("FROM wm_continuity_notes"),
      all: [
        { note_id: "n1", agent_id: "cypher", content: "the bridge thread we never came back to", created_at: "2026-05-01 12:00:00" },
        { note_id: "n2", agent_id: "stranger", content: "not a companion", created_at: "2026-05-01 12:00:00" },
      ],
    });
    const flags = await detectOrphanedMemories(env);
    expect(flags.map(f => f.dedup_key)).toEqual(["orphan:n1"]);
    expect(flags[0]!.flag_type).toBe("orphan_memory");
    expect(flags[0]!.companion_id).toBe("cypher");
  });

  it("stays silent when nothing is orphaned", async () => {
    db.matchers.push({ when: sql => sql.includes("FROM wm_continuity_notes"), all: [] });
    expect(await detectOrphanedMemories(env)).toHaveLength(0);
  });
});

// ── Detector: stuck loops ────────────────────────────────────────────────────

describe("detectStuckLoops", () => {
  it("maps an over-threshold open loop to a loop_stuck flag for known companions only", async () => {
    db.matchers.push({
      when: sql => sql.includes("FROM companion_open_loops"),
      all: [
        { id: "l1", companion_id: "drevan", loop_text: "the thing we never came back to", opened_at: "2026-05-01 12:00:00" },
        { id: "l2", companion_id: "stranger", loop_text: "not a companion", opened_at: "2026-05-01 12:00:00" },
      ],
    });
    const flags = await detectStuckLoops(env);
    expect(flags.map(f => f.dedup_key)).toEqual(["loop_stuck:l1"]);
    expect(flags[0]!.flag_type).toBe("loop_stuck");
    expect(flags[0]!.companion_id).toBe("drevan");
    expect((flags[0]!.evidence as { loop_id: string }).loop_id).toBe("l1");
  });

  it("queries with the reviewed_at hold-suppression guard (migration 0082)", async () => {
    let seenSql = "";
    db.matchers.push({
      when: sql => { if (sql.includes("FROM companion_open_loops")) seenSql = sql; return sql.includes("FROM companion_open_loops"); },
      all: [],
    });
    await detectStuckLoops(env);
    expect(seenSql).toContain("reviewed_at");
  });
});

// ── Detector: basin pressure ─────────────────────────────────────────────────

describe("detectBasinPressure", () => {
  it("flags a companion over the unaddressed-pressure threshold", async () => {
    db.matchers.push({
      when: sql => sql.includes("FROM companion_basin_history"),
      all: [{ companion_id: "gaia", n: 4 }],
    });
    const flags = await detectBasinPressure(env);
    expect(flags.map(f => f.dedup_key)).toEqual(["basin_pressure:gaia"]);
  });

  it("excludes both confirmed AND dismissed readings (migration 0083)", async () => {
    let seenSql = "";
    db.matchers.push({
      when: sql => { if (sql.includes("FROM companion_basin_history")) seenSql = sql; return sql.includes("FROM companion_basin_history"); },
      all: [],
    });
    await detectBasinPressure(env);
    expect(seenSql).toContain("caleth_confirmed = 0");
    expect(seenSql).toContain("dismissed_at IS NULL");
  });
});

// ── Detector: run cadence ────────────────────────────────────────────────────

describe("detectRunCadence", () => {
  it("flags cap-riding as burnout and zero delivery as starved", async () => {
    db.matchers.push({
      when: sql => sql.includes("FROM autonomy_runs"),
      all: [{ companion_id: "cypher", n: 14 }, { companion_id: "drevan", n: 5 }],
    });
    const flags = await detectRunCadence(env);
    const keys = flags.map(f => f.dedup_key).sort();
    expect(keys).toEqual(["burnout:cypher", "starved:autonomy:gaia"]);
  });
});

// ── Handler: run semantics (dedup + auto-resolve + letter) ──────────────────

const candidate = (dedup: string, companion: CandidateFlag["companion_id"] = null): CandidateFlag => ({
  companion_id: companion,
  flag_type: "starved_organ",
  severity: "notice",
  summary: `condition ${dedup}`,
  evidence: { dedup },
  dedup_key: dedup,
});

describe("postGuardianRun", () => {
  it("inserts new flags once; re-detection while live is a no-op; cleared conditions auto-resolve", async () => {
    mockedRunAll.mockResolvedValue([candidate("starved:dialectic"), candidate("starved:seeds:cypher", "cypher")]);
    const r1 = await (await postGuardianRun(postReq({}), env)).json() as { flags_created: number; flags_resolved: number };
    expect(r1.flags_created).toBe(2);

    const r2 = await (await postGuardianRun(postReq({}), env)).json() as { flags_created: number; flags_resolved: number };
    expect(r2.flags_created).toBe(0);
    expect(r2.flags_resolved).toBe(0);

    mockedRunAll.mockResolvedValue([candidate("starved:dialectic")]);
    const r3 = await (await postGuardianRun(postReq({}), env)).json() as { flags_created: number; flags_resolved: number };
    expect(r3.flags_created).toBe(0);
    expect(r3.flags_resolved).toBe(1);
    expect(db.flags.find(f => f["dedup_key"] === "starved:seeds:cypher")!["status"]).toBe("resolved");
    expect(db.runs).toHaveLength(3);
  });

  it("writes the weekly letter as agent=guardian with the letter_to_raziel tag", async () => {
    mockedRunAll.mockResolvedValue([]);
    const res = await (await postGuardianRun(postReq({ letter: true }), env)).json() as { letter_id: string | null };
    expect(res.letter_id).toBeTruthy();
    expect(db.journal).toHaveLength(1);
    expect(db.journal[0]!["agent"]).toBe("guardian");
    expect(db.journal[0]!["tags"]).toContain("letter_to_raziel");
    expect(db.journal[0]!["note_text"]).toContain("Guardian weekly read");
  });
});

// ── Handler: flag lifecycle ──────────────────────────────────────────────────

describe("flag lifecycle", () => {
  function patchReq(body: unknown): Request {
    return new Request("http://local/mind/guardian/flags/x", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("acknowledge then resolve; resolving twice 404s", async () => {
    db.flags.push({ id: "gf_1", dedup_key: "k", status: "surfaced", severity: "notice", summary: "s" });
    expect((await patchGuardianFlag(patchReq({ status: "acknowledged" }), env, { id: "gf_1" })).status).toBe(200);
    expect(db.flags[0]!["status"]).toBe("acknowledged");
    expect((await patchGuardianFlag(patchReq({ status: "resolved" }), env, { id: "gf_1" })).status).toBe(200);
    expect((await patchGuardianFlag(patchReq({ status: "resolved" }), env, { id: "gf_1" })).status).toBe(404);
  });

  it("rejects invalid status", async () => {
    expect((await patchGuardianFlag(patchReq({ status: "open" }), env, { id: "gf_1" })).status).toBe(400);
  });

  it("GET live returns only unresolved flags", async () => {
    db.flags.push(
      { id: "gf_1", dedup_key: "a", status: "open", severity: "notice", summary: "s" },
      { id: "gf_2", dedup_key: "b", status: "resolved", severity: "notice", summary: "s" },
    );
    const res = await (await getGuardianFlags(new Request("http://local/mind/guardian/flags?status=live"), env)).json() as { flags: Row[] };
    expect(res.flags).toHaveLength(1);
    expect(res.flags[0]!["id"]).toBe("gf_1");
  });
});
