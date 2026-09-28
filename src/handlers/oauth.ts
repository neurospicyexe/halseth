import { Env } from "../types";
import { generateId } from "../db/queries";
import { safeEqual, hashToken } from "../lib/auth.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

const ALLOWED_ORIGINS = [
  "https://claude.ai",
  "https://apps.anthropic.com",
];

function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get("Origin") ?? "";
  const allowedOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0]!;
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function jsonResponse(data: unknown, status = 200, request?: Request): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(request ? getCorsHeaders(request) : {}),
    },
  });
}

export function handleOAuthCors(request: Request): Response {
  return new Response(null, { status: 204, headers: getCorsHeaders(request) });
}

function oauthError(error: string, description: string, status = 400, request?: Request): Response {
  return jsonResponse({ error, error_description: description }, status, request);
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function verifyPkce(verifier: string, challenge: string, method: string): Promise<boolean> {
  if (method !== "S256") return false;  // only S256 accepted; plain is rejected
  const data = new TextEncoder().encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const b64 = btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
  return b64 === challenge;
}

// Companions a connector can be bound to. "" = unbound (admin / Raziel's own connector / bots).
const BINDABLE_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

function renderAuthorizeForm(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  companionSel: string = "",
  errorMsg?: string,
): Response {
  const opt = (val: string, label: string) =>
    `<option value="${escapeHtml(val)}"${companionSel === val ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const companionOptions =
    opt("", "Unbound (admin / Raziel direct)") +
    BINDABLE_COMPANIONS.map((c) => opt(c, c.charAt(0).toUpperCase() + c.slice(1))).join("");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Authorize — Halseth</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: system-ui, -apple-system, sans-serif;
      background: #0e0e10; color: #e4e4e7;
      min-height: 100vh; display: flex; align-items: center; justify-content: center;
    }
    .card {
      background: #18181b; border: 1px solid #27272a; border-radius: 12px;
      padding: 2rem; width: 100%; max-width: 360px;
    }
    h1 { font-size: 1.125rem; font-weight: 600; margin-bottom: 0.375rem; }
    .sub { font-size: 0.8125rem; color: #71717a; margin-bottom: 1.5rem; }
    label { display: block; font-size: 0.8125rem; color: #a1a1aa; margin-bottom: 0.375rem; }
    input[type="password"] {
      width: 100%; padding: 0.5rem 0.75rem;
      background: #09090b; border: 1px solid #3f3f46;
      border-radius: 8px; color: #e4e4e7; font-size: 0.875rem; outline: none;
    }
    input[type="password"]:focus { border-color: #6366f1; }
    select {
      width: 100%; padding: 0.5rem 0.75rem; margin-bottom: 0.25rem;
      background: #09090b; border: 1px solid #3f3f46;
      border-radius: 8px; color: #e4e4e7; font-size: 0.875rem; outline: none;
    }
    select:focus { border-color: #6366f1; }
    .hint { font-size: 0.6875rem; color: #71717a; margin-bottom: 0.75rem; }
    .error { color: #f87171; font-size: 0.8125rem; margin-top: 0.75rem; }
    button {
      width: 100%; margin-top: 1rem; padding: 0.5625rem;
      background: #6366f1; color: #fff; border: none;
      border-radius: 8px; font-size: 0.875rem; font-weight: 500; cursor: pointer;
    }
    button:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Authorize Halseth</h1>
    <p class="sub">Enter your admin passphrase to grant Claude access.</p>
    <form method="POST" action="/oauth/authorize">
      <input type="hidden" name="client_id"             value="${escapeHtml(clientId)}">
      <input type="hidden" name="redirect_uri"          value="${escapeHtml(redirectUri)}">
      <input type="hidden" name="state"                 value="${escapeHtml(state)}">
      <input type="hidden" name="code_challenge"        value="${escapeHtml(codeChallenge)}">
      <input type="hidden" name="code_challenge_method" value="${escapeHtml(codeChallengeMethod)}">
      <label for="secret">Admin passphrase</label>
      <input type="password" id="secret" name="secret" autocomplete="current-password" autofocus>
      <label for="companion_id" style="margin-top:1rem;">Bind this connector to</label>
      <select id="companion_id" name="companion_id">${companionOptions}</select>
      <p class="hint">Pick a companion for that companion's project so it can only act as itself. Leave Unbound for your own direct access.</p>
      ${errorMsg ? `<p class="error">${escapeHtml(errorMsg)}</p>` : ""}
      <button type="submit">Authorize</button>
    </form>
  </div>
</body>
</html>`;
  return new Response(html, {
    status: errorMsg ? 401 : 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}

// ── Endpoints ─────────────────────────────────────────────────────────────────

// GET /.well-known/oauth-protected-resource
// Tells the MCP client where to find the auth server.
export function getOAuthProtectedResource(request: Request): Response {
  const base = new URL(request.url).origin;
  return jsonResponse({
    resource:             base,
    authorization_servers: [base],
  }, 200, request);
}

// GET /.well-known/oauth-authorization-server
// OAuth server metadata (RFC 8414).
export function getOAuthAuthServerMetadata(request: Request): Response {
  const base = new URL(request.url).origin;
  return jsonResponse({
    issuer:                              base,
    authorization_endpoint:             `${base}/oauth/authorize`,
    token_endpoint:                     `${base}/oauth/token`,
    registration_endpoint:              `${base}/oauth/register`,
    response_types_supported:           ["code"],
    grant_types_supported:              ["authorization_code", "refresh_token"],
    code_challenge_methods_supported:   ["S256"],
  }, 200, request);
}

// POST /oauth/register — Dynamic Client Registration (RFC 7591).
// claude.ai registers itself before starting the auth flow.
export async function postOAuthRegister(request: Request, env: Env): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = await request.json() as Record<string, unknown>;
  } catch {
    return oauthError("invalid_request", "Invalid JSON body", 400, request);
  }

  const redirectUris = Array.isArray(body.redirect_uris) ? body.redirect_uris as string[] : [];
  const clientName   = typeof body.client_name === "string" ? body.client_name : "Unknown";
  const clientId     = generateId();
  const now          = new Date().toISOString();

  await env.DB.prepare(
    "INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at) VALUES (?, ?, ?, ?)"
  ).bind(clientId, clientName, JSON.stringify(redirectUris), now).run();

  return jsonResponse({ client_id: clientId, client_name: clientName, redirect_uris: redirectUris }, 201, request);
}

// GET /oauth/authorize — show the passphrase form.
export async function getOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  const p = new URL(request.url).searchParams;
  const clientId            = p.get("client_id")             ?? "";
  const redirectUri         = p.get("redirect_uri")          ?? "";
  const state               = p.get("state")                 ?? "";
  const codeChallenge       = p.get("code_challenge")        ?? "";
  const codeChallengeMethod = p.get("code_challenge_method") ?? "S256";

  if (!clientId || !redirectUri) {
    return oauthError("invalid_request", "Missing client_id or redirect_uri", 400, request);
  }

  // Validate redirect_uri against the client's registered URIs (RFC 6749 §10.6).
  const client = await env.DB.prepare(
    "SELECT redirect_uris FROM oauth_clients WHERE client_id = ?"
  ).bind(clientId).first<{ redirect_uris: string }>();

  if (!client) return oauthError("invalid_client", "Unknown client_id", 400, request);

  const registered: string[] = JSON.parse(client.redirect_uris ?? "[]");
  if (!registered.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client", 400, request);
  }

  return renderAuthorizeForm(clientId, redirectUri, state, codeChallenge, codeChallengeMethod);
}

