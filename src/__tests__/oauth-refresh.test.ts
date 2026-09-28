// OAuth refresh_token grant (mig 0138, STATUS B26) against the REAL schema (every migration, node:sqlite).
//
// Covers: metadata advertises the grant; the code grant returns a refresh token (hashed at rest, bound
// like the access token); refresh issues a working access token and ROTATES; presenting a spent token
// revokes the whole family (descendants and the access tokens they minted); wrong client_id, expired,
// revoked, unknown and malformed requests are refused with the right error; the companion binding is
// carried unchanged and cannot be widened from the request; a pre-refresh access token still works.

import { describe, it, expect } from "vitest";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { getOAuthAuthServerMetadata, postOAuthAuthorize, postOAuthToken, REFRESH_REUSE_GRACE_S } from "../handlers/oauth";
import { isAuthorized } from "../mcp/server.js";
import { hashToken } from "../lib/auth.js";

const ADMIN = "admin-passphrase";
const CB = "https://cb.example/cb";

function setup() {
  const { db, DB } = makeSqliteD1();
  db.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .run("c1", "claude", JSON.stringify([CB]), new Date().toISOString());
  db.prepare("INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)")
    .run("c2", "other", JSON.stringify([CB]), new Date().toISOString());
  const env: any = { DB, ADMIN_SECRET: ADMIN, MCP_AUTH_SECRET: "m" };
  return { db, DB, env };
}

function tokenReq(body: Record<string, string>, form = true) {
  return new Request("https://h.example/oauth/token", {
    method: "POST",
    headers: { "Content-Type": form ? "application/x-www-form-urlencoded" : "application/json" },
    body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
  });
}

async function authorize(env: any, db: any, companion?: string): Promise<string> {
  const fields: Record<string, string> = {
    client_id: "c1", redirect_uri: CB, state: "s", code_challenge_method: "S256", secret: ADMIN,
  };
  if (companion !== undefined) fields.companion_id = companion;
  const res = await postOAuthAuthorize(new Request("https://h.example/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields).toString(),
  }), env);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("Location")!).searchParams.get("code")!;
}

async function codeGrant(env: any, db: any, companion?: string) {
  const code = await authorize(env, db, companion);
  const res = await postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c1", redirect_uri: CB }), env);
  expect(res.status).toBe(200);
  return (await res.json()) as { access_token: string; refresh_token: string; expires_in: number; token_type: string };
}

async function refresh(env: any, refresh_token: string, client_id = "c1", extra: Record<string, string> = {}) {
  const res = await postOAuthToken(tokenReq({ grant_type: "refresh_token", refresh_token, client_id, ...extra }), env);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
}

async function accessRow(db: any, token: string) {
  return db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(await hashToken(token)) as any;
}
// Push a spent token's used_at back past the reuse grace window (reuse is only theft after it).
async function agePastGrace(db: any, token: string) {
  db.prepare("UPDATE oauth_refresh_tokens SET used_at = ? WHERE token_hash = ?")
    .run(new Date(Date.now() - (REFRESH_REUSE_GRACE_S + 5) * 1000).toISOString(), await hashToken(token));
}
async function refreshRow(db: any, token: string) {
  return db.prepare("SELECT * FROM oauth_refresh_tokens WHERE token_hash = ?").get(await hashToken(token)) as any;
}

