-- Hash OAuth tokens at rest. Existing tokens are expired — MCP clients must re-authorize.
DROP TABLE IF EXISTS oauth_tokens;

CREATE TABLE oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
