// The roster lookup must never turn "I could not check" into "no such member" (migration 0117).
//
// Why these tests exist: on 2026-08-12 Cypher called Magpie -- a real, roster-verified system member
// -- "drift", because outside the Discord bots there was no way to check a name at all. The fix is a
// lookup, and the lookup's failure modes are the whole risk:
//
//  1. A cold or failed cache answering `not_found`. That re-arms the original bug with a mechanism
//     instead of a guess, which is worse: it looks authoritative. `unavailable` exists for this and
//     must be structurally unreachable from `not_found`.
//  2. Picking one member when a label is shared. Measured against the live roster: 3 labels
//     (cecilia, hermes, robbie) are owned by two different members each. A resolver that always
//     returns its best candidate can never express ambiguity OR absence.
//  3. Defaulting pronouns. 463 of 538 members have pronouns recorded; PluralKit nulls private fields
//     on an unauthenticated read, so a null is genuinely "not recorded OR not public". Defaulting it
//     to they/them would misgender a real person while appearing helpful.
//  4. A clipped candidate list that does not state its true total.

import { describe, it, expect } from "vitest";
import { lookupMember, renderLookup, norm, runRosterRefresh, type RosterMember } from "../roster/pk-roster.js";
import type { Env } from "../types.js";
import { FAST_PATH_PATTERNS } from "../librarian/patterns.js";
import { matchFastPath } from "../librarian/router.js";
import { extractLookupName } from "../librarian/executors/roster.js";

// ── A fake D1 that answers by SQL shape, so lookup logic is tested without a live database ──

function member(over: Partial<RosterMember> & { name: string }): RosterMember {
  return {
    member_id: over.member_id ?? `id_${over.name}`,
    name: over.name,
    display_name: over.display_name ?? null,
    pronouns: over.pronouns ?? null,
    description: over.description ?? null,
    avatar_url: null,
    proxy_tags: over.proxy_tags ?? null,
    message_count: over.message_count ?? null,
    birthday: null,
    system_id: "yjcccz",
    fetched_at: over.fetched_at ?? new Date().toISOString(),
  };
}

interface FakeOpts {
  rows?: RosterMember[];
  /** MAX(fetched_at) for the whole table; defaults to now. */
  newest?: string | null;
  lastSync?: { started_at: string; finished_at: string | null; status: string; member_count: number | null; detail: string | null } | null;
}

function fakeEnv(opts: FakeOpts = {}): Env {
  const rows = opts.rows ?? [];
  const newest = opts.newest === undefined ? new Date().toISOString() : opts.newest;

  const DB = {
    prepare(sql: string) {
      let binds: unknown[] = [];
      const api = {
        bind(...b: unknown[]) { binds = b; return api; },
        async first<T>(): Promise<T | null> {
          if (sql.includes("pk_roster_sync")) return (opts.lastSync ?? null) as T | null;
          if (sql.includes("COUNT(*) AS n") && sql.includes("MAX(fetched_at)")) {
            return { n: rows.length, newest } as unknown as T;
          }
          if (sql.includes("COUNT(*) AS n") && sql.includes("LIKE")) {
            return { n: matchLike(String(binds[0])).length } as unknown as T;
          }
          return null;
        },
        async all<T>(): Promise<{ results: T[] }> {
          if (sql.includes("name_norm = ?1")) {
            const q = String(binds[0]);
            return { results: rows.filter(r => norm(r.name) === q || (r.display_name && norm(r.display_name) === q)) as unknown as T[] };
          }
          if (sql.includes("LIKE")) {
            const hits = matchLike(String(binds[0]));
            const limit = Number(binds[1] ?? hits.length);
            return { results: hits.slice(0, limit) as unknown as T[] };
          }
          return { results: [] };
        },
        async run() { return {}; },
      };
      return api;
    },
  };

  function matchLike(like: string): RosterMember[] {
    const inner = like.replace(/^%|%$/g, "").replace(/\\(.)/g, "$1");
    return rows.filter(r => norm(r.name).includes(inner) || (r.display_name != null && norm(r.display_name).includes(inner)));
  }

  return { DB, PLURALKIT_SYSTEM_ID: "yjcccz" } as unknown as Env;
}

