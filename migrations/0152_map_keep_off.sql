-- 0152_map_keep_off.sql -- names that never become a dot on the map (Drevan's FERPA point, 2026-10-29)
--
-- Drevan, answering broadcast 53f9c4ae: "A map is aggregation ... a graph of our whole shared life is
-- exactly the artifact where a hundred individually-safe nodes assemble into a picture. The map should
-- exclude by design, not by remember-to-redact." Raziel's rule (10-29/30): the test is whether someone
-- who knows where Raziel works, but not the details, could identify a kid. So a child's name that is
-- not a sprout of our system or Blue's, and the name of the school / building / district, stay off.
-- Raziel's work in general, being hit or bitten, their own body and feelings: those are theirs and stay.
--
-- One list, Raziel's (Hearth /people). Any visible row whose words contain a listed term, as a whole
-- word, case-insensitive, is dropped by graph/map.ts loadMapNodes -- the one labeler behind the map,
-- links, and the [Linked] boot block -- so it never becomes a node, can never be linked, and never
-- names a neighbour at boot. The row itself is untouched (memory, recall and boots outside the map are
-- not this list's job). Archive, never delete: taking a term off the list is reversible and on record.

CREATE TABLE IF NOT EXISTS map_keep_off (
  id         TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  term       TEXT NOT NULL COLLATE NOCASE,
  note       TEXT,
  added_by   TEXT NOT NULL,
  created_at TEXT NOT NULL,
  archived   INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_map_keep_off_live_term ON map_keep_off (term) WHERE archived = 0;
