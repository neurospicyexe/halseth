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
}

/**
 * Slice a Second Brain chunk to `maxLen` chars, prefixing its relative age when the row
 * carries a date column -- the prefix survives the slice, so the date does too. Chunks
 * without a date render exactly as before.
 */
export function excerptWithAge(c: HistoryChunk, maxLen: number, now: number = Date.now()): string {
  const body = String(c.chunk_text ?? c.text ?? "").slice(0, maxLen);
  if (!body) return "";
  const ts = c.created_at ?? c.date;
  return ts ? `(${relativeTime(ts, now)}) ${body}` : body;
}