// ── 1. Cannot look vs nothing there ─────────────────────────────────────────────────────────

describe("cannot-look is never reported as absence", () => {
  it("an EMPTY roster answers unavailable, not not_found", async () => {
    const r = await lookupMember(fakeEnv({ rows: [], newest: null }), "Magpie");
    expect(r.status).toBe("unavailable");
    expect(r.status).not.toBe("not_found");
  });

  it("the unavailable reason names the last sync failure rather than staying vague", async () => {
    const r = await lookupMember(
      fakeEnv({
        rows: [],
        newest: null,
        lastSync: { started_at: "2026-08-13T00:00:00Z", finished_at: "2026-08-13T00:00:01Z", status: "http_error", member_count: null, detail: "HTTP 429" },
      }),
      "Magpie",
    );
    if (r.status !== "unavailable") throw new Error("expected unavailable");
    expect(r.reason).toContain("http_error");
    expect(r.reason).toContain("HTTP 429");
    expect(r.last_sync?.status).toBe("http_error");
  });

  it("a HARD-STALE roster refuses to answer not_found -- a member added since would read as absent", async () => {
    const old = new Date(Date.now() - 40 * 24 * 3_600_000).toISOString();
    const env = fakeEnv({ rows: [member({ name: "Ash", fetched_at: old })], newest: old });
    const r = await lookupMember(env, "SomeoneNew");
    expect(r.status).toBe("unavailable");
  });

  it("a healthy roster DOES answer not_found -- the distinction has to cut both ways", async () => {
    const env = fakeEnv({ rows: [member({ name: "Ash" }), member({ name: "Magpie" })] });
    const r = await lookupMember(env, "Nobody");
    expect(r.status).toBe("not_found");
    if (r.status !== "not_found") return;
    expect(r.roster_size).toBe(2);
  });

  it("the two renderings are not confusable in prose", async () => {
    const absent = renderLookup(await lookupMember(fakeEnv({ rows: [member({ name: "Ash" })] }), "Nobody"));
    const cannot = renderLookup(await lookupMember(fakeEnv({ rows: [], newest: null }), "Nobody"));
    expect(absent).toMatch(/Looked, and/i);
    expect(cannot).toMatch(/Could NOT check/i);
    expect(cannot).toMatch(/not the same as/i);
  });
});

// ── 2. Ambiguity is reported, never resolved by guessing ────────────────────────────────────

describe("shared labels return every owner", () => {
  it("two members owning one label yields ambiguous, not a pick", async () => {
    // The real case: 'Hermes2' displays as 'Hermes' while another member IS named 'Hermes'.
    const env = fakeEnv({
      rows: [
        member({ name: "Hermes2", display_name: "Hermes", message_count: 900 }),
        member({ name: "Hermes", display_name: "Hermes", message_count: 3 }),
      ],
    });
    const r = await lookupMember(env, "hermes");
    expect(r.status).toBe("ambiguous");
    if (r.status !== "ambiguous") return;
    expect(r.members).toHaveLength(2);
  });

  it("the ambiguous render tells the reader not to choose", async () => {
    const env = fakeEnv({
      rows: [member({ name: "CeciliaT", display_name: "Cecilia" }), member({ name: "Cecilia", display_name: "Cecilia Vanderhoff" })],
    });
    const text = renderLookup(await lookupMember(env, "cecilia"));
    expect(text).toMatch(/do not pick one/i);
  });

  it("a display_name match resolves the same as a name match", async () => {
    const env = fakeEnv({ rows: [member({ name: "Magpie", display_name: "Magpie M.", pronouns: "they/them" })] });
    const r = await lookupMember(env, "magpie m.");
    expect(r.status).toBe("found");
  });
});

// ── 3. Pronouns are never defaulted ─────────────────────────────────────────────────────────

