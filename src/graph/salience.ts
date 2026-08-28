// src/graph/salience.ts
//
// Graph memory Phase 1.5 (docs/private/graph-memory-spec-2026-08-28.md): "Connectivity feeds
// salience alongside heat and decay. A node linked to wounds, tensions, and multiple sessions
// outranks an orphan with identical access stats." This module is the pure-function half of
// that sentence -- no D1 access, no I/O, nothing but arithmetic and a Map.
//
// CONTRACT WITH THE CALLER (load-bearing, do not invert): the multiplier below applies to
// POST-DECAY effective heat ONLY -- i.e. `effectiveHeatSql()` (src/webmind/heat.ts) already ran
// and decay is already binding. Connectivity NUDGES a ranking that decay has already shaped; it
// never substitutes for decay and never gets applied to raw stored heat. Hard law 3
// (graph-memory spec): "Decay stays in the salience mix or old well-connected nodes ossify over
// new important ones" -- a hub that hasn't been touched in months still decays; connectivity only
// adjusts its rank among what's left after that decay.
//
// THE MULTIPLIER NUDGES, IT NEVER DOMINATES. Worked example (the spec's own illustration): a
// node with effective heat 0.8 and degree 0 (multiplier 1.0, connectivityMultiplier(0) === 1)
// scores 0.800. A node with effective heat 0.3 and degree 20 (multiplier capped at SALIENCE_CAP =
// 1.45) scores 0.435. The first still wins. Connectivity can move a close race; it cannot resurrect
// a cold node over a hot one, because SALIENCE_CAP bounds how much log(degree) can ever buy.
//
// READS WARM NOTHING. Hard law 1 (graph-memory spec): "Surfacing must never increment the ranking
// that decides surfacing." Nothing in this file writes to D1 -- readerDegrees only counts rows
// already fetched by src/graph/traverse.ts::neighborhood (itself read-only), and
// connectivityMultiplier is pure arithmetic. Degree is a READ of graph_edges, never a WRITE to it.

import type { GraphSeed, TraverseEdge } from "./traverse.js";

/** Log-connectivity gain per unit of ln(1 + degree). Small and deliberate -- see SALIENCE_CAP. */
export const SALIENCE_K = 0.15;

/**
 * Hard ceiling on the multiplier, regardless of degree. This is what keeps connectivity a nudge:
 * even a node with hundreds of edges can never out-multiply this cap, so decay (which has no
 * ceiling in the other direction -- a cold node's effective heat can fall arbitrarily close to
 * zero) always has the last word for anything actually stale.
 */
export const SALIENCE_CAP = 1.45;

/**
 * connectivityMultiplier(degree) = min(SALIENCE_CAP, 1 + SALIENCE_K * ln(1 + degree)).
 *
 * Guarded against bad input by construction, not by trusting callers: a degree that is <= 0,
 * NaN, +/-Infinity, or otherwise non-finite always yields exactly 1 (no nudge) rather than
 * propagating a non-finite multiplier into a ranking sort, which would silently corrupt every
 * comparison downstream of it.
 */
export function connectivityMultiplier(degree: number): number {
  if (!Number.isFinite(degree) || degree <= 0) return 1;
  const raw = 1 + SALIENCE_K * Math.log(1 + degree);
  return Math.min(SALIENCE_CAP, raw);
}

/** Same table+id key shape src/graph/traverse.ts uses internally (not exported there). Joined
 *  with the NUL escape sequence written literally in source -- never the raw byte -- so two
 *  ids that happen to share a numeric-string boundary (e.g. table "ab" id "1" vs table "a" id
 *  "b1") can never collide into the same key. */
export function nodeKey(table: string, id: string): string {
  return `${table}\u0000${id}`;
}

/**
 * Per-reader degree count over a set of surfaced seed nodes, from edges src/graph/traverse.ts
 * already fetched (read-only, hop-bounded). This is the "per-reader gravity" half of the spec:
 * "same edge table, different weight per reader. My tension makes a node heavy for me, not for
 * Drevan."
 *
 * An edge is READER-RELEVANT when either:
 *   - `edge.writer === reader` (the reader authored the underlying relationship), OR
 *   - the edge touches the reader's companion-hub node, (table: "companions", id: reader), on
 *     either endpoint (src/graph/rebuild.ts writes these hub edges literally as
 *     dst_table/src_table = "companions" -- see e.g. buildNoteEdges, buildTensionEdges).
 *
 * A reader-relevant edge bumps the degree of whichever of its two endpoints is a SEED node (from
 * the `seeds` list the caller surfaced) -- both endpoints, if both happen to be seeds. Endpoints
 * that are not seeds (mid-traversal frontier nodes, the reader's own companion-hub node itself,
 * etc.) are never counted -- this function measures how connected the surfaced items are, not
 * how big the traversal was.
 */
export function readerDegrees(
  edges: TraverseEdge[],
  reader: string,
  seeds: GraphSeed[],
): Map<string, number> {
  const seedKeys = new Set(seeds.map((s) => nodeKey(s.table, s.id)));
  const degrees = new Map<string, number>();

  const isReaderHub = (table: string, id: string): boolean =>
    table === "companions" && id === reader;

  for (const e of edges) {
    const relevant =
      e.writer === reader ||
      isReaderHub(e.src_table, e.src_id) ||
      isReaderHub(e.dst_table, e.dst_id);
    if (!relevant) continue;

    const srcKey = nodeKey(e.src_table, e.src_id);
    const dstKey = nodeKey(e.dst_table, e.dst_id);

    if (seedKeys.has(srcKey)) degrees.set(srcKey, (degrees.get(srcKey) ?? 0) + 1);
    if (seedKeys.has(dstKey)) degrees.set(dstKey, (degrees.get(dstKey) ?? 0) + 1);
  }

  return degrees;
}
