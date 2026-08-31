// src/care/owner-activity.ts
//
// The ONE owner-activity read (consequence layer C1 + C6). "When was Raziel last seen, and where"
// across every surface D1 can see. Three consumers share it -- the care tick (owner_silence rule),
// the care register loader (the C6 quiet-owner truth line), and the /mind/care/owner-activity
// endpoint health-check.py polls for the custodian alert. One lane, one filter: a second copy of
// this UNION is how two consumers end up disagreeing about whether he is here.
//
// READ ONLY. Nothing in this module writes; per the anchor rule (care/tick.ts header), no consumer
// of this read may write any of the timestamps it reads.

import type { Env } from "../types.js";

export interface OwnerLastSeen {
  source: string;
  at: string;
}

/** The surfaces checked, in the order the detail line names them. Kept as data so a silence claim
 *  can always state its denominator. */
export const OWNER_ACTIVITY_SOURCES = [
  "sessions",
  "commons",
  "biometrics",
  "notes",
  "contact-drive",
] as const;

/* The sessions branch uses a range predicate instead of LIKE 'claude%': default LIKE is
 * case-insensitive in SQLite, which blocks the 0128 (surface, created_at) index; the
 * half-open range is the same prefix match and stays indexable. */
export async function readOwnerLastSeen(env: Env): Promise<OwnerLastSeen | null> {
  const row = await env.DB.prepare(
    `SELECT source, at FROM (
       SELECT 'sessions' AS source, MAX(created_at) AS at FROM sessions WHERE surface >= 'claude' AND surface < 'claudf'
       UNION ALL SELECT 'commons', MAX(created_at) FROM commons_posts WHERE author = 'raziel'
       UNION ALL SELECT 'biometrics', MAX(logged_at) FROM biometric_snapshots
       UNION ALL SELECT 'notes', MAX(created_at) FROM companion_notes WHERE author = 'human'
       UNION ALL SELECT 'contact-drive', MAX(last_event_at) FROM companion_drives WHERE drive_key = 'relational_need'
     ) WHERE at IS NOT NULL ORDER BY at DESC LIMIT 1`,
  ).first<OwnerLastSeen>();
  return row ?? null;
}
