// src/lib/wound-dedup.ts
//
// Check-first dedup for living_wounds and prohibited_fossils (P3-5, BUGS.md 2026-10-08). Mig 0007
// put a global UNIQUE index on the EXACT wound name / fossil subject, so "Grief" and "grief " were
// two rows. No migration here: each write path asks first on LOWER(TRIM(x)) and acks the existing id
// instead of inserting. For wounds the owner clause reuses the read-side convention (a NULL
// companion_id is Gaia's, mig 0144), so the check matches exactly the rows "my wounds" would show.

import type { Env } from "../types.js";

export const WOUND_OWNER_SQL = "COALESCE(companion_id, 'gaia')";

export function normalizeName(s: string): string {
  return s.trim().toLowerCase();
}

export interface ExistingRow { id: string; created_at: string }

/** The caller's existing wound with this name (case/whitespace-insensitive), or null. */
export async function findExistingWound(
  env: Env, name: string, companionId: string | null,
): Promise<ExistingRow | null> {
  const owner = companionId ?? "gaia";
  return env.DB.prepare(
    `SELECT id, created_at FROM living_wounds WHERE LOWER(TRIM(name)) = ? AND ${WOUND_OWNER_SQL} = ? LIMIT 1`
  ).bind(normalizeName(name), owner).first<ExistingRow>();
}

/** The existing fossil for this subject (case/whitespace-insensitive), or null. */
export async function findExistingFossil(env: Env, subject: string): Promise<ExistingRow | null> {
  return env.DB.prepare(
    "SELECT id, created_at FROM prohibited_fossils WHERE LOWER(TRIM(subject)) = ? LIMIT 1"
  ).bind(normalizeName(subject)).first<ExistingRow>();
}
