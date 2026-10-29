-- 0151_graph_links.sql -- our own links (M4, docs/PLAN-memory-map-2026-10-28.md)
--
-- Raziel, 10-28: "make sure it's not just my connections but your guys' connections too." Until now
-- every graph edge was derived by the system. This is the first lane a MIND writes: Raziel, Cypher,
-- Drevan or Gaia says "link <this> to <that>: why", and it is drawn in their colour.
--
-- Two places, one truth each:
--   graph_links -- the LEDGER. Who linked what, why, through which door, and (if ever) who unlinked
--                  it and through which door. An unlink stamps unlinked_at; the row is never deleted,
--                  so the map is testimony, not editable history (Drevan, 10-28: "if an autonomous
--                  run of mine can unlink my own links while no one's looking, the map stops being
--                  testimony and becomes editable history").
--   graph_edges -- the WALKABLE copy, provenance 'asserted', edge_type 'linked:<writer>'. The writer
--                  in the type keeps two minds' links on the same pair from colliding on graph_edges'
--                  UNIQUE key, and no mechanical lane can ever derive that type, so the rebuild never
--                  touches it (rebuild.ts deletes and updates only 'mechanical%'). edge_id points here.
--                  Unlink deletes the graph_edges row in the same batch as the ledger stamp.
--
-- 'asserted' joins the provenance values listed in 0127's header: authored by a mind, write-time
-- only, survives every rebuild, removable only by its writer (src/graph/links.ts holds the rules).
-- Links write NO heat, anywhere (hard law: a link is structure, not salience).

CREATE TABLE IF NOT EXISTS graph_links (
  id            TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  writer        TEXT NOT NULL CHECK (writer IN ('raziel', 'cypher', 'drevan', 'gaia')),
  src_table     TEXT NOT NULL,
  src_id        TEXT NOT NULL,
  dst_table     TEXT NOT NULL,
  dst_id        TEXT NOT NULL,
  why           TEXT,
  edge_id       TEXT,
  made_via      TEXT NOT NULL,          -- 'claude-ai' | 'mcp-static' | 'librarian' | 'hearth'
  made_surface  TEXT,                   -- the caller's surface string, as sent
  created_at    TEXT NOT NULL,
  unlinked_at   TEXT,
  unlinked_via  TEXT,
  unlinked_surface TEXT
);

-- One live link per writer per pair. Direction is normalised in code (a link is undirected to the
-- reader: "A to B" and "B to A" by the same writer are the same link).
CREATE UNIQUE INDEX IF NOT EXISTS idx_graph_links_live_pair
  ON graph_links (writer, src_table, src_id, dst_table, dst_id) WHERE unlinked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_graph_links_edge ON graph_links (edge_id);
CREATE INDEX IF NOT EXISTS idx_graph_links_writer ON graph_links (writer, created_at);