describe("metadata", () => {
  it("advertises the refresh_token grant alongside authorization_code", async () => {
    const res = getOAuthAuthServerMetadata(new Request("https://h.example/.well-known/oauth-authorization-server"));
    const body = (await res.json()) as any;
    expect(body.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });
});

describe("authorization_code grant issues a refresh token", () => {
  it("returns refresh_token, stores only its hash, links it to the access token and client", async () => {
    const { db, env } = setup();
    const t = await codeGrant(env, db);
    expect(typeof t.refresh_token).toBe("string");
    expect(t.refresh_token.length).toBeGreaterThanOrEqual(43);
    expect(t.refresh_token).not.toBe(t.access_token);
    expect(t.token_type).toBe("Bearer");
    expect(t.expires_in).toBe(90 * 24 * 60 * 60);

    const rows = db.prepare("SELECT * FROM oauth_refresh_tokens").all() as any[];
    expect(rows).toHaveLength(1);
    const r = rows[0];
    expect(r.token_hash).toBe(await hashToken(t.refresh_token));
    expect(JSON.stringify(rows)).not.toContain(t.refresh_token); // never stored in the clear
    expect(r.client_id).toBe("c1");
    expect(r.access_token_hash).toBe(await hashToken(t.access_token));
    expect(r.companion_id).toBeNull(); // unbound stays NULL, not ""
    expect(r.used_at).toBeNull();
    expect(r.revoked_at).toBeNull();
    // Refresh must outlive the access token it rides with.
    expect(Date.parse(r.expires_at)).toBeGreaterThan(Date.parse((await accessRow(db, t.access_token)).expires_at));
  });

  it("token responses are no-store", async () => {
    const { db, env } = setup();
    const code = await authorize(env, db);
    const res = await postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c1" }), env);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("a code can be exchanged only once (the claim is conditional)", async () => {
    const { db, env } = setup();
    const code = await authorize(env, db);
    const a = await postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c1" }), env);
    const b = await postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c1" }), env);
    expect(a.status).toBe(200);
    expect(b.status).toBe(400);
    expect(((await b.json()) as any).error).toBe("invalid_grant");
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_refresh_tokens").get() as any).n).toBe(1);
  });
});

describe("authorization_code grant is atomic", () => {
  it("a failing insert rolls the exchange back: the code stays unspent and a retry works", async () => {
    const { db, env } = setup();
    const code = await authorize(env, db);
    // A transactional batch (as D1's is) that fails on the access-token INSERT.
    const realBatch = env.DB.batch.bind(env.DB);
    env.DB.batch = async (stmts: any[]) => {
      db.exec("BEGIN");
      try {
        for (const st of stmts) {
          if (String(st.__sql).includes("INSERT INTO oauth_tokens")) throw new Error("transient D1 error");
          await st.run();
        }
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      return [];
    };
    await expect(
      postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c1" }), env),
    ).rejects.toThrow(/transient/);
    expect((db.prepare("SELECT used FROM oauth_codes WHERE code = ?").get(code) as any).used).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_refresh_tokens").get() as any).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as any).n).toBe(0);

    env.DB.batch = realBatch;
    const retry = await postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c1" }), env);
    expect(retry.status).toBe(200);
    expect((db.prepare("SELECT used FROM oauth_codes WHERE code = ?").get(code) as any).used).toBe(1);
  });

  it("a code presented by the wrong client mints nothing and stays unspent", async () => {
    const { db, env } = setup();
    const code = await authorize(env, db);
    const res = await postOAuthToken(tokenReq({ grant_type: "authorization_code", code, client_id: "c2" }), env);
    expect(((await res.json()) as any).error).toBe("invalid_grant");
    expect((db.prepare("SELECT used FROM oauth_codes WHERE code = ?").get(code) as any).used).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as any).n).toBe(0);
  });
});

