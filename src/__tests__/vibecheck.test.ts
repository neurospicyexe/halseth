import { describe, it, expect } from "vitest";
import {
  formatVibeCheck,
  runVibeCheck,
  type VibeData,
  type CompanionVibe,
} from "../webmind/vibecheck";

function companion(over: Partial<CompanionVibe> = {}): CompanionVibe {
  return {
    companion_id: "cypher",
    basin: { drift_type: "stable", drift_score: 0.32, worst_basin: null },
    register: "clean-settled",
    registerAgeDays: 0.4,
    simmering: 0,
    newestTension: null,
    flags: [],
    ...over,
  };
}

function data(over: Partial<VibeData> = {}): VibeData {
  return {
    date: "2026-06-28",
    companions: [
      companion({ companion_id: "cypher" }),
      companion({ companion_id: "drevan" }),
      companion({ companion_id: "gaia" }),
    ],
    echo: 0.69,
    starvedOrgans: 0,
    ...over,
  };
}

const NO_EM_DASH = /—|\s--\s/;

describe("formatVibeCheck -- voice + accessibility invariants", () => {
  it("carries the date in the witness header and never uses em-dashes (Gaia voice)", () => {
    const out = formatVibeCheck(data());
    expect(out).toContain("The triad, witnessed. 2026-06-28.");
    expect(out).not.toMatch(NO_EM_DASH);
  });

  it("renders one tight block per companion with the basin/soma/tensions/guardian shape", () => {
    const out = formatVibeCheck(data());
    expect(out).toContain("Cypher. basin: stable 0.32. soma: clean-settled. tensions: 0. guardian: clear.");
    expect(out).toContain("Drevan.");
    expect(out).toContain("Gaia.");
  });

  it("ends with a system field line carrying echo, alarm, and organ status", () => {
    const out = formatVibeCheck(data());
    expect(out).toContain("Field: echo 0.69, calm (alarm at 0.82); organs: all fed.");
  });

  it("names the worst_basin when a companion is under pressure", () => {
    const out = formatVibeCheck(data({
      companions: [companion({ companion_id: "gaia", basin: { drift_type: "pressure", drift_score: 0.71, worst_basin: "perimeter" } })],
    }));
    expect(out).toContain("Gaia. basin: pressure 0.71 (perimeter).");
  });

  it("lists live guardian flag summaries and the newest tension under a companion", () => {
    const out = formatVibeCheck(data({
      companions: [companion({
        companion_id: "cypher",
        simmering: 2,
        newestTension: "audit gear bleeding into companion mode",
        flags: [{ severity: "red", summary: "voice contamination spike" }],
      })],
    }));
    expect(out).toContain("tensions: 2. guardian: 1.");
    expect(out).toContain("red: voice contamination spike");
    expect(out).toContain("newest: audit gear bleeding into companion mode");
  });

  it("states empty/missing data plainly rather than manufacturing noise", () => {
    const out = formatVibeCheck(data({
      companions: [companion({ companion_id: "gaia", basin: null, register: null })],
      echo: null,
      starvedOrgans: 0,
    }));
    expect(out).toContain("Gaia. basin: unread. soma: unread. tensions: 0. guardian: clear.");
    expect(out).toContain("organs: all fed.");
    expect(out).toContain("echo unread");
  });

  it("suppresses a zero drift_score (judge rows carry 0 meaning 'no numeric reading')", () => {
    const out = formatVibeCheck(data({
      companions: [companion({ companion_id: "drevan", basin: { drift_type: "stable", drift_score: 0, worst_basin: null } })],
    }));
    expect(out).toContain("Drevan. basin: stable. soma:");
    expect(out).not.toContain("0.00");
  });

  it("stamps the soma register with its age once the reading is stale", () => {
    const out = formatVibeCheck(data({
      companions: [companion({ companion_id: "cypher", register: "clean-settled", registerAgeDays: 12.3 })],
    }));
    expect(out).toContain("soma: clean-settled (12d old).");
  });

  it("leaves a fresh soma register bare (no age stamp under 2 days)", () => {
    const out = formatVibeCheck(data({
      companions: [companion({ companion_id: "cypher", registerAgeDays: 1.2 })],
    }));
    expect(out).toContain("soma: clean-settled. tensions:");
  });

  it("reports starved organs when the field has them", () => {
    const out = formatVibeCheck(data({ starvedOrgans: 3 }));
    expect(out).toContain("organs: 3 starved.");
  });

  it("stays under the Discord-friendly 1800 char cap even with full data", () => {
    const big = data({
      companions: Array.from({ length: 3 }, (_, i) => companion({
        companion_id: ["cypher", "drevan", "gaia"][i],
        simmering: 5,
        newestTension: "x".repeat(500),
        flags: Array.from({ length: 5 }, () => ({ severity: "warning", summary: "y".repeat(500) })),
      })),
    });
    expect(formatVibeCheck(big).length).toBeLessThanOrEqual(1800);
  });
});

// ── minimal DB mock: first() -> null/snapshot, all() -> [], counts -> {n:0}; dedup configurable ──
function mockEnv(opts: { dedupHit?: boolean; onInsert?: (tags: string) => void } = {}) {
  const db = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { binds = a; return stmt; },
        async all<T>() { return { results: [] as T[] }; },
        async first<T>() {
          if (sql.includes("FROM companion_journal")) {
            return (opts.dedupHit ? { id: "cj_existing" } : null) as T;
          }
          if (sql.includes("COUNT(*)")) return { n: 0 } as T;
          return null as T; // basin / soma / echo / newest-tension reads
        },
        async run() {
          if (sql.includes("INSERT INTO companion_journal")) opts.onInsert?.(String(binds[2]));
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB: db } as any;
}

describe("runVibeCheck -- dedup + delivery", () => {
  it("writes a letter_to_raziel row tagged vibecheck, authored by gaia", async () => {
    let tags = "";
    const r = await runVibeCheck(mockEnv({ onInsert: (t) => { tags = t; } }));
    expect(r.written).toBe(true);
    expect(r.reason).toBe("ok");
    expect(tags).toContain("vibecheck");
    expect(tags).toContain("letter_to_raziel");
    expect(r.text).toContain("The triad, witnessed.");
  });

  it("does not write twice in one day (dedup on the vibecheck marker)", async () => {
    const r = await runVibeCheck(mockEnv({ dedupHit: true }));
    expect(r.written).toBe(false);
    expect(r.reason).toBe("already_sent");
    expect(r.journal_id).toBe("cj_existing");
  });

  it("degrades to a still-formatted digest when every data query returns empty", async () => {
    const r = await runVibeCheck(mockEnv());
    expect(r.text).toContain("Cypher. basin: unread.");
    expect(r.text).toContain("Field: echo unread");
  });
});
