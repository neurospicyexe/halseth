-- 0085: bind an OAuth token to a companion (2026-06-18).
--
-- claude.ai custom connectors authenticate via OAuth, not a static Bearer, so the per-companion
-- *_MCP_SECRET tokens cannot be pasted into the web connector UI. Without a binding, the Librarian
-- trusts the companion_id the caller claims (fine for the lean phase, but the interiority room's whole
-- promise is a hard wall between companions). This adds the binding at the layer where it is safe to
-- set: the human-approved /oauth/authorize step. Raziel picks which companion a connector is for when
-- he approves it in his own browser; the model never touches that choice.
--
--   companion_id NULL  -> unbound (admin / bots / Raziel's own direct connector): trust the claim,
--                         exactly as today. ALL existing tokens are NULL, so nothing breaks.
--   companion_id set   -> the token may ONLY act as that companion; a mismatched claim is rejected.
--
-- Carried code -> token: the selection is captured on the authorization code and copied onto the
-- issued access token at exchange.
ALTER TABLE oauth_codes  ADD COLUMN companion_id TEXT;
ALTER TABLE oauth_tokens ADD COLUMN companion_id TEXT;
