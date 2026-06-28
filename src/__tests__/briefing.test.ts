import { describe, it, expect } from "vitest";
import {
  formatBriefing,
  runBriefing,
  isBriefingKind,
  type BriefingData,
} from "../webmind/briefing";

function data(over: Partial<BriefingData> = {}): BriefingData {
  return {
    date: "2026-06-28",
    openTasks: [],
    doneToday: 0,
    heldQuestions: [],
    liveFlags: [],
    ratifyPending: 0,
    simmering: 0,
    ...over,
  };
}

const NO_EM_DASH = /—|\s--\s/;

describe("formatBriefing -- voice + accessibility invariants", () => {
  it("every kind carries the date and never uses em-dashes (CLAUDE.md voice)", () => {
    for (const kind of ["morning", "midday", "evening"] as const) {
      const out = formatBriefing(kind, data({ openTasks: [{ title: "x", priority: "high", due_at: null }] }));
      expect(out).toContain("2026-06-28");
      expect(out).not.toMatch(NO_EM_DASH);
    }
  });

  it("midday is a single line (cheap to read mid-task)", () => {
    const out = formatBriefing("midday", data({ openTasks: [{ title: "a", priority: "low", due_at: null }] }));
    expect(out.split("\n")).toHaveLength(1);
    expect(out).toContain("Board 1");
  });

  it("morning empty-state says clear and surfaces a rest-permitting focus, not noise", () => {
    const out = formatBriefing("morning", data());
    expect(out).toContain("Board: clear.");
    expect(out).toContain("Focus: open. Nothing is demanding you.");
  });

  it("morning surfaces ONE focus -- a red guardian flag beats an urgent task", () => {
    const out = formatBriefing("morning", data({
      liveFlags: [{ severity: "red", summary: "voice contamination spike" }],
      openTasks: [{ title: "ship the thing", priority: "urgent", due_at: null }],
    }));
    expect(out).toMatch(/Focus: guardian flag\./);
    expect(out).toContain("voice contamination spike");
  });

  it("morning focus falls through to the urgent/high task when no red flag", () => {
    const out = formatBriefing("morning", data({
      openTasks: [
        { title: "low thing", priority: "low", due_at: null },
        { title: "ship the thing", priority: "high", due_at: null },
      ],
    }));
    expect(out).toContain("Focus: ship the thing.");
  });

  it("morning caps the board at 4 and orders urgent-first", () => {
    const out = formatBriefing("morning", data({
      openTasks: Array.from({ length: 8 }, (_, i) => ({ title: `t${i}`, priority: "normal", due_at: null })).concat([
        { title: "URGENT-ONE", priority: "urgent", due_at: null },
      ]),
    }));
    const bullets = out.split("\n").filter(l => l.trim().startsWith("•"));
    expect(bullets).toHaveLength(4);
    expect(bullets[0]).toContain("URGENT-ONE");
  });

  it("evening pluralises correctly and reports closed count", () => {
    const one = formatBriefing("evening", data({ doneToday: 3, openTasks: [{ title: "a", priority: "low", due_at: null }], ratifyPending: 1 }));
    expect(one).toContain("Closed today: 3.");
    expect(one).toContain("1 task,");
    expect(one).toContain("1 ratification.");
    const many = formatBriefing("evening", data({ openTasks: [
      { title: "a", priority: "low", due_at: null }, { title: "b", priority: "low", due_at: null },
    ] }));
    expect(many).toContain("2 tasks,");
  });

  it("ratification line is non-coercive (whenever you have capacity)", () => {
    const out = formatBriefing("morning", data({ ratifyPending: 5 }));
    expect(out).toMatch(/Ratification: 5 pending \(yes\/no, whenever you have capacity\)\./);
  });
});

describe("isBriefingKind", () => {
  it("accepts the three daily kinds and rejects weekly (guardian owns weekly)", () => {
    expect(isBriefingKind("morning")).toBe(true);
    expect(isBriefingKind("evening")).toBe(true);
    expect(isBriefingKind("weekly")).toBe(false);
    expect(isBriefingKind("garbage")).toBe(false);
  });
});

// ── minimal DB mock: counts -> {n:0}, lists -> [], dedup SELECT -> configurable ───────────────
function mockEnv(opts: { enabled?: boolean; dedupHit?: boolean; onInsert?: (tags: string) => void } = {}) {
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
          return { n: 0 } as T; // COUNT(*) AS n
        },
        async run() {
          if (sql.includes("INSERT INTO companion_journal")) opts.onInsert?.(String(binds[2]));
          return { meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return { DB: db, BRIEFING_ENABLED: opts.enabled ? "true" : undefined } as any;
}

describe("runBriefing -- gate + idempotency", () => {
  it("is a no-op when BRIEFING_ENABLED is unset (ships dormant)", async () => {
    const r = await runBriefing(mockEnv({ enabled: false }), "morning");
    expect(r.written).toBe(false);
    expect(r.reason).toBe("gated");
    expect(r.text).toContain("Morning brief.");
  });

  it("force overrides the gate and writes a letter_to_raziel row tagged with the kind", async () => {
    let tags = "";
    const r = await runBriefing(mockEnv({ enabled: false, onInsert: (t) => { tags = t; } }), "evening", { force: true });
    expect(r.written).toBe(true);
    expect(r.reason).toBe("ok");
    expect(tags).toContain("letter_to_raziel");
    expect(tags).toContain("briefing:evening");
  });

  it("does not write twice in one day (dedup on the kind marker)", async () => {
    const r = await runBriefing(mockEnv({ enabled: true, dedupHit: true }), "morning");
    expect(r.written).toBe(false);
    expect(r.reason).toBe("already_sent");
    expect(r.journal_id).toBe("cj_existing");
  });

  it("writes when enabled and no prior briefing exists today", async () => {
    const r = await runBriefing(mockEnv({ enabled: true, dedupHit: false }), "midday");
    expect(r.written).toBe(true);
    expect(r.reason).toBe("ok");
  });
});
