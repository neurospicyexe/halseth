-- OAuth 2.0 support for claude.ai web + Claude iOS custom connectors.
-- Implements Authorization Code flow with PKCE (RFC 7636) and Dynamic Client Registration (RFC 7591).

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id    TEXT PRIMARY KEY,
  client_name  TEXT,
  redirect_uris TEXT NOT NULL,  -- JSON array
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT,
  code_challenge_method TEXT,
  created_at            TEXT NOT NULL,
  expires_at            TEXT NOT NULL,
  used                  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token      TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  created_at TEXT NOT NULL
);