describe("refresh_token grant", () => {
  it("issues a new access token and a NEW refresh token; the old one is marked used", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    const r = await refresh(env, t0.refresh_token);
    expect(r.status).toBe(200);
    expect(r.headers.get("Cache-Control")).toBe("no-store");
    expect(r.body.token_type).toBe("Bearer");
    expect(r.body.expires_in).toBe(90 * 24 * 60 * 60);
    expect(r.body.access_token).not.toBe(t0.access_token);
    expect(r.body.refresh_token).not.toBe(t0.refresh_token);

    const newAccess = await accessRow(db, r.body.access_token);
    expect(newAccess).toBeTruthy();
    expect(newAccess.client_id).toBe("c1");
    expect(Date.parse(newAccess.expires_at)).toBeGreaterThan(Date.now());

    const old = await refreshRow(db, t0.refresh_token);
    const next = await refreshRow(db, r.body.refresh_token);
    expect(old.used_at).not.toBeNull();
    expect(old.replaced_by).toBe(next.token_hash);
    expect(next.family_id).toBe(old.family_id);
    expect(next.access_token_hash).toBe(await hashToken(r.body.access_token));
    expect(next.used_at).toBeNull();

    // The chain keeps going.
    const r2 = await refresh(env, r.body.refresh_token);
    expect(r2.status).toBe(200);
  });

  it("accepts a JSON body as well as form-urlencoded", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    const res = await postOAuthToken(tokenReq({ grant_type: "refresh_token", refresh_token: t0.refresh_token, client_id: "c1" }, false), env);
    expect(res.status).toBe(200);
  });

  it("reusing a rotated token revokes the WHOLE family, descendants and their access tokens included", async () => {
    const { db, env } = setup();
    const a = await codeGrant(env, db);
    const b = (await refresh(env, a.refresh_token)).body;
    const c = (await refresh(env, b.refresh_token)).body;

    // Replay A (already used, past the grace window).
    await agePastGrace(db, a.refresh_token);
    const replay = await refresh(env, a.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");

    // C was never used, but it is in the same family: now refused.
    const cAfter = await refresh(env, c.refresh_token);
    expect(cAfter.status).toBe(400);
    expect(cAfter.body.error).toBe("invalid_grant");

    const fam = db.prepare("SELECT revoked_at FROM oauth_refresh_tokens").all() as any[];
    expect(fam).toHaveLength(3);
    expect(fam.every((r) => r.revoked_at !== null)).toBe(true);
    // Every access token the family minted is gone.
    expect(await accessRow(db, a.access_token)).toBeUndefined();
    expect(await accessRow(db, b.access_token)).toBeUndefined();
    expect(await accessRow(db, c.access_token)).toBeUndefined();
  });

  it("family revocation does not touch another family", async () => {
    const { db, env } = setup();
    const a = await codeGrant(env, db);
    const other = await codeGrant(env, db);
    await refresh(env, a.refresh_token);
    await agePastGrace(db, a.refresh_token);
    await refresh(env, a.refresh_token); // reuse past grace -> revoke a's family
    expect((await refreshRow(db, a.refresh_token)).revoked_at).not.toBeNull();
    expect(await accessRow(db, other.access_token)).toBeTruthy();
    expect((await refresh(env, other.refresh_token)).status).toBe(200);
  });

  // Simulate a concurrent request that spent the token after our read but before our claim, by
  // marking it used underneath the handler just before its batch runs. usedAgoS = how long ago the
  // other request "won".
  function spendUnderneath(env: any, db: any, token: string, usedAgoS: number) {
    const realBatch = env.DB.batch.bind(env.DB);
    let fired = false;
    env.DB.batch = async (stmts: any[]) => {
      if (!fired) {
        fired = true;
        db.prepare("UPDATE oauth_refresh_tokens SET used_at = ?, replaced_by = 'someone-else' WHERE token_hash = ?")
          .run(new Date(Date.now() - usedAgoS * 1000).toISOString(), await hashToken(token));
      }
      return realBatch(stmts);
    };
  }

  it("a lost rotation race inside the grace window is refused WITHOUT revoking (claim is conditional)", async () => {
    const { db, env } = setup();
    const a = await codeGrant(env, db);
    spendUnderneath(env, db, a.refresh_token, 0);
    const r = await refresh(env, a.refresh_token);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_refresh_tokens").get() as any).n).toBe(1); // the loser minted nothing
    expect((await refreshRow(db, a.refresh_token)).revoked_at).toBeNull();
    expect(await accessRow(db, a.access_token)).toBeTruthy();
  });

  it("a lost rotation race whose winner is older than the grace window revokes the family", async () => {
    const { db, env } = setup();
    const a = await codeGrant(env, db);
    spendUnderneath(env, db, a.refresh_token, REFRESH_REUSE_GRACE_S + 5);
    const r = await refresh(env, a.refresh_token);
    expect(r.body.error).toBe("invalid_grant");
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_refresh_tokens").get() as any).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_tokens").get() as any).n).toBe(0);
    expect((await refreshRow(db, a.refresh_token)).revoked_at).not.toBeNull();
  });

  it("reuse INSIDE the grace window is refused but does not revoke: the winner's tokens stay valid", async () => {
    const { db, env } = setup();
    const a = await codeGrant(env, db);
    const b = (await refresh(env, a.refresh_token)).body;       // the real client's refresh wins
    const retry = await refresh(env, a.refresh_token);          // its retry / twin request, immediately
    expect(retry.status).toBe(400);
    expect(retry.body.error).toBe("invalid_grant");
    expect(retry.body).toEqual((await refresh(env, "unknown")).body); // same body as any refusal
    expect((db.prepare("SELECT COUNT(*) AS n FROM oauth_refresh_tokens WHERE revoked_at IS NOT NULL").get() as any).n).toBe(0);
    expect(await accessRow(db, b.access_token)).toBeTruthy();
    expect((await refresh(env, b.refresh_token)).status).toBe(200); // the winner's refresh token still works
  });

  it("reuse AFTER the grace window revokes the family, the winner's tokens included", async () => {
    const { db, env } = setup();
    const a = await codeGrant(env, db);
    const b = (await refresh(env, a.refresh_token)).body;
    await agePastGrace(db, a.refresh_token);
    expect((await refresh(env, a.refresh_token)).body.error).toBe("invalid_grant");
    expect(await accessRow(db, b.access_token)).toBeUndefined();
    expect((await refresh(env, b.refresh_token)).body.error).toBe("invalid_grant");
  });

  it("wrong client_id is refused and does NOT consume the token", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    const r = await refresh(env, t0.refresh_token, "c2");
    expect(r.status).toBe(400);
    expect(r.body.error).toBe("invalid_grant");
    expect((await refreshRow(db, t0.refresh_token)).used_at).toBeNull();
    expect((await refresh(env, t0.refresh_token, "c1")).status).toBe(200);
  });

  it("an expired refresh token is refused", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    db.prepare("UPDATE oauth_refresh_tokens SET expires_at = ? WHERE token_hash = ?")
      .run(new Date(Date.now() - 1000).toISOString(), await hashToken(t0.refresh_token));
    const r = await refresh(env, t0.refresh_token);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: "invalid_grant", error_description: expect.any(String) });
  });

  it("a revoked refresh token is refused", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    db.prepare("UPDATE oauth_refresh_tokens SET revoked_at = ?").run(new Date().toISOString());
    expect((await refresh(env, t0.refresh_token)).body.error).toBe("invalid_grant");
  });

  it("an unknown refresh token is refused; so is an access token presented as a refresh token", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    expect((await refresh(env, "not-a-real-token")).body.error).toBe("invalid_grant");
    expect((await refresh(env, t0.access_token)).body.error).toBe("invalid_grant");
  });

  it("every refusal returns the same error body (no oracle on which check failed)", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    const wrongClient = await refresh(env, t0.refresh_token, "c2");
    const unknown = await refresh(env, "nope");
    expect(wrongClient.body).toEqual(unknown.body);
  });

  it("missing refresh_token or client_id is invalid_request", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db);
    const noClient = await postOAuthToken(tokenReq({ grant_type: "refresh_token", refresh_token: t0.refresh_token }), env);
    expect(noClient.status).toBe(400);
    expect(((await noClient.json()) as any).error).toBe("invalid_request");
    const noToken = await postOAuthToken(tokenReq({ grant_type: "refresh_token", client_id: "c1" }), env);
    expect(((await noToken.json()) as any).error).toBe("invalid_request");
    // Nothing was consumed by the malformed request.
    expect((await refreshRow(db, t0.refresh_token)).used_at).toBeNull();
  });

  it("an unknown grant_type is still unsupported_grant_type", async () => {
    const { env } = setup();
    const res = await postOAuthToken(tokenReq({ grant_type: "password", username: "x", password: "y" }), env);
    expect(res.status).toBe(400);
    expect(((await res.json()) as any).error).toBe("unsupported_grant_type");
  });
});

