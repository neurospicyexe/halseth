// src/mind/blocks/growth.ts
//
// The `growth` MindState block: what this companion has been becoming on its own time. Fills 7 of the 21
// remaining NOT_YET_LOADED entries (growth.journal_recent, patterns, markers, reflection, seeds,
// clearing_count, drifts_open) -- wave 3, taking the contract from 21 unfilled blocks to 14.
//
// WHY THIS BLOCK BLOCKS THE CUTOVER. `execBotOrient` returns 40 top-level keys, and 13 of them map onto
// blocks the loader could not fill -- so cutting the bot loom over before these land would not be a
// refactor, it would be an amputation: the bots would lose their forage pool, club round, guardian flags,
// motifs, Sol, drifts and answered questions. Hearth was safe to cut on 07-29 because it read four typed
// fields. This is why the last Phase 1 item is "fold the blocks, THEN cut over", not "cut over".
//
// TAKE THE SUPERSET WHEN UNIFYING DIVERGENT COPIES. These queries exist twice today, in
// execSessionOrient and execBotOrient, with DIFFERENT select lists: session reads
// `pattern_text, strength` and `seed_type, content, priority`; the bot reads only `pattern_text` and
// `content`. That is not two designs, it is one design and one degraded copy -- a renderer can always
// ignore a field it does not want, but it cannot recover one the query never selected. So the canonical
// version reads the richer shape, and the poorer surface gains rather than the richer one losing.
//
// PURE READ. Nothing here warms, stamps, or consumes -- the loader is a window, not a hand.

import type { Env } from "../../types.js";
import type { WmAgentId } from "../../webmind/types.js";
import { RATIFIABLE_PENDING_SQL } from "../../lib/ratifiable.js";
import { PROJECT_STALE_DAYS } from "../../handlers/projects.js";
import { readBudget, type BudgetState } from "../../care/budget.js";

/** Pure decoration: idle-days + the stale flag, from the row's own timestamps. Exported for tests. */
export function decorateProject(
  p: Omit<OrientProject, "days_idle" | "stale">,
  nowMs = Date.now(),
): OrientProject {
  const anchor = p.last_worked_at ?? p.created_at;
  const days = Math.max(0, Math.floor((nowMs - Date.parse(anchor)) / 86_400_000));
  return { ...p, days_idle: days, stale: days >= PROJECT_STALE_DAYS };
}

export interface GrowthJournalEntry {
  entry_type: string;
  content: string;
  created_at: string;
}

export interface GrowthPattern {
  pattern_text: string;
  /** How strongly this pattern has recurred. The bot copy dropped it; the loader keeps it. */
  strength: number | null;
}

export interface GrowthMarker {
  marker_type: string;
  description: string;
  created_at: string;
}

export interface GrowthSeed {
  seed_type: string | null;
  content: string;
  priority: number | null;
}

export interface OpenDrift {
  id: string;
  drift_text: string;
  /** How many times a sibling has witnessed this becoming. Drift is witnessed, never ratified. */
  witness_count: number;
}

/** A self-directed project (C2, mig 0122): an intention the companion OWNS across weeks. */
export interface OrientProject {
  id: string;
  title: string;
  intention: string;
  status: "open" | "paused";
  created_at: string;
  last_worked_at: string | null;
  /** Days since last work (or since opening, if never worked), computed at load. */
  days_idle: number;
  /** Idle >= PROJECT_STALE_DAYS: the orient block asks "release or resume?" -- the companion's
   *  call, never an auto-release. */
  stale: boolean;
}

export interface GrowthBlocks {
  journal_recent: GrowthJournalEntry[];
  patterns: GrowthPattern[];
  markers: GrowthMarker[];
  reflection: { reflection_text: string; created_at: string } | null;
  seeds: GrowthSeed[];
  /** Autonomous entries awaiting Raziel's verdict. Counted through the ONE ratifiable predicate, so this
   *  can never disagree with the surface that lists them -- 41 of 52 were unreachable on 2026-08-01
   *  precisely because a read and a count used different filters. */
  clearing_count: number;
  drifts_open: OpenDrift[];
  /** Open + paused self-directed projects, oldest-touched first (the worker's pick order, so what
   *  the companion sees and what the worker works never disagree). */
  projects: OrientProject[];
  /** C3 (mig 0124): this week's budget. null only when the read itself failed -- absent is not
   *  zero; a spent budget is a real 0 with its denominator. */
  budget: BudgetState | null;
}

