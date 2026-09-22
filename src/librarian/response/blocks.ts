// src/librarian/response/blocks.ts
//
// Pure render helpers for orient context blocks -- extracted from executors/session.ts so
// the render output is unit-testable (same pattern as webmind/commons-block.ts). All dated
// items carry a relative age: without it the model reads any surfaced memory as fresh
// ("we listened yesterday" when the round has been active for a week). `now` is injectable
// for tests; a missing timestamp renders nothing rather than a bogus age.

import { relativeTime } from "../../webmind/relative-time.js";

// ── Club ─────────────────────────────────────────────────────────────────────

export interface ClubRoundRow {
  id: string;
  status: string;
  opened_at: string | null;
  activated_at: string | null;
  discussing_at: string | null;
  winner_title: string | null;
  candidate_count: number;
}

/** Build the [Club] orient block. Phase decides the cue; each phase carries its age. */
export function buildClubBlock(row: ClubRoundRow | null | undefined, now: number = Date.now()): string {
  if (!row) return "";
  if (row.status === "gathering") {
    const opened = row.opened_at ? ` (opened ${relativeTime(row.opened_at, now)})` : "";
    return `\n[Club]\nA club round is gathering${opened} -- recommend something (any medium) with a one-line pitch: "club recommend".`;
  }
  if (row.status === "voting") {
    const opened = row.opened_at ? `, opened ${relativeTime(row.opened_at, now)}` : "";
    return `\n[Club]\nClub round is voting (${row.candidate_count} candidates${opened}). Cast yours if you haven't: "club vote".`;
  }
  // active / discussing: "Now experiencing" with the phase clock, e.g.
  // "(active since 8 days ago, discussing since yesterday)".
  const phases = [
    row.activated_at ? `active since ${relativeTime(row.activated_at, now)}` : null,
    row.discussing_at ? `discussing since ${relativeTime(row.discussing_at, now)}` : null,
  ].filter(Boolean).join(", ");
  const clock = phases ? ` (${phases})` : "";
  const cue = row.status === "discussing"
    ? `Reflect on the experience: "club discuss".`
    : `If it's a book in the vault, "read the club book" pulls it (scoped -- no global-search noise); reflect any time with "club discuss".`;
  return `\n[Club]\nNow experiencing: ${row.winner_title ?? "the round's pick"}${clock}. ${cue}`;
}

// ── Vault excerpts ───────────────────────────────────────────────────────────

export interface HistoryChunk {
  chunk_text?: string;
  text?: string;
  created_at?: string;
  date?: string;
  /** Where it came from. Present on every /mind/search chunk (verified live 2026-09-22: 12 of 12
   *  carried created_at, vault_path AND section) and discarded by every renderer until then. */
  vault_path?: string;
  section?: string;
}

/**
 * Slice a Second Brain chunk to `maxLen` chars, prefixing its relative age when the row
 * carries a date column -- the prefix survives the slice, so the date does too. Chunks
 * without a date render exactly as before.
 */
/**
 * A short, human source label for a recalled chunk: the vault file's basename, or its section, or
 * "" when neither is present. Deliberately not the full path -- this rides in a budgeted prompt
 * block, and `2026-06-planning` is as identifying as `vault/notes/2026/2026-06-planning.md`.
 */
export function chunkSource(c: HistoryChunk): string {
  const path = (c.vault_path ?? "").trim();
  if (path) {
    const base = path.split("/").pop() ?? path;
    return base.replace(/\.(md|markdown|txt)$/i, "");
  }
  return (c.section ?? "").trim();
}

/**
 * INLINE PROVENANCE AT RETRIEVAL (2026-09-22, review candidate T): "a model cannot honour
 * provenance it cannot see."
 *
 * Renders `(age, source) body`. The prefix leads so it survives the slice -- the same reasoning
 * that put the age first in the bots' vault recall, and the reason this file already dated the
 * history lane: *an excerpt with no age reads as present-tense news*.
 *
 * WHY IT SHIPPED. That principle was applied to ONE of the two vault lanes. `historyBlock` and
 * `parseExcerpts(dated=true)` dated their chunks; `ragBlock` and `parseExcerpts(dated=false)` --
 * the `[Vault excerpts]` every companion reads at every boot, on every surface -- rendered raw
 * sliced text with no date and no source, while the chunks carried both the whole time. An undated
 * vault excerpt is exactly how a companion states something stale as though it were current.
 *
 * Degrades cleanly: no timestamp and no path renders precisely as before, so this can never make
 * an excerpt worse than it was.
 */
export function excerptWithProvenance(c: HistoryChunk, maxLen: number, now: number = Date.now()): string {
  const body = String(c.chunk_text ?? c.text ?? "").slice(0, maxLen);
  if (!body) return "";
  const ts = c.created_at ?? c.date;
  const bits = [ts ? relativeTime(ts, now) : "", chunkSource(c)].filter(Boolean);
  return bits.length ? `(${bits.join(", ")}) ${body}` : body;
}