describe("companion binding is carried unchanged through refresh", () => {
  it("a bound family stays bound to the same companion across rotations", async () => {
    const { db, env } = setup();
    const t0 = await codeGrant(env, db, "cypher");
    expect((await refreshRow(db, t0.refresh_token)).companion_id).toBe("cypher");
    const r1 = (await refresh(env, t0.refresh_token)).body;
    const r2 = (await refresh(env, r1.refresh_token)).body;
    expect((await accessRow(db, r1.access_token)).companion_id).toBe("cypher");
    expect((await accessRow(db, r2.access_token)).companion_id).toBe("cypher");
    expect((await refreshRow(db, r2.refresh_token)).companion_id).toBe("cypher");
  });

  it("a request cannot change or widen the binding (companion_id in the body is ignored)", async () => {
    const { db, env } = setup();
    const bound = await codeGrant(env, db, "cypher");
    const r = (await refresh(env, bound.refresh_token, "c1", { companion_id: "gaia" })).body;
    expect((await accessRow(db, r.access_token)).companion_id).toBe("cypher");

    const unbound = await codeGrant(env, db);
    const u = (await refresh(env, unbound.refresh_token, "c1", { companion_id: "drevan" })).body;
    expect((await accessRow(db, u.access_token)).companion_id).toBeNull();
  });
});