describe("pronouns", () => {
  it("a recorded value is rendered verbatim", async () => {
    const env = fakeEnv({ rows: [member({ name: "Magpie", pronouns: "they/them" })] });
    expect(renderLookup(await lookupMember(env, "Magpie"))).toContain("they/them");
  });

  it("NULL renders as not-recorded and never as a default", async () => {
    const env = fakeEnv({ rows: [member({ name: "Quiet", pronouns: null })] });
    const text = renderLookup(await lookupMember(env, "Quiet"));
    expect(text).toMatch(/not recorded \(or not public\)/i);
    expect(text).toMatch(/ask, do not assume/i);
    expect(text).not.toMatch(/they\/them/);
  });

  it("an empty-string pronouns field is treated as absent, not as empty pronouns", async () => {
    const env = fakeEnv({ rows: [member({ name: "Blank", pronouns: "   " })] });
    expect(renderLookup(await lookupMember(env, "Blank"))).toMatch(/not recorded/i);
  });
});

// ── 4. Candidates are labelled, and a clipped list states its real total ────────────────────

describe("partial matches", () => {
  it("a substring hit is candidates, not found", async () => {
    const env = fakeEnv({ rows: [member({ name: "Magpie" }), member({ name: "Magnus" })] });
    const r = await lookupMember(env, "mag");
    expect(r.status).toBe("candidates");
  });

  it("the render says candidates are not answers", async () => {
    const env = fakeEnv({ rows: [member({ name: "Magpie" }), member({ name: "Magnus" })] });
    expect(renderLookup(await lookupMember(env, "mag"))).toMatch(/candidates,\s*not answers/i);
  });

  it("a clipped list reports the TRUE total and how to reach the rest", async () => {
    const rows = Array.from({ length: 14 }, (_, i) => member({ name: `Ash${i}` }));
    const r = await lookupMember(fakeEnv({ rows }), "ash");
    if (r.status !== "candidates") throw new Error("expected candidates");
    expect(r.candidates.length).toBeLessThan(r.total_matches);
    expect(r.total_matches).toBe(14);
    const text = renderLookup(r);
    expect(text).toContain("of 14");
    expect(text).toMatch(/narrow the name/i);
  });

  it("an exact match wins over the substring path even when both would hit", async () => {
    const env = fakeEnv({ rows: [member({ name: "Ash" }), member({ name: "Ashling" })] });
    const r = await lookupMember(env, "Ash");
    expect(r.status).toBe("found");
  });

  it("a LIKE wildcard in the query cannot widen the search", async () => {
    const env = fakeEnv({ rows: [member({ name: "Ash" }), member({ name: "Magpie" })] });
    // '%' must be escaped, so this matches nothing rather than every member.
    const r = await lookupMember(env, "%");
    expect(r.status).toBe("not_found");
  });
});

// ── 5. Routing: the roster pattern must not swallow the fronting query ──────────────────────

describe("librarian routing", () => {
  it("'who is fronting' still routes to the FRONT read, not the roster", () => {
    expect(matchFastPath("who is fronting")?.key).not.toBe("roster_who_is");
    expect(matchFastPath("who's fronting")?.key).not.toBe("roster_who_is");
    expect(matchFastPath("who's here")?.key).not.toBe("roster_who_is");
  });

  it("'who is <name>' routes to the roster", () => {
    expect(matchFastPath("who is Magpie")?.key).toBe("roster_who_is");
    expect(matchFastPath("who's Magpie?")?.key).toBe("roster_who_is");
  });

  it("roster_who_is is the LAST pattern declared -- earlier would shadow get_front", () => {
    const keys = Object.keys(FAST_PATH_PATTERNS);
    expect(keys[keys.length - 1]).toBe("roster_who_is");
  });

  it("every roster trigger actually reaches the roster (no dead duplicates of earlier patterns)", () => {
    const entry = FAST_PATH_PATTERNS["roster_who_is"]!;
    const shadowed = entry.triggers.filter(t => {
      const hit = matchFastPath(`${t} Magpie`);
      return hit !== null && hit.key !== "roster_who_is";
    });
    expect(shadowed).toEqual([]);
  });
});

