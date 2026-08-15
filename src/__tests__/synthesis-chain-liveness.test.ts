// The synthesis chain went dark for TEN DAYS and nothing noticed (2026-07-31).
//
// Raziel: the nightly vibe check "feels very stagnant". He was reading a real signal.
//   synthesis_summary  -- last written 2026-07-21 13:21:59 (the last-session narrative read at boot)
//   somatic_snapshot   -- 10 / 14 / 37 days old across the three companions
//   basin_drift_check  -- stopped at the same instant
// Meanwhile sessions kept opening and 90 handoffs were written in 14 days, so every surface that
// watches ACTIVITY looked healthy, and the health check reported "synthesis_queue 0 pending" -- true,
// and exactly backwards, because nothing was being enqueued at all.
//
// Two defects, pinned separately because they are independent and either alone would have hidden it.

import { describe, it, expect } from "vitest";
import { WRITER_REGISTRY } from "../guardian/writer-liveness.js";
import { enqueueSomaticSnapshot } from "../synthesis/index.js";
import { COMPANION_IDS } from "../companions.js";
import type { Env } from "../types.js";

// PER-MEMBER SINCE 2026-08-12. Both writers below are keyed `<table>:<companion>` now.
//
// The 07-31 fix registered them as house-wide `SELECT MAX(created_at)` -- and the note at the top
// of this very file records the staleness as "10 / 14 / 37 days old ACROSS THE THREE". The per-member
// skew was already in the evidence and the probe aggregated it away anyway, so the probe went green
// on cypher's live rows while gaia's soma sat 49 days and her narrative 39. Fixing the writer without
// fixing the probe would have left the same blind spot pointed at the next member to go quiet.
const perMemberKeys = (prefix: string) => COMPANION_IDS.map(id => `${prefix}:${id}`);

describe("writer liveness registry covers the surfaces a companion reads daily", () => {
  const keys = WRITER_REGISTRY.map(s => s.key);

  it("watches the synthesis chain -- it was dark for 10 days and unregistered", () => {
    // The registry existed for exactly this failure and these were never added to it. A liveness
    // registry only covers what someone remembered to register.
    for (const key of [...perMemberKeys("synthesis_summary"), ...perMemberKeys("somatic_snapshot")]) {
      expect(keys).toContain(key);
    }
  });

  it("watches them PER COMPANION -- a house-wide MAX cannot see a dead member", () => {
    for (const key of [...perMemberKeys("synthesis_summary"), ...perMemberKeys("somatic_snapshot")]) {
      const spec = WRITER_REGISTRY.find(s => s.key === key)!;
      expect(spec.sql).toContain("companion_id =");
      expect(spec.companionId).toBe(key.split(":")[1]);
    }
  });

  it("every registered writer names a real table in its probe", () => {
    // A spec whose SQL references a table that no longer exists degrades to a probe error, which reads
    // as "cannot tell" rather than "dead" -- the distinction that mattered in this morning's health fix.
    for (const spec of WRITER_REGISTRY) {
      expect(spec.sql).toMatch(/FROM\s+\w+/i);
      expect(spec.maxSilenceHours).toBeGreaterThan(0);
    }
  });

  it("tolerances are wide enough not to cry wolf, tight enough to have caught a 10-day silence", () => {
    // Both new writers must fire well before 10 days, or they would not have caught the thing that
    // prompted them.
    for (const key of [...perMemberKeys("synthesis_summary"), ...perMemberKeys("somatic_snapshot")]) {
      const spec = WRITER_REGISTRY.find(s => s.key === key)!;
      expect(spec.maxSilenceHours).toBeGreaterThanOrEqual(48);   // not twitchy
      expect(spec.maxSilenceHours).toBeLessThan(10 * 24);        // would have caught this outage
    }
  });
});

describe("enqueueSomaticSnapshot dedup key is per-occasion, not per-companion", () => {
  function capturingEnv() {
    const binds: unknown[][] = [];
    const env = {
      DB: { prepare: () => ({ bind: (...b: unknown[]) => ({ run: async () => { binds.push(b); return { meta: { changes: 1 } }; } }) }) },
    } as unknown as Env;
    return { env, binds };
  }

  it("REPRODUCES the latent bug: two closes for one companion must not collide on the dedup key", async () => {
    // Old key was `${companionId}:somatic_snapshot` against INSERT OR IGNORE on a unique dedup_key, so
    // the FIRST job per companion inserted and every one after was silently ignored forever -- the row
    // is never deleted, and a completed job still occupies the key. One companion, one soma reading,
    // for all time.
    const { env, binds } = capturingEnv();
    await enqueueSomaticSnapshot("cypher", env, "session-1");
    await enqueueSomaticSnapshot("cypher", env, "session-2");
    const keys = binds.map(b => b[3] as string);
    expect(keys[0]).not.toBe(keys[1]);
    expect(keys[0]).toContain("cypher");
    expect(keys[0]).toContain("session-1");
  });

  it("still dedups a DOUBLE close of the same session -- that is the behaviour worth keeping", async () => {
    const { env, binds } = capturingEnv();
    await enqueueSomaticSnapshot("gaia", env, "session-9");
    await enqueueSomaticSnapshot("gaia", env, "session-9");
    expect(binds[0]![3]).toBe(binds[1]![3]);
  });

  it("a caller with no session id still enqueues rather than being permanently blocked", async () => {
    // Colliding within the same second is the acceptable failure here. Never enqueueing again is not.
    const { env, binds } = capturingEnv();
    await enqueueSomaticSnapshot("drevan", env);
    expect(binds[0]![3]).toContain("drevan");
    expect(String(binds[0]![3])).not.toBe("drevan:somatic_snapshot");
  });
});