// POST /oauth/authorize — verify passphrase, issue code, redirect.
export async function postOAuthAuthorize(request: Request, env: Env): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return oauthError("invalid_request", "Invalid form data", 400, request);
  }

  const clientId            = (form.get("client_id")             as string) ?? "";
  const redirectUri         = (form.get("redirect_uri")          as string) ?? "";
  const state               = (form.get("state")                 as string) ?? "";
  const codeChallenge       = (form.get("code_challenge")        as string) ?? "";
  const codeChallengeMethod = (form.get("code_challenge_method") as string) ?? "S256";
  const secret              = (form.get("secret")                as string) ?? "";
  const companionRaw        = (form.get("companion_id")          as string) ?? "";
  // Only a known companion binds; anything else (incl. "") is unbound. Never trust a free value.
  const companionId = (BINDABLE_COMPANIONS as readonly string[]).includes(companionRaw) ? companionRaw : null;

  if (!clientId || !redirectUri) {
    return oauthError("invalid_request", "Missing client_id or redirect_uri", 400, request);
  }

  // Validate redirect_uri against the client's registered URIs before doing anything with it.
  const client = await env.DB.prepare(
    "SELECT redirect_uris FROM oauth_clients WHERE client_id = ?"
  ).bind(clientId).first<{ redirect_uris: string }>();

  if (!client) return oauthError("invalid_client", "Unknown client_id", 400, request);

  const registered: string[] = JSON.parse(client.redirect_uris ?? "[]");
  if (!registered.includes(redirectUri)) {
    return oauthError("invalid_request", "redirect_uri not registered for this client", 400, request);
  }

  // Verify admin passphrase. (Selection survives the re-render so a typo doesn't reset the binding.)
  if (!env.ADMIN_SECRET || !safeEqual(secret, env.ADMIN_SECRET)) {
    return renderAuthorizeForm(clientId, redirectUri, state, codeChallenge, codeChallengeMethod, companionId ?? "", "Incorrect passphrase.");
  }

  // Issue authorization code (10-minute window), carrying the companion binding chosen above.
  const code      = generateId();
  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at, used, companion_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).bind(code, clientId, redirectUri, codeChallenge || null, codeChallengeMethod, now, expiresAt, companionId).run();

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);

  return Response.redirect(dest.toString(), 302);
}


