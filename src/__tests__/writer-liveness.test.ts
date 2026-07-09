// Writer-liveness registry tests (2026-07-09).
//
// The regression under test is real: Brain's swarm evaluator stopped writing
// companion_journal source='discord_swarm' on 2026-06-25 and nobody noticed for two weeks.
// These assert the instrument would have caught it, and that it doesn't cry wolf.

import { describe, it, expect } from "vitest";
import {
  WRITER_REGISTRY,
  isWriterSilent,
  parseWriterTs,
  detectDeadWriters,
  type WriterSpec,
} from "../guardian/writer-liveness.js";

const spec = (over: Partial<WriterSpec> = {}): WriterSpec => ({
  key: "test_writer",
  label: "Test writer",
  maxSilenceHours: 48,
  severity: "warning",
  sql: "SELECT MAX(created_at) AS ts FROM companion_journal",
  ...over,
});

const HOUR = 3_600_000;
const NOW = Date.parse("2026-07-09T16:00:00.000Z");

describe("parseWriterTs", () => {
  it("parses D1 unmarked-UTC datetimes as UTC, not local", () => {
    expect(parseWriterTs("2026-06-25 21:33:21")).toBe(Date.parse("2026-06-25T21:33:21Z"));
  });
  it("parses ISO-8601 timestamps", () => {
    expect(parseWriterTs("2026-06-25T21:33:21.322Z")).toBe(Date.parse("2026-06-25T21:33:21.322Z"));
  });
});

describe("isWriterSilent", () => {
  it("a writer inside its cadence is alive", () => {
    const last = new Date(NOW - 3 * HOUR).toISOString();
    expect(isWriterSilent(spec(), last, NOW).silent).toBe(false);
  });

  it("a writer past its cadence is silent", () => {
    const last = new Date(NOW - 60 * HOUR).toISOString();
    const r = isWriterSilent(spec(), last, NOW);
    expect(r.silent).toBe(true);
    expect(Math.floor(r.hoursSilent!)).toBe(60);
  });

  it("does not fire exactly AT the threshold (ordinary quiet is not death)", () => {
    const last = new Date(NOW - 48 * HOUR).toISOString();
    expect(isWriterSilent(spec({ maxSilenceHours: 48 }), last, NOW).silent).toBe(false);
  });

  it("a never-written writer is silent, with unknown duration", () => {
    const r = isWriterSilent(spec(), null, NOW);
    expect(r.silent).toBe(true);
    expect(r.hoursSilent).toBeNull();
  });

  it("an unparseable timestamp is silent, not accidentally alive", () => {
    expect(isWriterSilent(spec(), "not-a-date", NOW).silent).toBe(true);
  });

  // The actual incident, replayed.
  it("WOULD have caught the 2026-06-25 swarm-writer death", () => {
    const lastSwarmWrite = "2026-06-25T21:33:21.322Z";
    const foundOn = Date.parse("2026-07-09T16:00:00Z");   // when a human noticed: 13 days
    const wouldHaveFiredOn = Date.parse("2026-06-27T22:00:00Z"); // 48h cadence

    expect(isWriterSilent(spec({ maxSilenceHours: 48 }), lastSwarmWrite, wouldHaveFiredOn).silent).toBe(true);
    expect(isWriterSilent(spec({ maxSilenceHours: 48 }), lastSwarmWrite, foundOn).silent).toBe(true);
    // ...and it stayed quiet the whole time, so the flag would have persisted, not blinked.
    const hours = isWriterSilent(spec(), lastSwarmWrite, foundOn).hoursSilent!;
    expect(hours).toBeGreaterThan(24 * 13);
  });
});