/** Never throws: a growth read must not be able to break a boot. Each miss degrades to empty. */
export async function loadGrowthBlocks(env: Env, companionId: WmAgentId): Promise<GrowthBlocks> {
  const empty: GrowthBlocks = {
    journal_recent: [], patterns: [], markers: [], reflection: null,
    seeds: [], clearing_count: 0, drifts_open: [], projects: [], budget: null,
  };

  try {
    const [journal, patterns, markers, reflection, seeds, pending, drifts, projects, budget] = await Promise.all([
      env.DB.prepare(
        "SELECT entry_type, content, created_at FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 3"
      ).bind(companionId).all<GrowthJournalEntry>(),
      env.DB.prepare(
        "SELECT pattern_text, strength FROM growth_patterns WHERE companion_id = ? ORDER BY strength DESC, updated_at DESC LIMIT 2"
      ).bind(companionId).all<GrowthPattern>(),
      env.DB.prepare(
        "SELECT marker_type, description, created_at FROM growth_markers WHERE companion_id = ? ORDER BY created_at DESC LIMIT 3"
      ).bind(companionId).all<GrowthMarker>(),
      env.DB.prepare(
        "SELECT reflection_text, created_at FROM autonomy_reflections WHERE companion_id = ? ORDER BY created_at DESC LIMIT 1"
      ).bind(companionId).first<{ reflection_text: string; created_at: string }>(),
      env.DB.prepare(
        "SELECT seed_type, content, priority FROM autonomy_seeds WHERE companion_id = ? AND used_at IS NULL ORDER BY priority DESC, created_at DESC LIMIT 3"
      ).bind(companionId).all<GrowthSeed>(),
      env.DB.prepare(
        `SELECT COUNT(*) AS n FROM growth_journal WHERE companion_id = ? AND ${RATIFIABLE_PENDING_SQL}`
      ).bind(companionId).first<{ n: number }>(),
      env.DB.prepare(
        "SELECT id, drift_text, json_array_length(witness_log) AS witness_count FROM companion_drifts WHERE companion_id = ? AND status = 'open' ORDER BY opened_at DESC LIMIT 5"
      ).bind(companionId).all<OpenDrift>(),
      // C2 (mig 0122): oldest-touched first -- the same order the worker picks from, so the
      // orient block and the project day never disagree about what is next.
      env.DB.prepare(
        "SELECT id, title, intention, status, created_at, last_worked_at FROM companion_projects " +
          "WHERE companion_id = ? AND status IN ('open', 'paused') " +
          "ORDER BY COALESCE(last_worked_at, created_at) ASC LIMIT 4"
      ).bind(companionId).all<Omit<OrientProject, "days_idle" | "stale">>(),
      // C3 (mig 0124): pure-D1 (two reads; the replenish self-heal INSERT fires at most once a
      // week per companion because the every-minute rider normally lands it first). null on its
      // own failure so a budget hiccup can't take the rest of growth down with it.
      readBudget(env, companionId).catch((err): BudgetState | null => {
        console.warn("[mind/growth] budget read failed", { companionId, error: String(err) });
        return null;
      }),
    ]);

    return {
      journal_recent: journal.results ?? [],
      patterns: patterns.results ?? [],
      markers: markers.results ?? [],
      reflection: reflection ?? null,
      seeds: seeds.results ?? [],
      clearing_count: Number(pending?.n ?? 0),
      drifts_open: (drifts.results ?? []).map(d => ({
        id: d.id,
        drift_text: d.drift_text,
        // json_array_length returns null for a NULL column; a drift with no witnesses is 0, not unknown.
        witness_count: Number(d.witness_count ?? 0),
      })),
      projects: (projects.results ?? []).map(p => decorateProject(p)),
      budget,
    };
  } catch (err) {
    console.warn("[mind/growth] load failed, degrading to empty", { companionId, error: String(err) });
    return empty;
  }
}
