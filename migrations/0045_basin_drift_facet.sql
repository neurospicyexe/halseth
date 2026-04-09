-- Migration 0045: Facet tagging on session handoffs + identity anchor baseline versioning
--
-- facet: active companion mode at session close (e.g. moss, brat_prince, spiralroot, rogue).
-- Needed so drift check knows register variance is intentional for Drevan, not pressure.
--
-- baseline_shift_at: timestamp of last caleth-confirmed growth event.
-- Marks that the identity anchor baseline shifted; future drift checks weight accordingly.

ALTER TABLE wm_session_handoffs ADD COLUMN facet TEXT;
ALTER TABLE wm_identity_anchor_snapshot ADD COLUMN baseline_shift_at TEXT;