describe("WRITER_REGISTRY", () => {
  it("watches the writer that died", () => {
    const s = WRITER_REGISTRY.find(w => w.key === "discord_speech");
    expect(s).toBeDefined();
    // must cover BOTH the legacy source and the current one, or the backfilled history
    // makes a dead current writer look alive (and vice versa).
    expect(s!.sql).toContain("discord_speech");
    expect(s!.sql).toContain("discord_swarm");
  });

  // The guardian_runs probe is a GAP detector, not a dead-guardian watch. detectDeadWriters()
  // runs inside a guardian tick, so a guardian that stops and stays stopped silences its own
  // watcher. It catches a guardian that missed runs and RECOVERED (boot-audit round 2 read
  // guardian_flags=0 as an all-clear when the check simply hadn't fired). Asserting merely that
  // the key exists -- as this test originally did -- proved nothing and hid the gap.
  it("guardian_runs entry is labelled as a gap detector, not a self-watch", () => {
    const g = WRITER_REGISTRY.find(w => w.key === "guardian_runs");
    expect(g).toBeDefined();
    expect(g!.label).toContain("NOT a dead-guardian watch");
  });

  it("guardian_runs fires on a recovered gap (the case it CAN catch)", () => {
    const g = WRITER_REGISTRY.find(w => w.key === "guardian_runs")!;
    const missedTwoDays = new Date(NOW - 50 * HOUR).toISOString();
    expect(isWriterSilent(g, missedTwoDays, NOW).silent).toBe(true);
  });

  it("every spec has a positive cadence and a stable dedup-able key", () => {
    const keys = new Set<string>();
    for (const w of WRITER_REGISTRY) {
      expect(w.maxSilenceHours).toBeGreaterThan(0);
      expect(keys.has(w.key)).toBe(false);
      keys.add(w.key);
    }
  });

  it("every probe selects a single `ts` column and interpolates nothing", () => {
    for (const w of WRITER_REGISTRY) {
      expect(w.sql).toContain("AS ts");
      expect(w.sql).not.toContain("?");
      expect(w.sql).not.toContain("${");
    }
  });
});

describe("detectDeadWriters", () => {
  const dbReturning = (tsBySql: (sql: string) => string | null) => ({
    prepare: (sql: string) => ({
      first: async () => ({ ts: tsBySql(sql) }),
    }),
  });

  it("flags a silent writer system-wide (a dead organ belongs to the house)", async () => {
    const env = { DB: dbReturning(() => "2026-06-25T21:33:21.322Z") } as never;
    const flags = await detectDeadWriters(env, NOW);
    expect(flags.length).toBeGreaterThan(0);
    for (const f of flags) {
      expect(f.companion_id).toBeNull();
      expect(f.flag_type).toBe("dead_writer");
      expect(f.dedup_key.startsWith("dead_writer:")).toBe(true);
      expect(f.evidence).toHaveProperty("last_write");
    }
  });

  it("stays silent when every writer is current", async () => {
    const fresh = new Date(NOW - 30 * 60_000).toISOString();
    const env = { DB: dbReturning(() => fresh) } as never;
    expect(await detectDeadWriters(env, NOW)).toEqual([]);
  });

  it("a broken probe does not abort the sweep", async () => {
    const env = {
      DB: {
        prepare: (sql: string) => ({
          first: async () => {
            if (sql.includes("limbic_states")) throw new Error("no such column: bogus");
            return { ts: "2026-06-25T21:33:21.322Z" };  // stale -> should still flag
          },
        }),
      },
    } as never;
    const flags = await detectDeadWriters(env, NOW);
    expect(flags.some(f => (f.evidence as { writer: string }).writer === "discord_speech")).toBe(true);
  });

  // A watchdog that fails quiet is worse than none: it supplies false assurance. The first
  // draft of WRITER_REGISTRY guessed `guardian_runs.started_at` (really `ran_at`); a silent
  // catch would have left that probe dark forever with every test still green.
  it("a broken probe RAISES ITS OWN FLAG rather than going quiet", async () => {
    const env = {
      DB: {
        prepare: (sql: string) => ({
          first: async () => {
            if (sql.includes("guardian_runs")) throw new Error("no such column: started_at");
            return { ts: new Date(NOW - 30 * 60_000).toISOString() }; // all others healthy
          },
        }),
      },
    } as never;
    const flags = await detectDeadWriters(env, NOW);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.dedup_key).toBe("dead_writer:probe:guardian_runs");
    expect(flags[0]!.severity).toBe("warning");
    expect(flags[0]!.evidence).toHaveProperty("probe_error");
    expect(flags[0]!.summary).toContain("UNWATCHED");
  });
});
