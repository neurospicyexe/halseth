// Deploy change-notes (contract 0.10.0, src/mind/changelog.ts).
//
// The rails: the LOCKSTEP rule (a contract version bump without a changelog line fails CI --
// that rule is what keeps the lane alive), deterministic-id dedup (double-posting is
// structurally impossible), and the render contract (empty renders nothing; notes render with
// their body, sliced).

import { describe, it, expect } from "vitest";
import { CONTRACT_CHANGELOG, ANNOUNCED_THROUGH, cmpVersion, unannouncedVersions, runChangelogAnnounce } from "../mind/changelog.js";
import { MINDSTATE_CONTRACT_VERSION } from "../mind/contract.js";
import { changeNotesBlock } from "../librarian/response/orient-blocks.js";

describe("changelog lockstep", () => {
  it("the deployed contract version HAS a changelog entry (bump without a note fails here)", () => {
    expect(CONTRACT_CHANGELOG[MINDSTATE_CONTRACT_VERSION]).toBeTruthy();
  });

  it("ANNOUNCED_THROUGH is a real version at or below the deployed one", () => {
    expect(cmpVersion(ANNOUNCED_THROUGH, MINDSTATE_CONTRACT_VERSION)).toBeLessThanOrEqual(0);
  });

  it("every changelog entry is companion-readable prose, not a commit subject", () => {
    for (const [v, note] of Object.entries(CONTRACT_CHANGELOG)) {
      expect(note.length, `note for ${v}`).toBeGreaterThan(60);
      expect(note, `note for ${v} should name its version`).toContain(v);
    }
  });
});

describe("cmpVersion", () => {
  it("orders numerically, not lexically (0.10.0 > 0.9.0 -- the string compare trap)", () => {
    expect(cmpVersion("0.10.0", "0.9.0")).toBeGreaterThan(0);
    expect(cmpVersion("0.9.0", "0.10.0")).toBeLessThan(0);
    expect(cmpVersion("0.9.0", "0.9.0")).toBe(0);
    expect(cmpVersion("1.0.0", "0.99.0")).toBeGreaterThan(0);
  });
});

describe("unannouncedVersions", () => {
  it("covers exactly (ANNOUNCED_THROUGH, CONTRACT_VERSION], oldest first", () => {
    const vs = unannouncedVersions();
    for (const v of vs) {
      expect(cmpVersion(v, ANNOUNCED_THROUGH)).toBeGreaterThan(0);
      expect(cmpVersion(v, MINDSTATE_CONTRACT_VERSION)).toBeLessThanOrEqual(0);
    }
    const sorted = [...vs].sort(cmpVersion);
    expect(vs).toEqual(sorted);
  });
});

describe("runChangelogAnnounce", () => {
  function makeEnv(): { env: any; rows: Array<{ id: string; author: string; context: string; body: string }> } {
    const rows: Array<{ id: string; author: string; context: string; body: string }> = [];
    const env = {
      DB: {
        prepare: (sql: string) => ({
          bind: (...binds: unknown[]) => ({
            first: async () => {
              if (sql.includes("SELECT 1 AS x")) {
                return rows.find(r => r.id === binds[0]) ? { x: 1 } : null;
              }
              throw new Error(`unexpected first(): ${sql}`);
            },
            run: async () => {
              if (sql.includes("INSERT OR IGNORE INTO commons_posts")) {
                const [id, context, body] = binds as [string, string, string];
                if (!rows.find(r => r.id === id)) rows.push({ id, author: "cypher", context, body });
                return { meta: { changes: 1 } };
              }
              throw new Error(`unexpected run(): ${sql}`);
            },
          }),
        }),
      },
    };
    return { env, rows };
  }

  it("posts each unannounced version exactly once, idempotent across repeated ticks", async () => {
    const { env, rows } = makeEnv();
    await runChangelogAnnounce(env);
    await runChangelogAnnounce(env);
    const expected = unannouncedVersions();
    expect(rows).toHaveLength(expected.length);
    for (const v of expected) {
      const post = rows.find(r => r.id === `chg_${v}`);
      expect(post).toBeTruthy();
      expect(post!.context).toBe(`change-note:${v}`);
      expect(post!.body).toBe(CONTRACT_CHANGELOG[v]);
    }
  });

  it("never throws when the DB fails -- an announce failure must not take down the tick", async () => {
    const env: any = { DB: { prepare: () => ({ bind: () => ({ first: async () => { throw new Error("boom"); }, run: async () => { throw new Error("boom"); } }) }) } };
    await expect(runChangelogAnnounce(env)).resolves.toBeUndefined();
  });
});

describe("changeNotesBlock", () => {
  it("empty renders nothing -- no changes is the normal state, not a gap to name", () => {
    expect(changeNotesBlock([])).toBe("");
  });

  it("renders each note's body under the [System changes] header", () => {
    const out = changeNotesBlock([
      { id: "chg_0.10.0", body: "System change (contract 0.10.0): this lane.", created_at: "2026-08-17 04:00:00" },
    ]);
    expect(out).toContain("[System changes");
    expect(out).toContain("this lane");
  });
});
