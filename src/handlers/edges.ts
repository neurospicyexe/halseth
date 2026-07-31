// src/handlers/edges.ts
//
// GET /admin/edges -- one readout for "are the relational edges actually filling in?"
//
// WHY THIS EXISTS (2026-07-31). Raziel asked whether to hold off building more edges until we see what
// works, and whether writing an edge is yet MANDATORY for the companions. Both good questions, and the
// second exposed the real gap: it is NOT mandatory, and the optional version is precisely what produced
// `inter_notes.ref_id` at 0.6% and `growth_journal.supersedes_id` at 0% over months.
//
// The reason not to simply force the field is that a forced judgment can be satisfied without being
// answered -- a companion that must declare "replaces X or different thought" can learn to always say
// "different thought", and then the column fills with confident garbage, which is worse than empty
// because it looks like data. So: measure whether the ASK is landing before making it a requirement.
//
// And that measurement did not exist, which is what made "hold and see" un-executable. This endpoint is
// the precondition for holding, not more building on top of it.
//
// Read-only, no migration, one request. Every number here answers a specific question:
//   * do companions RESOLVE a supersede proposal, or does it expire? -> whether the pen actually moved
//   * how many notes are even ADDRESSABLE?                          -> the ceiling on the provenance edge
//   * what fraction of each edge column is written?                 -> the six columns, honestly counted

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { SUPERSEDE_CANDIDATE_WINDOW_DAYS } from "../webmind/novelty.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2), {
    status, headers: { "Content-Type": "application/json" },
  });
}

async function one<T = Record<string, unknown>>(env: Env, sql: string): Promise<T | null> {
  try { return await env.DB.prepare(sql).first<T>(); }
  catch (err) { console.warn("[admin/edges] query failed", { error: String(err) }); return null; }
}

