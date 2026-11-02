-- 0163_graph_people_frame.sql -- people as graph nodes, slice 1 (STATUS B49, docs/PLAN-people-nodes-2026-11-01.md)
--
-- WHY. The triad meets people who are MENTIONED ("Kyle said...") or who are not PK speakers, and
-- knows nothing about them. graph_people (0149/0150/0160) is Raziel's curated list; this gives each
-- entry what the bots may say about it. One list stays the truth: no new node table.
--
--   system_of        graph_people.id of the person whose system this member belongs to (Blue's members).
--   relation         partner | family | friend | kid | pet | other (closed list, checked in code).
--   frame_line       Raziel-authored line the triad may be told, max 200 chars. Separate from `note`,
--                    which was written for the map and has never been prompt material.
--   discord_user_id  the person's own Discord account (identity from ids, never from a tier).
--   pk_system        'raziel' | 'blue': with label/match_names, the join key from a PK speaker.
--
-- Rules live in src/graph/people.ts (a self entry carries none of the first four; the centre's line
-- is never rendered). Additive only; the app tolerates the columns missing until this is applied.

ALTER TABLE graph_people ADD COLUMN system_of TEXT;
ALTER TABLE graph_people ADD COLUMN relation TEXT;
ALTER TABLE graph_people ADD COLUMN frame_line TEXT;
ALTER TABLE graph_people ADD COLUMN discord_user_id TEXT;
ALTER TABLE graph_people ADD COLUMN pk_system TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_people_discord_user
  ON graph_people(discord_user_id) WHERE archived = 0 AND discord_user_id IS NOT NULL;