describe("existing access tokens are untouched", () => {
  it("a pre-refresh access token with no refresh row keeps its row and expiry", async () => {
    const { db, env } = setup();
    const legacyHash = await hashToken("legacy-access-token");
    const exp = "2026-10-09T00:00:00.000Z";
    db.prepare("INSERT INTO oauth_tokens (token_hash, client_id, created_at, expires_at, companion_id) VALUES (?, ?, ?, ?, NULL)")
      .run(legacyHash, "c1", "2026-07-11T00:00:00.000Z", exp);
    // Normal refresh traffic, including a family revoke, must not touch it.
    const t0 = await codeGrant(env, db);
    await refresh(env, t0.refresh_token);
    await agePastGrace(db, t0.refresh_token);
    await refresh(env, t0.refresh_token);
    expect((await refreshRow(db, t0.refresh_token)).revoked_at).not.toBeNull();
    const row = db.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ?").get(legacyHash) as any;
    expect(row.expires_at).toBe(exp);
    // And it cannot be spent as a refresh token.
    expect((await refresh(env, "legacy-access-token")).body.error).toBe("invalid_grant");
  });
});

describe("mcp/server isAuthorized expiry (was a string compare against datetime('now'))", () => {
  const req = (tok: string) => new Request("https://h.example/mcp", { method: "POST", headers: { Authorization: `Bearer ${tok}` } });

  it("an ISO token that expired earlier TODAY is rejected", async () => {
    const { db, env } = setup();
    // One second ago reads as "later today" to the old compare ('T' sorts after ' '), unless the
    // run straddles UTC midnight, where it was rejected anyway.
    db.prepare("INSERT INTO oauth_tokens (token_hash, client_id, created_at, expires_at) VALUES (?, 'c1', ?, ?)")
      .run(await hashToken("expired-today"), new Date().toISOString(), new Date(Date.now() - 1000).toISOString());
    expect(await isAuthorized(req("expired-today"), env)).toBe(false);
  });

  it("an unexpired token is accepted; an unknown one is rejected", async () => {
    const { db, env } = setup();
    const t = await codeGrant(env, db);
    expect(await isAuthorized(req(t.access_token), env)).toBe(true);
    expect(await isAuthorized(req("nope"), env)).toBe(false);
  });

  it("an unparseable expires_at fails closed", async () => {
    const { db, env } = setup();
    db.prepare("INSERT INTO oauth_tokens (token_hash, client_id, created_at, expires_at) VALUES (?, 'c1', ?, 'garbage')")
      .run(await hashToken("garbage-exp"), new Date().toISOString());
    expect(await isAuthorized(req("garbage-exp"), env)).toBe(false);
  });
});
