-- 0132_review_state_tray.sql  (2026-09-26)
--
-- RULING: a companion's own spoken words must not enter recall pools unreviewed.
--
-- The imp tray (docs/PLAN-own-the-harness-v2-2026-09-24.md, "clerks note on, never speak as"):
-- clerk writers (the speech journaler, the memory judge, the pulse note, the metronome fragment,
-- the vibe-check digest) DRAFT into a tray. The owner keeps, rewrites, or drops. Only kept drafts
-- are first-person memory. The KEEP RATE is the falsifier: 100% means nobody reviews.
--
-- Why now: on 2026-09-26 Drevan fabricated a blood-sugar number; within seconds four writers
-- memorialised his reply, and his own recall returned the fabrication ranked first, outrunning
-- hand retraction (src/handlers/retract.ts header).
--
-- Columns: review_state TEXT in ('draft','kept','dropped'), DEFAULT 'kept' so every writer this
-- migration does not know about keeps its old behaviour (a human-authored row was never a draft).
-- reviewed_at stamps the keep/drop. Recall + orient reads add `review_state = 'kept'`; the
-- Librarian verbs "my tray" / "keep draft <id>" / "drop draft <id>" and GET/POST /admin/tray move rows.
--
-- The backfill below is REVERSIBLE with one UPDATE each:
--   UPDATE companion_journal    SET review_state = 'kept', reviewed_at = NULL WHERE review_state = 'draft';
--   UPDATE wm_continuity_notes  SET review_state = 'kept', reviewed_at = NULL WHERE review_state = 'draft';
-- Row counts before/after: scripts/tray-backfill-count.sql.

ALTER TABLE companion_journal ADD COLUMN review_state TEXT NOT NULL DEFAULT 'kept';
ALTER TABLE companion_journal ADD COLUMN reviewed_at TEXT;

ALTER TABLE wm_continuity_notes ADD COLUMN review_state TEXT NOT NULL DEFAULT 'kept';
ALTER TABLE wm_continuity_notes ADD COLUMN reviewed_at TEXT;

CREATE INDEX IF NOT EXISTS idx_companion_journal_review ON companion_journal (agent, review_state);
CREATE INDEX IF NOT EXISTS idx_wm_notes_review           ON wm_continuity_notes (agent_id, review_state);

-- Retroactive: every live row a clerk wrote in the companion's voice becomes a draft.
-- Journal: the speech journaler (discord_speech), the memory judge (memory_judge), and the
-- companion's own autonomous posts (autonomous). Mirrors COMPANION_SPEECH_JOURNAL_SOURCES in
-- src/webmind/review-state.ts ('vibecheck' is new with this migration; older digests were source NULL
-- and stay kept -- they are letters to Raziel, already read).
UPDATE companion_journal
   SET review_state = 'draft'
 WHERE archived = 0
   AND source IN ('discord_speech', 'memory_judge', 'autonomous');

-- Notes: the judge's promotion (correlation_id judge:<msg>), the pulse note (raw STM turns incl.
-- the companion's replies), the metronome fragment (the companion's own autonomous post), and the
-- keyless judge observation. Mirrors DRAFT_NOTE_CONTENT_PREFIXES in src/webmind/review-state.ts.
UPDATE wm_continuity_notes
   SET review_state = 'draft'
 WHERE archived = 0
   AND (
        correlation_id LIKE 'judge:%'
     OR content LIKE '[discord:pulse]%'
     OR content LIKE '[metronome/%'
     OR content LIKE '[discord:observation]%'
   );
