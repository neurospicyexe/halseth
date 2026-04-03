-- Migration 0033: add source column to companion_journal
-- Enables autonomous corpus tagging. Values: 'session' | 'autonomous' | null (untagged legacy)
-- companion_dreams and feelings already have source columns.

ALTER TABLE companion_journal ADD COLUMN source TEXT DEFAULT NULL;
