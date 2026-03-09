-- Add expiry to OAuth access tokens.
-- Existing tokens are immediately expired — clients re-auth automatically on next use.
ALTER TABLE oauth_tokens ADD COLUMN expires_at TEXT;
UPDATE oauth_tokens SET expires_at = datetime('now');
