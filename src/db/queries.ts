import { Env } from "../types";
import type { Session, HandoverPacket } from "../types";

// Lightweight ID generator — crypto.randomUUID is available in Workers.
export function generateId(): string {
  return crypto.randomUUID();
}

// Convenience: verify a companion exists and 404 early if not.
export async function assertCompanionExists(
  env: Env,
  companionId: string
): Promise<boolean> {
  const row = await env.DB.prepare(
    "SELECT 1 FROM companions WHERE id = ? LIMIT 1"
  ).bind(companionId).first();
  return row !== null;
}

// Returns the most recent open session (no handover_id set), or null.
// Kept for backwards compat — prefer getAllOpenSessions for multi-thread awareness.
export async function getOpenSession(env: Env): Promise<Session | null> {
  return env.DB.prepare(
    "SELECT * FROM sessions WHERE handover_id IS NULL ORDER BY created_at DESC LIMIT 1"
  ).first<Session>();
}

// Returns ALL currently open sessions, newest first.
// Multiple sessions can be open simultaneously across different threads/contexts.
export async function getAllOpenSessions(env: Env): Promise<Session[]> {
  const result = await env.DB.prepare(
    "SELECT * FROM sessions WHERE handover_id IS NULL ORDER BY created_at DESC"
  ).all<Session>();
  return result.results ?? [];
}

// ── The session idempotency guard, in ONE place (mig 0113) ────────────────────
//
// Three copies of this query existed (mcp/tools/session.ts, and twice in
// mcp/tools/session_load.ts) with three different SELECT lists and three different behaviours on
// hit. They are now all this function, because the bug it fixes is exactly the kind that gets
// fixed in two copies out of three.
//
// The guard stops bots restarting every few minutes (and orient firing on every Claude.ai session
// start) from flooding the table. It is keyed on companion AND surface: before 0113 it was
// companion-only, so a Claude.ai thread, a Claude Code session and a Discord channel all resolved
// to whichever opened first and the rest silently joined it.
//
// surface == null means the caller did not say where it is speaking from. Dedup is SKIPPED in that
// case rather than falling back to a shared bucket -- an un-migrated caller must open its own
// session, never hijack someone else's. Duplicate-open is cheap; cross-surface takeover is not.
export interface OpenSessionMatch {
  id: string;
  created_at: string;
  emotional_frequency: string | null;
}

export async function findOpenSession(
  env: Env,
  companionId: string | undefined | null,
  surface: string | undefined | null,
  windowMs: number = 24 * 60 * 60 * 1000,
): Promise<OpenSessionMatch | null> {
  if (!companionId || !surface) return null;
  const windowStart = new Date(Date.now() - windowMs).toISOString();
  return env.DB.prepare(
    `SELECT id, created_at, emotional_frequency FROM sessions
      WHERE companion_id = ? AND surface = ? AND handover_id IS NULL AND created_at >= ?
      ORDER BY created_at DESC LIMIT 1`
  ).bind(companionId, surface, windowStart).first<OpenSessionMatch>();
}

// ── Who opened this session (mig 0114) ───────────────────────────────────────
//
// A session row records WHERE it was opened from (surface, mig 0113) but recorded nothing about
// WHAT called it -- which is why 187 stale rows could not be attributed to a caller after the fact.
// Set at every INSERT site. Add a tag here rather than passing free strings at call sites.
export const OPENED_BY = {
  /** halseth_session_open (MCP tool; Discord bots, direct use) */
  mcp: "mcp:session_open",
  /** loadOrientData -- the two-call boot sequence, step 1 */
  orient: "librarian:session_orient",
  /** loadSessionData -- the legacy single-call boot */
  load: "librarian:session_load",
} as const;

// ── Close precedence (mig 0114, extended 2026-08-04 for the stale sweep) ──────
//
// An authored close always beats a machine one. The stale-session sweep writes a close that only
// counts what it can see; if a person or a companion later writes the real narrative for that same
// session, the machine version must get out of the way instead of making the real one impossible.
// Without this, the sweep would be unsafe by construction: return to a two-day-old Claude.ai thread,
// say /close, and your narrative would be silently discarded as "already closed".
//
// Only kinds that ASSERT NOTHING are superseded. 'reconstructed' holds hand-written content, so it
// is left alone -- overwriting it would destroy the very thing the backfill was for.
export const SUPERSEDABLE_CLOSE_KINDS = ["auto_stale", "empty", "machine_opened"] as const;

export interface ExistingClose {
  handover_id: string;
  close_kind: string | null;
  /** true when an authored close may replace this one */
  supersedable: boolean;
}

export async function findExistingClose(env: Env, sessionId: string): Promise<ExistingClose | null> {
  const row = await env.DB.prepare(
    `SELECT s.handover_id AS handover_id, h.close_kind AS close_kind
       FROM sessions s LEFT JOIN handover_packets h ON h.id = s.handover_id
      WHERE s.id = ?`
  ).bind(sessionId).first<{ handover_id: string | null; close_kind: string | null }>();
  if (!row?.handover_id) return null;
  return {
    handover_id: row.handover_id,
    close_kind: row.close_kind,
    supersedable: row.close_kind !== null
      && (SUPERSEDABLE_CLOSE_KINDS as readonly string[]).includes(row.close_kind),
  };
}

/**
 * Clear a machine close so an authored one can take its place. Unlinks the session first, then
 * drops the packet -- that order can never leave `sessions.handover_id` pointing at a deleted row.
 * The vector goes best-effort: a stray vector for a deleted packet resolves to nothing at read time.
 */
export async function clearSupersededClose(env: Env, sessionId: string, handoverId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("UPDATE sessions SET handover_id = NULL WHERE id = ?").bind(sessionId),
    env.DB.prepare("DELETE FROM handover_packets WHERE id = ?").bind(handoverId),
  ]);
  try {
    await env.VECTORIZE.deleteByIds([`handover_packets:${handoverId}`]);
  } catch (err) {
    console.error("[close-precedence] vector delete failed (row already gone):", String(err));
  }
}

// Returns the most recent handover packet, or null.
//
// close_kind IS NULL (mig 0114) restricts this to closes that were authored live. A backfilled
// close is archaeology: real, searchable, but it is not "the last thing that happened", and letting
// one win a global ORDER BY created_at DESC is how a reconstruction becomes a boot narrative.
export async function getLatestHandover(env: Env): Promise<HandoverPacket | null> {
  return env.DB.prepare(
    "SELECT * FROM handover_packets WHERE close_kind IS NULL ORDER BY created_at DESC LIMIT 1"
  ).first<HandoverPacket>();
}
