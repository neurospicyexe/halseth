-- 0066_synthesis_domains.sql
-- Adds a controlled-vocabulary domain tag list to synthesis_summary.
-- Non-destructive: nullable JSON array. Existing rows stay valid (NULL = untagged).
-- Vocabulary lives in src/synthesis/domains.ts (SUPPORTED_MEMORY_DOMAINS).

ALTER TABLE synthesis_summary ADD COLUMN domains TEXT; -- JSON array of MemoryDomain, NULL = untagged
