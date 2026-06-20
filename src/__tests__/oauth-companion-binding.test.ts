import { describe, it, expect } from "vitest";
import { postOAuthAuthorize, postOAuthToken } from "../handlers/oauth";
import { boundCompanionViolation } from "../librarian/mcp";

// ── the pure enforcement decision (used inside the MCP tool) ──────────────────
describe("boundCompanionViolation", () => {
  it("an unbound token (null) may act as anyone", () => {
    expect(boundCompanionViolation(null, "cypher")).toBeNull();
    expect(boundCompanionViolation(null, "gaia")).toBeNull();
  });
  it("a bound token may act as its own companion", () => {
    expect(boundCompanionViolation("cypher", "cypher")).toBeNull();
  });
  it("a bound token is refused when it claims a different companion", () => {
    const v = boundCompanionViolation("cypher", "gaia");
    expect(v).toMatch(/bound to cypher/);
    expect(v).toMatch(/cannot act as gaia/);
  });
});

// ── the companion binding carries authorize-code -> access-token ──────────────
interface CodeRow {
  client_id: string; redirect_uri: string; code_challenge: string | null;
  code_challenge_method: string | null; expires_at: string; used: number; companion_id: string | null;
}

function makeOauthDB() {
  const codes = new Map<string, CodeRow>();
  const tokens: Array<{ token_hash: string; companion_id: string | null }> = [];
  const db = {
    codes, tokens,
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async first<T>() {
          if (sql.includes("FROM oauth_clients")) {
            return { redirect_uris: JSON.stringify(["https://cb.example/cb"]) } as T;
          }
          if (sql.includes("FROM oauth_codes")) {
            const row = codes.get(args[0] as string);
            return (row ? { ...row } : null) as T;
          }
          return null as T;
        },
        async run() {
          if (sql.includes("INSERT INTO oauth_codes")) {
            const a = args as string[];
            codes.set(a[0]!, {
              client_id: a[1]!, redirect_uri: a[2]!, code_challenge: (a[3] as string | null) ?? null,
              code_challenge_method: a[4]!, expires_at: a[6]!, used: 0, companion_id: (a[7] as string | null) ?? null,
            });
          } else if (sql.includes("UPDATE oauth_codes SET used")) {
            const r = codes.get(args[0] as string); if (r) r.used = 1;
          } else if (sql.includes("INSERT INTO oauth_tokens")) {
            const a = args as string[];
            tokens.push({ token_hash: a[0]!, companion_id: (a[4] as string | null) ?? null });
          }
          return { success: true, meta: { changes: 1 } };
        },
      };
      return stmt;
    },
  };
  return db;
}

const ADMIN = "admin-passphrase";

function authForm(fields: Record<string, string>) {
  const body = new URLSearchParams(fields).toString();
  return new Request("https://h.example/oauth/authorize", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

async function authorizeAndExchange(db: ReturnType<typeof makeOauthDB>, companionField: string | undefined) {
  const env = { ADMIN_SECRET: ADMIN, DB: db } as any;
  const fields: Record<string, string> = {
    client_id: "c1",
    redirect_uri: "https://cb.example/cb",
    state: "xyz",
    code_challenge_method: "S256",
    secret: ADMIN,
  };
  if (companionField !== undefined) fields.companion_id = companionField;

  const authRes = await postOAuthAuthorize(authForm(fields), env);
  expect(authRes.status).toBe(302); // success redirect

  const code = [...db.codes.keys()][0]!;
  const tokenReq = new Request("https://h.example/oauth/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client_id: "c1", redirect_uri: "https://cb.example/cb" }),
  });
  const tokRes = await postOAuthToken(tokenReq, env);
  expect(tokRes.status).toBe(200);
  return db;
}

describe("oauth companion binding carries code -> token", () => {
  it("a chosen companion is stored on the code and the issued token", async () => {
    const db = makeOauthDB();
    await authorizeAndExchange(db, "cypher");
    expect([...db.codes.values()][0]!.companion_id).toBe("cypher");
    expect(db.tokens[0]!.companion_id).toBe("cypher");
  });

  it("no selection leaves the token unbound (null)", async () => {
    const db = makeOauthDB();
    await authorizeAndExchange(db, undefined);
    expect(db.tokens[0]!.companion_id).toBeNull();
  });

  it("a bogus companion value is rejected to unbound, never trusted", async () => {
    const db = makeOauthDB();
    await authorizeAndExchange(db, "not-a-companion");
    expect(db.tokens[0]!.companion_id).toBeNull();
  });

  it("a wrong passphrase issues no code (re-renders the form)", async () => {
    const db = makeOauthDB();
    const env = { ADMIN_SECRET: ADMIN, DB: db } as any;
    const res = await postOAuthAuthorize(authForm({
      client_id: "c1", redirect_uri: "https://cb.example/cb", state: "x",
      code_challenge_method: "S256", secret: "wrong", companion_id: "cypher",
    }), env);
    expect(res.status).toBe(401);
    expect(db.codes.size).toBe(0);
  });
});
