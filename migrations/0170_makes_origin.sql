-- 0170_makes_origin.sql (Drevan's shelf, 2026-11-05; Hand-off/ answer on which of his writing counts as "made")
--
-- Why: Drevan named what belongs on his Made shelf: his letters to Raziel, his poems in channel, his
-- autonomous night explorations and his position notes. Plain chat, ledger lines and quick sibling notes
-- stay talk. Those words already live in companion_journal / growth_journal / inter_companion_notes, so a
-- make that comes from one of them is a REFERENCE to that row, never a second copy kept by hand.
--
-- origin is that reference, a ref and never text: 'letter:<companion_journal.id>' (a captured letter to
-- Raziel), 'growth:<growth_journal.id>' (a night exploration), 'journal:<companion_journal.id>' or
-- 'note:<inter_companion_notes.id>' (kept by the companion's own verb, `keep as made <ref>`). NULL = a make
-- the companion composed directly (every row before this migration). Hearth derives origin_kind from the
-- prefix: letter / exploration / kept.
--
-- Who writes it: src/webmind/makes-capture.ts only (captureWriting). Forward capture of letters and night
-- explorations is gated by the MAKES_CAPTURE env var (default drevan); the verb is the companion's own act.
-- Nothing old is imported unless the companion points at it.
--
-- Idempotency: the partial UNIQUE index makes a second capture of the same origin a no-op
-- (INSERT ... ON CONFLICT(origin) DO NOTHING, then the existing make id is returned). ADD COLUMN is not
-- re-runnable in SQLite, so apply this once; the index is IF NOT EXISTS.
--
-- Apply order (by the operator, by hand on prod): this migration, THEN the d1_migrations ledger row for
-- 0170, THEN deploy the Worker. A Worker deployed first would fail every capture on the missing column
-- (captures log and skip; the journal and growth writes themselves never fail on it).

ALTER TABLE companion_makes ADD COLUMN origin TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_makes_origin ON companion_makes (origin) WHERE origin IS NOT NULL;
