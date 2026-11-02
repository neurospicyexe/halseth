-- 0150_graph_people_centre.sql -- Raziel is the centre of the map; system names are Raziel (M5 follow-up)
--
-- Raziel, 2026-10-29: "I don't want it to become something that treats the system members as
-- separate ... Raziel and Crash is the same." 0149 had a 'headmate' kind that would have put each
-- system member on the map as a person beside Raziel; a literal model reading that map would learn
-- the members are different people. Now:
--   'centre' -- exactly one row, id 'raziel': Raziel (also Crash). The single node every system name
--               resolves to. Never name-matched itself (824 + 928 kept rows would link it to nearly
--               everything); its links come from rows that are ABOUT Raziel (rebuild lane m).
--   'self'   -- a system name (Magpie, Jude ...). Its mentions link to the centre, the name riding
--               along as the front (provenance 'mechanical:front:<name>'), never to a node of its own.
--   'person' / 'pet' / 'other' -- people outside the system (Blue, family, the kids' adults, pets).
--
-- SQLite cannot alter a CHECK constraint, so the table is rebuilt; 0149's rows carry over with
-- 'headmate' read as 'self'. (Prod held one row at this point: an archived "Crash" added by a probe.)

CREATE TABLE graph_people_new (
  id           TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  label        TEXT NOT NULL,
  match_names  TEXT NOT NULL DEFAULT '[]',
  kind         TEXT NOT NULL DEFAULT 'person' CHECK (kind IN ('centre', 'self', 'person', 'pet', 'other')),
  pk_member_id TEXT,
  note         TEXT,
  added_by     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  archived     INTEGER NOT NULL DEFAULT 0
);

INSERT INTO graph_people_new (id, label, match_names, kind, pk_member_id, note, added_by, created_at, archived)
  SELECT id, label, match_names, CASE kind WHEN 'headmate' THEN 'self' ELSE kind END, pk_member_id, note, added_by, created_at, archived
    FROM graph_people;

DROP TABLE graph_people;
ALTER TABLE graph_people_new RENAME TO graph_people;

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_people_label_live ON graph_people(label) WHERE archived = 0;

INSERT OR IGNORE INTO graph_people (id, label, match_names, kind, note, added_by, created_at)
  VALUES ('raziel', 'Raziel', '["Crash"]', 'centre', 'The centre every memory is relative to. Also Crash.', 'system', '2026-10-29T00:00:00Z');
