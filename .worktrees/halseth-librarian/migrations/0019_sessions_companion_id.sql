-- Re-add companion_id to sessions as nullable TEXT.
-- Removed in 0003 per spec, but multi-companion multi-thread usage requires
-- companions to find their own sessions without colliding with other threads.
ALTER TABLE sessions ADD COLUMN companion_id TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_companion_id ON sessions(companion_id);
