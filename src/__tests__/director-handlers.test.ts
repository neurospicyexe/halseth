import { describe, it, expect } from "vitest";
import { postDirectorInvitation, patchDirectorInvitation } from "../handlers/director.js";
import type { Env } from "../types.js";

interface Row { [k: string]: unknown }
function makeEnv() {
  const rows: Row[] = [];
  const DB = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              const s = sql.trim();
              if (s.startsWith("INSERT INTO director_invitations")) {
                const [id, channel_id, thread_id, companion_id, reason, offer_ids, outcome, issued_at] = args;
                rows.push({ id, channel_id, thread_id, companion_id, reason, offer_ids, used_offer_ids: "[]", outcome, message_id: null, issued_at, resolved_at: null });
                return { meta: { changes: 1 } };
              }
              if (s.startsWith("UPDATE director_invitations")) {
                const [outcome, message_id, used_offer_ids, resolved_at, id] = args;
                const r = rows.find((x) => x["id"] === id);
                if (!r) return { meta: { changes: 0 } };
                Object.assign(r, { outcome, message_id, used_offer_ids, resolved_at });
                return { meta: { changes: 1 } };
              }
              throw new Error("unexpected sql: " + s);
            },
          };
        },
      };
    },
  };
  return { env: { ADMIN_SECRET: "tok", DB } as unknown as Env, rows };
}
const H = { Authorization: "Bearer tok", "Content-Type": "application/json" };

describe("director invitations", () => {
  it("records an issued invitation", async () => {
    const { env, rows } = makeEnv();
    const res = await postDirectorInvitation(new Request("https://h/mind/director/invitations", {
      method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", thread_id: null, companion_id: "gaia", reason: "open", offer_ids: ["f1"], outcome: "issued" }),
    }), env);
    expect(res.status).toBe(201);
    expect(rows[0]!["offer_ids"]).toBe("[\"f1\"]");
  });
  it("rejects a bad reason", async () => {
    const { env } = makeEnv();
    const res = await postDirectorInvitation(new Request("https://h/x", { method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", companion_id: "gaia", reason: "vibes", offer_ids: [], outcome: "issued" }) }), env);
    expect(res.status).toBe(400);
  });
  it("patches the outcome and 404s on unknown id", async () => {
    const { env, rows } = makeEnv();
    await postDirectorInvitation(new Request("https://h/x", { method: "POST", headers: H,
      body: JSON.stringify({ id: "i1", channel_id: "c1", companion_id: "cypher", reason: "addressed", offer_ids: [], outcome: "issued" }) }), env);
    const ok = await patchDirectorInvitation(new Request("https://h/x", { method: "PATCH", headers: H,
      body: JSON.stringify({ outcome: "spoke", message_id: "m9", used_offer_ids: [] }) }), env, { id: "i1" });
    expect(ok.status).toBe(200);
    expect(rows[0]!["outcome"]).toBe("spoke");
    const miss = await patchDirectorInvitation(new Request("https://h/x", { method: "PATCH", headers: H,
      body: JSON.stringify({ outcome: "passed" }) }), env, { id: "nope" });
    expect(miss.status).toBe(404);
  });
  it("denies without auth", async () => {
    const { env } = makeEnv();
    const res = await postDirectorInvitation(new Request("https://h/x", { method: "POST", body: "{}" }), env);
    expect(res.status).toBe(401);
  });
});