// ── Token issuance ────────────────────────────────────────────────────────────

// Access tokens keep their pre-refresh lifetime (90 days) so connector behaviour is unchanged.
// Refresh tokens must OUTLIVE the access token they ride with: a client typically refreshes when
// the access token expires, and a refresh token that died at the same instant would be useless.
// 180 days, sliding (every rotation issues a fresh token with a fresh window).
export const ACCESS_TOKEN_TTL_S  = 90 * 24 * 60 * 60;
export const REFRESH_TOKEN_TTL_S = 180 * 24 * 60 * 60;

// Token responses carry credentials: RFC 6749 section 5.1 requires no-store.
function tokenResponse(data: Record<string, unknown>, request: Request): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Pragma": "no-cache",
      ...getCorsHeaders(request),
    },
  });
}

function newAccessToken(): string {
  return generateId() + generateId().replace(/-/g, ""); // two UUIDv4s, 244 random bits
}

// 256 bits from the CSPRNG, base64url.
function newRefreshToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

// A spent refresh token presented again within this many seconds of its rotation is refused
// WITHOUT revoking the family: a connector that refreshes twice at once, or retries a refresh,
// must not log itself out. Past the window, reuse is treated as theft and the family dies.
export const REFRESH_REUSE_GRACE_S = 30;

function withinReuseGrace(usedAtIso: string): boolean {
  const usedAt = Date.parse(usedAtIso);
  if (Number.isNaN(usedAt)) return false; // unparseable: no grace, fail toward revocation
  return Date.now() - usedAt < REFRESH_REUSE_GRACE_S * 1000;
}

