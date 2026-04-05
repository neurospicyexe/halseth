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

function renderAuthorizeForm(
  clientId: string,
  redirectUri: string,
  state: string,
  codeChallenge: string,
  codeChallengeMethod: string,
  errorMsg?: string,
): Response {
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
    grant_types_supported:              ["authorization_code"],
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

  // Verify admin passphrase.
  if (!env.ADMIN_SECRET || !safeEqual(secret, env.ADMIN_SECRET)) {
    return renderAuthorizeForm(clientId, redirectUri, state, codeChallenge, codeChallengeMethod, "Incorrect passphrase.");
  }

  // Issue authorization code (10-minute window).
  const code      = generateId();
  const now       = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await env.DB.prepare(`
    INSERT INTO oauth_codes (code, client_id, redirect_uri, code_challenge, code_challenge_method, created_at, expires_at, used)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0)
  `).bind(code, clientId, redirectUri, codeChallenge || null, codeChallengeMethod, now, expiresAt).run();

  const dest = new URL(redirectUri);
  dest.searchParams.set("code", code);
  if (state) dest.searchParams.set("state", state);

  return Response.redirect(dest.toString(), 302);
}

// POST /oauth/token — exchange code for access token.
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

  const { grant_type, code, redirect_uri, client_id, code_verifier } = params;

  if (grant_type !== "authorization_code") {
    return oauthError("unsupported_grant_type", "Only authorization_code is supported", 400, request);
  }
  if (!code || !client_id) {
    return oauthError("invalid_request", "Missing required parameters", 400, request);
  }

  // Look up the code.
  const codeRow = await env.DB.prepare(
    "SELECT * FROM oauth_codes WHERE code = ? AND used = 0"
  ).bind(code).first<{
    client_id: string; redirect_uri: string;
    code_challenge: string | null; code_challenge_method: string | null;
    expires_at: string;
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

  // Mark code as used (one-time use).
  await env.DB.prepare("UPDATE oauth_codes SET used = 1 WHERE code = ?").bind(code).run();

  // Issue access token and persist it with a 90-day expiry.
  const token     = generateId() + generateId().replace(/-/g, ""); // ~50-char token
  const now       = new Date().toISOString();
  const expiresIn = 90 * 24 * 60 * 60; // seconds
  const expiresAt = new Date(Date.now() + expiresIn * 1000).toISOString();

  const tokenHash = await hashToken(token);
  await env.DB.prepare(
    "INSERT INTO oauth_tokens (token_hash, client_id, created_at, expires_at) VALUES (?, ?, ?, ?)"
  ).bind(tokenHash, client_id, now, expiresAt).run();

  return jsonResponse({
    access_token: token,
    token_type:   "Bearer",
    expires_in:   expiresIn,
    scope:        "",
  }, 200, request);
}