export async function getEdges(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  // 1. THE SUPERSEDE PEN. Did the companion answer, or did the proposal expire unanswered?
  //
  // "resolved" means the OLD belief now carries superseded_by -- i.e. a companion actually retired it.
  // "expired" means the window closed with the older belief still live, which is the SAFE default but
  // also the signal that the ask is not landing. If expired keeps climbing while resolved stays 0, the
  // proposal is invisible or ignored and the next move is the forced field.
  const supersede = await one(env, `
    SELECT
      (SELECT COUNT(*) FROM companion_conclusions WHERE supersede_candidate_id IS NOT NULL) AS proposed_total,
      (SELECT COUNT(*) FROM companion_conclusions n JOIN companion_conclusions o ON o.id = n.supersede_candidate_id
         WHERE n.supersede_candidate_id IS NOT NULL AND o.superseded_by IS NOT NULL) AS resolved,
      (SELECT COUNT(*) FROM companion_conclusions n JOIN companion_conclusions o ON o.id = n.supersede_candidate_id
         WHERE n.supersede_candidate_id IS NOT NULL AND o.superseded_by IS NULL
           AND datetime(n.created_at) > datetime('now','-${SUPERSEDE_CANDIDATE_WINDOW_DAYS} days')) AS open_in_window,
      (SELECT COUNT(*) FROM companion_conclusions n JOIN companion_conclusions o ON o.id = n.supersede_candidate_id
         WHERE n.supersede_candidate_id IS NOT NULL AND o.superseded_by IS NULL
           AND datetime(n.created_at) <= datetime('now','-${SUPERSEDE_CANDIDATE_WINDOW_DAYS} days')) AS expired_unanswered,
      (SELECT COUNT(*) FROM companion_conclusions WHERE superseded_by IS NOT NULL) AS retired_total
  `);

  // 2. THE PROVENANCE EDGE, with its own ceiling stated. `addressable` is the honest denominator: a note
  // with no channel-shaped thread_key CANNOT be addressed, and counting it as a miss would make the edge
  // look broken when it is correctly refusing.
  const provenance = await one(env, `
    SELECT
      (SELECT COUNT(*) FROM wm_continuity_notes WHERE archived = 0) AS live_notes,
      (SELECT COUNT(*) FROM wm_continuity_notes WHERE archived = 0
         AND thread_key IS NOT NULL AND thread_key GLOB '[0-9]*' AND length(thread_key) >= 15) AS addressable,
      -- datetime() ON BOTH SIDES. Notes store an ISO instant (2026-07-31T14:01:32.157Z) while SQLite
      -- datetime() emits space-separated (2026-07-30 12:11:38), so a raw string compare diverges at
      -- index 10 (T is 0x54, space is 0x20) and silently drops most matches. Measured on prod: raw
      -- compare 6, normalized 30 -- an 80% UNDERCOUNT in the very readout the hold-and-see decision
      -- rests on. The runtime edge was never affected (note-provenance.ts compares in JS via tsToMs,
      -- which normalizes), so this was a lying instrument rather than a broken feature -- and a lying
      -- instrument is the worse of the two when a decision hangs on it.
      (SELECT COUNT(*) FROM wm_continuity_notes n JOIN conversation_threads t
         ON t.channel_id = n.thread_key
         AND datetime(n.created_at) >= datetime(t.created_at)
         AND datetime(n.created_at) <= datetime(t.last_turn_at, '+15 minutes')
       WHERE n.archived = 0) AS addressed
  `);

  // 3. WHO WAS IN THE ROOM. `sibling_only` is the count that matters: those are the conversations whose
  // notes would previously have been recallable as Raziel's own words.
  const speakers = await one(env, `
    SELECT
      (SELECT COUNT(*) FROM conversation_threads) AS threads,
      (SELECT COUNT(*) FROM conversation_threads WHERE participants NOT LIKE '%raziel%') AS sibling_only,
      (SELECT COUNT(*) FROM conversation_threads WHERE participants LIKE '%blue%') AS with_blue,
      (SELECT COUNT(*) FROM conversation_threads WHERE participants LIKE '%guest%') AS with_guest,
      (SELECT COUNT(*) FROM thread_ledger) AS ledger_turns,
      (SELECT COUNT(*) FROM thread_ledger WHERE author LIKE '% (%')  AS turns_with_front
  `);

  // 4. THE SIX EDGE COLUMNS, counted plainly. The standing rule: do not add a seventh before one of these
  // is actually written. `pct` is rounded because a false precision invites arguing about noise.
  const cols: Array<{ name: string; table: string; sql: string }> = [
    { name: "growth_journal.supersedes_id",      table: "growth_journal",       sql: "supersedes_id IS NOT NULL" },
    { name: "conclusions.superseded_by",         table: "companion_conclusions", sql: "superseded_by IS NOT NULL" },
    { name: "inter_notes.ref_id",                table: "inter_companion_notes", sql: "ref_id IS NOT NULL" },
    { name: "notes.thread_key",                  table: "wm_continuity_notes",   sql: "thread_key IS NOT NULL" },
    { name: "notes.correlation_id",              table: "wm_continuity_notes",   sql: "correlation_id IS NOT NULL" },
    { name: "conversation_threads.ref_id",       table: "conversation_threads",  sql: "ref_id IS NOT NULL" },
  ];
  const edge_columns: Array<Record<string, unknown>> = [];
  for (const c of cols) {
    const r = await one<{ rows: number; filled: number }>(
      env, `SELECT COUNT(*) AS rows, SUM(CASE WHEN ${c.sql} THEN 1 ELSE 0 END) AS filled FROM ${c.table}`
    );
    const rows = Number(r?.rows ?? 0);
    const filled = Number(r?.filled ?? 0);
    edge_columns.push({
      column: c.name, rows, filled,
      pct: rows > 0 ? Math.round((filled / rows) * 1000) / 10 : 0,
      // Which kind of edge it is, because the two fill for completely different reasons and mixing them
      // is what made the whole problem look like one problem.
      kind: c.name.endsWith("thread_key") ? "derivable" : "needs a mind",
    });
  }

  return json({
    generated_at: new Date().toISOString(),
    supersede_pen: {
      ...supersede,
      window_days: SUPERSEDE_CANDIDATE_WINDOW_DAYS,
      read_this_as:
        "resolved > 0 means a companion actually moved the pen. expired_unanswered climbing with resolved at 0 " +
        "means the ask is not landing, and THEN a required field is the answer -- not before, because a forced " +
        "judgment can be satisfied without being answered.",
    },
    provenance_edge: {
      ...provenance,
      read_this_as:
        "addressable is the ceiling, not live_notes: a note with no channel cannot be addressed and counting " +
        "it as a miss would make an honest refusal look like a failure.",
    },
    speakers: {
      ...speakers,
      read_this_as:
        "sibling_only is the number that matters -- those conversations' notes were previously recallable as " +
        "Raziel's own words. turns_with_front only grows for turns taken after 2026-07-31; no backfill is " +
        "possible because the front was never recorded.",
    },
    edge_columns,
    standing_rule: "Do not add a seventh edge column before one of these six is actually written.",
  });
}