function isoIn(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

// Reuse detected (or a rotation race lost): revoke every refresh token in the family and delete
// the access tokens the family minted, so a thief holding either half is cut off. The legitimate
// client re-authorizes once. Deleting (not expiring) the access rows sidesteps the ISO-vs-datetime()
// string-compare trap in mcp/server.ts: a missing row is unambiguous to every lookup.
async function revokeRefreshFamily(env: Env, familyId: string): Promise<void> {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM oauth_tokens WHERE token_hash IN (
         SELECT access_token_hash FROM oauth_refresh_tokens
          WHERE family_id = ? AND access_token_hash IS NOT NULL)`
    ).bind(familyId),
    env.DB.prepare(
      "UPDATE oauth_refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL"
    ).bind(now, familyId),
  ]);
}

// POST /oauth/token: authorization_code and refresh_token grants.
export async function postOAuthToken(request: Request, env: Env): Promise<Response> {
  // Accept both JSON and form-urlencoded bodies.
  let params: Record<string, string>;
  const ct = request.headers.get("Content-Type") ?? "";
  if (ct.includes("application/x-www-form-urlencoded")) {
    const text = await request.text();
    params = Object.fromEntries(new URLSearchParams(text));
  } else {
    try {
      params = await request.json() as Record<string, string>;
    } catch {
      return oauthError("invalid_request", "Invalid request body", 400, request);
    }
  }
  if (!params || typeof params !== "object") {
    return oauthError("invalid_request", "Invalid request body", 400, request);
  }

  if (params.grant_type === "authorization_code") return authorizationCodeGrant(params, request, env);
  if (params.grant_type === "refresh_token")      return refreshTokenGrant(params, request, env);
  return oauthError("unsupported_grant_type", "Supported: authorization_code, refresh_token", 400, request);
}

async function authorizationCodeGrant(params: Record<string, string>, request: Request, env: Env): Promise<Response> {
  const { code, redirect_uri, client_id, code_verifier } = params;

  if (typeof code !== "string" || typeof client_id !== "string" || !code || !client_id) {
    return oauthError("invalid_request", "Missing required parameters", 400, request);
  }

  // Look up the code.
  const codeRow = await env.DB.prepare(
    "SELECT * FROM oauth_codes WHERE code = ? AND used = 0"
  ).bind(code).first<{
    client_id: string; redirect_uri: string;
    code_challenge: string | null; code_challenge_method: string | null;
    expires_at: string; companion_id: string | null;
  }>();

  if (!codeRow) {
    return oauthError("invalid_grant", "Invalid or already-used code", 400, request);
  }
  if (new Date(codeRow.expires_at) < new Date()) {
    return oauthError("invalid_grant", "Code has expired", 400, request);
  }
  if (codeRow.client_id !== client_id) {
    return oauthError("invalid_grant", "client_id mismatch", 400, request);
  }
  if (redirect_uri && codeRow.redirect_uri !== redirect_uri) {
    return oauthError("invalid_grant", "redirect_uri mismatch", 400, request);
  }

  // Verify PKCE if code was issued with a challenge.
  if (codeRow.code_challenge) {
    if (!code_verifier) {
      return oauthError("invalid_grant", "code_verifier required", 400, request);
    }
    const valid = await verifyPkce(
      code_verifier,
      codeRow.code_challenge,
      codeRow.code_challenge_method ?? "S256",
    );
    if (!valid) {
      return oauthError("invalid_grant", "PKCE verification failed", 400, request);
    }
  }

  // Issue the access token (90-day expiry, unchanged) plus a refresh token that starts a new family.
  const token        = newAccessToken();
  const refreshToken = newRefreshToken();
  const now          = new Date().toISOString();
  const tokenHash    = await hashToken(token);
  const refreshHash  = await hashToken(refreshToken);

  // Claim the code and issue both tokens in ONE batch (a D1 batch is one transaction), so a
  // transient failure rolls the whole exchange back and a retry with the same code still works.
  // The INSERTs run first and select from the code row only while it is still unused; the claim
  // runs last under the same condition. Batches are serialized, so exactly one exchange of a code
  // sees used = 0: a second one inserts nothing and its claim changes no row. The companion
  // binding is copied from the code row by SQL onto both tokens (fixed for the life of the family).
  const results = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, client_id, created_at, expires_at, companion_id)
       SELECT ?, client_id, ?, ?, companion_id FROM oauth_codes
        WHERE code = ? AND client_id = ? AND used = 0`
    ).bind(tokenHash, now, isoIn(ACCESS_TOKEN_TTL_S), code, client_id),
    env.DB.prepare(
      `INSERT INTO oauth_refresh_tokens
         (token_hash, family_id, client_id, companion_id, access_token_hash, created_at, expires_at)
       SELECT ?, ?, client_id, companion_id, ?, ?, ? FROM oauth_codes
        WHERE code = ? AND client_id = ? AND used = 0`
    ).bind(refreshHash, generateId(), tokenHash, now, isoIn(REFRESH_TOKEN_TTL_S), code, client_id),
    env.DB.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ? AND client_id = ? AND used = 0").bind(code, client_id),
  ]);
  if ((results[2]?.meta?.changes ?? 0) !== 1) {
    return oauthError("invalid_grant", "Invalid or already-used code", 400, request);
  }

  return tokenResponse({
    access_token:  token,
    token_type:    "Bearer",
    expires_in:    ACCESS_TOKEN_TTL_S,
    refresh_token: refreshToken,
    scope:         "",
  }, request);
}