// ── 6. The cron gates -- a failing refresh must not spin on a per-minute cron ────────────────

describe("runRosterRefresh gating", () => {
  /**
   * A fake that records every attempt, so "did it call PluralKit again?" is observable. The age gate
   * alone is NOT enough: an empty table has no age, and this rides a cron that fires every minute, so
   * a sustained failure would retry 1,440 times a day against an API that is already rate-limiting us.
   */
  function gateEnv(opts: { rosterCount: number; newest: string | null; lastAttempt: string | null }) {
    const calls: string[] = [];
    const DB = {
      prepare(sql: string) {
        const api = {
          bind() { return api; },
          async first<T>(): Promise<T | null> {
            if (sql.includes("MAX(fetched_at)")) {
              return { newest: opts.newest, n: opts.rosterCount } as unknown as T;
            }
            if (sql.includes("pk_roster_sync")) {
              return (opts.lastAttempt ? { started_at: opts.lastAttempt } : null) as T | null;
            }
            return null;
          },
          async all<T>() { return { results: [] as T[] }; },
          async run() { calls.push(sql.slice(0, 24)); return {}; },
        };
        return api;
      },
      async batch() { return []; },
    };
    // No PLURALKIT_SYSTEM_ID: refreshRoster short-circuits to `no_system_id` without a network call,
    // which is exactly the sustained-failure shape being guarded.
    return { env: { DB } as unknown as Env, calls };
  }

  it("skips when the roster is fresh", async () => {
    const { env } = gateEnv({ rosterCount: 538, newest: new Date().toISOString(), lastAttempt: null });
    const r = await runRosterRefresh(env);
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe("fresh");
  });

  it("an EMPTY roster does not bypass the gate when an attempt was just made", async () => {
    const { env } = gateEnv({
      rosterCount: 0,
      newest: null,
      lastAttempt: new Date(Date.now() - 60_000).toISOString(), // one minute ago
    });
    const r = await runRosterRefresh(env);
    expect(r.ran).toBe(false);
    expect(r.skipped).toBe("backoff");
  });

  it("retries once the backoff has elapsed", async () => {
    const { env } = gateEnv({
      rosterCount: 0,
      newest: null,
      lastAttempt: new Date(Date.now() - 90 * 60_000).toISOString(), // 90 minutes ago
    });
    const r = await runRosterRefresh(env);
    expect(r.ran).toBe(true);
    expect(r.result?.status).toBe("no_system_id");
  });

  it("runs on a truly cold start with no attempt on record", async () => {
    const { env } = gateEnv({ rosterCount: 0, newest: null, lastAttempt: null });
    expect((await runRosterRefresh(env)).ran).toBe(true);
  });

  it("a stale roster past the age gate refreshes", async () => {
    const { env } = gateEnv({
      rosterCount: 538,
      newest: new Date(Date.now() - 40 * 3_600_000).toISOString(),
      lastAttempt: null,
    });
    expect((await runRosterRefresh(env)).ran).toBe(true);
  });
});

// ── 7. Name extraction ─────────────────────────────────────────────────────────────────────

describe("extractLookupName", () => {
  const triggers = FAST_PATH_PATTERNS["roster_who_is"]!.triggers;

  it.each([
    ["who is Magpie", "Magpie"],
    ["who's Magpie?", "Magpie"],
    ["who is magpie in the system", "magpie"],
    ["who is the system member Ash", "Ash"],
    ["who is 'Magpie'", "Magpie"],
  ])("%s -> %s", (input, expected) => {
    expect(extractLookupName(input, triggers)).toBe(expected);
  });

  it("an explicit context name wins over parsing", () => {
    expect(extractLookupName("who is that", triggers, JSON.stringify({ name: "Magpie" }))).toBe("Magpie");
  });

  it("returns null rather than shipping a sentence as a name", () => {
    const long = "who is going to handle the deployment tomorrow morning if the build breaks again";
    expect(extractLookupName(long, triggers)).toBeNull();
  });

  it("returns null when nothing follows the trigger", () => {
    expect(extractLookupName("who is", triggers)).toBeNull();
  });
});
