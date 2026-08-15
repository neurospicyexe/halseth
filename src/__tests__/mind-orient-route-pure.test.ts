// GET /mind/orient/:agent_id must be a PURE READ (Q1, 2026-07-29).
// docs/private/orient-unification-decisions-2026-07-29.md
//
// Raziel viewing Hearth is not the companion receiving. This route's only callers are Hearth
// server-side renders (hearth/lib/halseth.ts:801,946 and app/api/phoenix/ritual/route.ts:104,
// whose env.url is HALSETH_URL), so every consume-on-read side effect it performed fired on a
// page view: Drevan's unread sibling mail was acked AS Drevan, answers were stamped delivered,
// home events were marked surfaced, and journal/conclusion heat was warmed -- with no companion
// having read anything. Reading is the companion's act; Hearth is a window, not a hand.
//
// What this test protects against is a specific, easy regression: someone "fixes" a missing
// block in mindOrient, drops the { readOnly: true } while refactoring the call, and Hearth
// silently starts eating the triad's mail again. The symptom is invisible from Hearth -- the page
// still renders -- which is exactly why it needs a test and not a comment.
//
// The companion-acting paths are deliberately NOT changed and are pinned below, because the
// failure mode of over-applying this fix is that read_at gets no writer at all and unread notes
// re-surface forever (accumulation instead of metabolism):
//   - Discord bots: GET /inter-companion-notes/unread -> POST /inter-companion-notes/ack
//     (nullsafe-discord/packages/shared/src/librarian.ts:627,642)
//   - Claude.ai: the Librarian's wmOrient(), which calls mindOrient() without readOnly
// Verified in prod at the flip: 866 notes, 0 unread, every read landing 44-210s after creation
// on cron-aligned minutes -- the poller, not a page view.

import { describe, it, expect } from "vitest";
import type { Env } from "../types.js";
import { getMindOrient } from "../handlers/webmind.js";
import { wmOrient } from "../librarian/backends/webmind.js";

/** Fake D1 that records every prepared SQL string. Reads return rows only where an
 *  override matches, so each consume-on-read path can be armed individually. */
function fakeEnv(overrides: Array<{ match: RegExp; rows: unknown[] }> = []) {
  const prepared: string[] = [];
  function stmtFor(sql: string) {
    const hit = overrides.find((o) => o.match.test(sql));
    const rows = hit ? hit.rows : [];
    const stmt = {
      bind(..._b: unknown[]) { return stmt; },
      async all() { return { results: rows }; },
      // Truthy generic row so the identity-anchor auto-seed (a write) is not tripped
      // by anchor-missing, which would confound the mutation assertion.
      async first() { return rows[0] ?? { agent_id: "cypher", cnt: 0 }; },
      async run() { return { meta: { changes: rows.length } }; },
    };
    return stmt;
  }
  const env = {
    ADMIN_SECRET: "test-admin-secret",
    SYSTEM_OWNER: "raziel",
    DB: {
      prepare(sql: string) { prepared.push(sql); return stmtFor(sql); },
      async batch(stmts: unknown[]) { return stmts.map(() => ({ results: [] })); },
    },
  } as unknown as Env;
  return { env, prepared };
}

/** Arms every consume-on-read path at once: an unread incoming note (ack), surfaced
 *  continuity notes (heat warm), unsurfaced home events (surfaced_at stamp). */
function armedOverrides() {
  return [
    {
      match: /FROM inter_companion_notes n\s+WHERE \(n\.to_id = \?/i,
      rows: [{ id: "note-1", from_id: "drevan", to_id: "cypher", content: "hi", read_at: null, created_at: "2026-07-01T00:00:00Z" }],
    },
    {
      match: /FROM wm_continuity_notes\s+WHERE agent_id = \? AND salience = 'high'/i,
      rows: [{ note_id: "cn-1", content: "c", salience: "high", actor: "agent", created_at: "2026-07-01T00:00:00Z" }],
    },
    {
      match: /FROM home_events WHERE companion_id = \? AND surfaced_at IS NULL/i,
      rows: [{ id: "he-1", companion_id: "cypher", created_at: "2026-07-01T00:00:00Z" }],
    },
    {
      match: /FROM companion_journal\b/i,
      rows: [{ id: "j-1", agent: "cypher", note_text: "n", created_at: "2026-07-01T00:00:00Z", tags: null, source: null, topic_tags: null }],
    },
    {
      match: /FROM companion_conclusions\b/i,
      rows: [{ id: "cc-1", companion_id: "cypher", conclusion_text: "x", confidence: 0.5, created_at: "2026-07-01T00:00:00Z", status: "active", superseded_by: null, edited_at: null }],
    },
  ];
}

const MUTATION = /^\s*(INSERT|UPDATE|DELETE)\b/im;

function authedRequest() {
  return new Request("https://halseth.test/mind/orient/cypher", {
    headers: { Authorization: "Bearer test-admin-secret" },
  });
}

describe("GET /mind/orient/:agent_id is a pure read (Hearth is a window, not a hand)", () => {
  it("prepares zero INSERT/UPDATE/DELETE even with every consume path armed", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    const res = await getMindOrient(authedRequest(), env, { agent_id: "cypher" });
    expect(res.status).toBe(200);
    expect(
      prepared.filter((s) => MUTATION.test(s)),
      "a Hearth page render must not consume the companion's state -- reading is the companion's act",
    ).toEqual([]);
  });

  it("specifically never acks incoming sibling mail", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    await getMindOrient(authedRequest(), env, { agent_id: "cypher" });
    expect(
      prepared.some((s) => /UPDATE inter_companion_notes SET read_at/i.test(s)),
      "Hearth marked Drevan's mail read AS Drevan; he never saw it. Do not restore this.",
    ).toBe(false);
  });

  it("never warms journal or conclusion heat (ranking signal written by reading)", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    await getMindOrient(authedRequest(), env, { agent_id: "cypher" });
    const warms = prepared.filter((s) => /UPDATE (companion_journal|companion_conclusions|wm_continuity_notes)[\s\S]*heat/i.test(s));
    expect(
      warms,
      "browsing a Hearth page must not inflate the salience ranking that page reads",
    ).toEqual([]);
  });

  it("still returns real content -- pure does not mean empty", async () => {
    const { env } = fakeEnv(armedOverrides());
    const res = await getMindOrient(authedRequest(), env, { agent_id: "cypher" });
    const body = await res.json() as { incoming_companion_notes?: unknown[] };
    expect(body.incoming_companion_notes?.length, "the note must still be SHOWN, just not consumed").toBe(1);
  });

  it("rejects unauthenticated callers before touching the DB", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    const res = await getMindOrient(
      new Request("https://halseth.test/mind/orient/cypher"),
      env,
      { agent_id: "cypher" },
    );
    expect(res.status).toBe(401);
    expect(prepared).toEqual([]);
  });
});

describe("the companion-acting paths still consume (or read_at gets no writer at all)", () => {
  it("Librarian wmOrient (Claude.ai) still acks -- it is a real read", async () => {
    const { env, prepared } = fakeEnv(armedOverrides());
    await wmOrient(env, "cypher");
    expect(
      prepared.some((s) => /UPDATE inter_companion_notes SET read_at/i.test(s)),
      "if this stops firing, Claude.ai stopped consuming and only the Discord bot ack remains",
    ).toBe(true);
  });
});