// RFC 6749 section 6 + OAuth 2.1: public client, so client_id is required and must match; the
// refresh token is single-use and rotated; presenting a spent token revokes the whole family.
// Every refusal is the same invalid_grant body, so a caller holding a stolen token learns nothing
// about which property failed.
async function refreshTokenGrant(params: Record<string, string>, request: Request, env: Env): Promise<Response> {
  const { refresh_token, client_id } = params;
  if (typeof refresh_token !== "string" || typeof client_id !== "string" || !refresh_token || !client_id) {
    return oauthError("invalid_request", "Missing refresh_token or client_id", 400, request);
  }
  const refused = () => oauthError("invalid_grant", "Invalid, expired, or revoked refresh token", 400, request);

  const oldHash = await hashToken(refresh_token);
  const row = await env.DB.prepare(
    "SELECT family_id, client_id, expires_at, used_at, revoked_at FROM oauth_refresh_tokens WHERE token_hash = ?"
  ).bind(oldHash).first<{
    family_id: string; client_id: string; expires_at: string; used_at: string | null; revoked_at: string | null;
  }>();

  if (!row) return refused();
  if (row.revoked_at) return refused();
  if (row.used_at) {
    // A rotated token presented again: the client or a thief holds a stale copy. Inside the grace
    // window this is most likely the real client retrying or racing itself, so refuse without
    // revoking (the winner's tokens stay valid). Outside it, kill the family.
    if (!withinReuseGrace(row.used_at)) await revokeRefreshFamily(env, row.family_id);
    return refused();
  }
  if (row.client_id !== client_id) return refused();
  if (new Date(row.expires_at) < new Date()) return refused();

  const newAccess     = newAccessToken();
  const newRefresh    = newRefreshToken();
  const newAccessHash = await hashToken(newAccess);
  const newHash       = await hashToken(newRefresh);
  const now           = new Date().toISOString();

  // Claim and issue in one batch (a D1 batch is one transaction). The claim is conditional on the
  // token still being unused and unrevoked; both INSERTs select from the old row only where it now
  // points at THIS request's new token, so a request that lost a race inserts nothing. client_id and
  // companion_id are copied from the stored row by SQL, never read from the request, so a refresh
  // cannot change or widen the binding.
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE oauth_refresh_tokens SET used_at = ?, replaced_by = ?
        WHERE token_hash = ? AND used_at IS NULL AND revoked_at IS NULL`
    ).bind(now, newHash, oldHash),
    env.DB.prepare(
      `INSERT INTO oauth_tokens (token_hash, client_id, created_at, expires_at, companion_id)
       SELECT ?, client_id, ?, ?, companion_id FROM oauth_refresh_tokens
        WHERE token_hash = ? AND replaced_by = ?`
    ).bind(newAccessHash, now, isoIn(ACCESS_TOKEN_TTL_S), oldHash, newHash),
    env.DB.prepare(
      `INSERT INTO oauth_refresh_tokens
         (token_hash, family_id, client_id, companion_id, access_token_hash, created_at, expires_at)
       SELECT ?, family_id, client_id, companion_id, ?, ?, ? FROM oauth_refresh_tokens
        WHERE token_hash = ? AND replaced_by = ?`
    ).bind(newHash, newAccessHash, now, isoIn(REFRESH_TOKEN_TTL_S), oldHash, newHash),
  ]);

  if ((results[0]?.meta?.changes ?? 0) !== 1) {
    // Another request spent this token between our read and our claim: treat exactly as reuse,
    // grace window included (a lost race is almost always the real client racing itself).
    const spent = await env.DB.prepare(
      "SELECT used_at FROM oauth_refresh_tokens WHERE token_hash = ?"
    ).bind(oldHash).first<{ used_at: string | null }>();
    if (!spent?.used_at || !withinReuseGrace(spent.used_at)) await revokeRefreshFamily(env, row.family_id);
    return refused();
  }

  return tokenResponse({
    access_token:  newAccess,
    token_type:    "Bearer",
    expires_in:    ACCESS_TOKEN_TTL_S,
    refresh_token: newRefresh,
    scope:         "",
  }, request);
}
