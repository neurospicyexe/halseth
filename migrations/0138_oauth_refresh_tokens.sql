-- 0138: OAuth 2.0 refresh tokens (2026-09-28, STATUS B26).
--
-- Before this, /oauth/token only knew grant_type=authorization_code and access tokens lived 90 days,
-- so every claude.ai connector died on its expiry and had to be re-authorized by hand. This adds the
-- refresh_token grant (RFC 6749 section 6, OAuth 2.1 rotation + reuse detection).
--
-- Why a separate table and not more columns on oauth_tokens: oauth_tokens is keyed by the ACCESS
-- token hash and both live lookups (librarian/mcp.ts, mcp/server.ts) read it by that PK. A refresh
-- token has a different lifecycle (single use, rotated, revocable as a family, longer expiry). Putting
-- both kinds behind one PK would force every existing access-token lookup to learn a kind filter, and
-- a missed filter would let a refresh token be spent as a bearer token. Separate table = zero change
-- to the access-token read path.
--
--   token_hash         SHA-256 hex of the refresh token (hashed at rest, same as mig 0036).
--   family_id          one per authorization_code grant; every rotation inherits it. Reuse of a spent
--                      token revokes the whole family.
--   client_id          the client it was issued to; a refresh by any other client_id is refused.
--   companion_id       copied from the access token binding (mig 0085). Carried unchanged on every
--                      rotation; the refresh request can never set or widen it. NULL = unbound.
--   access_token_hash  the access token issued alongside this refresh token, so a family revoke can
--                      also kill the access tokens that family minted.
--   replaced_by        hash of the refresh token this one rotated into (the chain, and the marker the
--                      rotation's conditional INSERTs key on so a lost race inserts nothing).
--   expires_at         sliding: each rotation issues a fresh token with a fresh window.
--   used_at            set when rotated. Presenting a token with used_at set is reuse.
--   revoked_at         set by family revocation.
--
-- Existing access tokens get no refresh row; they keep working until their own expires_at.
CREATE TABLE IF NOT EXISTS oauth_refresh_tokens (
  token_hash        TEXT PRIMARY KEY,
  family_id         TEXT NOT NULL,
  client_id         TEXT NOT NULL,
  companion_id      TEXT,
  access_token_hash TEXT,
  replaced_by       TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT NOT NULL,
  used_at           TEXT,
  revoked_at        TEXT
);

CREATE INDEX IF NOT EXISTS idx_oauth_refresh_family ON oauth_refresh_tokens(family_id);
CREATE INDEX IF NOT EXISTS idx_oauth_refresh_client ON oauth_refresh_tokens(client_id);
