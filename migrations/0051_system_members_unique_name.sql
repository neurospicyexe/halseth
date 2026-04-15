-- 0051_system_members_unique_name.sql
-- Add UNIQUE constraint to system_members.name so duplicate member names
-- are prevented at the database level.
-- If a name collision exists, this migration will fail -- resolve duplicates first.

CREATE UNIQUE INDEX IF NOT EXISTS idx_system_members_name_unique ON system_members(name COLLATE NOCASE);
