// gaia_witness.witness_type guard (2026-10-06).
//
// The bot client sent `{ entry, channel }` to witness_log and the executor took `channel` as an
// alias for witness_type, so 3,489 of 3,499 prod rows carry a Discord channel snowflake as their
// type. History is left as stored on purpose (the snowflake is the only record of which channel a
// row came from); the write side refuses snowflakes from now on and the read side shows them as
// "observation", the type the executor always defaulted to.

export const DEFAULT_WITNESS_TYPE = "observation";

const SNOWFLAKE = /^\d{15,22}$/;

/** True for a Discord-snowflake-shaped string (15 to 22 digits). */
export function isSnowflake(value: string): boolean {
  return SNOWFLAKE.test(value.trim());
}

/** A usable witness_type: trimmed, non-empty, never a snowflake. Anything else reads as "observation". */
export function normalizeWitnessType(value: string | null | undefined): string {
  const t = (value ?? "").trim();
  if (!t || SNOWFLAKE.test(t)) return DEFAULT_WITNESS_TYPE;
  return t;
}
