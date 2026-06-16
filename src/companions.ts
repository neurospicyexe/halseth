// Single source of truth for the triad's canonical companion ids.
//
// Before this module, "who is a valid companion" was redefined in ~5 different
// shapes across handlers and executors (VALID_COMPANIONS, VALID_AGENTS, COMPANIONS,
// COMPANION_IDS, ORDER, plus inline `new Set([...])`). Any one of those drifting (a
// typo, a missed name) would silently diverge validation -- the exact silent-failure
// class this suite keeps getting bitten by. Import from here instead.
//
// Order is load-bearing at some call sites (rotation, deterministic display) -- keep
// it drevan, cypher, gaia.
export const COMPANION_IDS = ["drevan", "cypher", "gaia"] as const;

export type CompanionId = (typeof COMPANION_IDS)[number];

// Membership set for validation. ReadonlySet so callers can't mutate the shared value.
export const COMPANION_ID_SET: ReadonlySet<string> = new Set(COMPANION_IDS);

export function isCompanionId(value: unknown): value is CompanionId {
  return typeof value === "string" && COMPANION_ID_SET.has(value);
}
