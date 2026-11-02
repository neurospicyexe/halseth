// R18 (Drevan's ruling, 2026-10-22): how a growth pattern gains strength.
//
// Two numbers the system used to collapse into one are now separate:
//   - strength        earned ONLY by a new distinct MATERIAL (alula, Corsair, the dime ...). It reads as
//                     "how many real sightings", so a backfilled row's strength equals its material count.
//   - times_stated    how often the pattern was restated. Earns nothing; a return can be a breath.
// A restatement in a material already on the list is logged "returned, no new material" and strength does
// not move. A pattern that goes several runs AND a few weeks with only returns cools out of the headline
// boot seat (never out of the record, never lower in strength): something fresher gets handed to them.
//
// Pure functions only: the handler (handlers/growth.ts) and the orient loader (mind/blocks/growth.ts) both
// consume this, so the rule has exactly one author.

export interface Material { name: string; first_seen: string }

/** Cooling defaults (Drevan: "several runs or a few weeks"). Env knobs override per deploy. */
export const PATTERN_COOL_RETURNS = 3;
export const PATTERN_COOL_DAYS = 14;
export const MATERIAL_NAME_MAX = 60;
export const MATERIALS_MAX = 40;

const ARTICLES = new Set(["a", "an", "the", "of", "in", "on", "at", "to", "and"]);

/** Lowercase, strip punctuation and articles. "  The Dime. " -> "dime". Empty means "no material". */
export function normalizeMaterial(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/['’]s\b/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(t => t && !ARTICLES.has(t))
    .join(" ");
}

/** Same material if the normalised names match, or one's tokens are all contained in the other's. */
export function sameMaterial(a: string, b: string): boolean {
  const na = normalizeMaterial(a);
  const nb = normalizeMaterial(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) if (!large.has(t)) return false;
  return true;
}

export function parseMaterials(raw: string | null | undefined): Material[] {
  let parsed: unknown;
  try { parsed = JSON.parse(raw || "[]"); } catch { return []; }
  if (!Array.isArray(parsed)) return [];
  const out: Material[] = [];
  for (const item of parsed) {
    if (typeof item === "string" && item.trim()) {
      out.push({ name: item.trim().slice(0, MATERIAL_NAME_MAX), first_seen: "" });
    } else if (item && typeof item === "object") {
      const o = item as { name?: unknown; first_seen?: unknown };
      if (typeof o.name === "string" && o.name.trim()) {
        out.push({ name: o.name.trim().slice(0, MATERIAL_NAME_MAX), first_seen: typeof o.first_seen === "string" ? o.first_seen : "" });
      }
    }
  }
  return out;
}

export interface PatternCounters {
  strength: number;
  times_stated: number;
  returns_since_material: number;
  last_new_material_at: string | null;
  materials: Material[];
}

export type SightingOutcome = "new_material" | "returned";

/**
 * Apply one restatement of an existing pattern. `material` is what the model said this sighting is in;
 * the check against the stored list is HERE, server-side, not trusted to the model.
 * Legacy rows (materials = []) keep their preserved strength and climb from it on a new material.
 */
export function applySighting(
  cur: PatternCounters,
  material: string | null | undefined,
  nowMs: number,
): PatternCounters & { outcome: SightingOutcome } {
  const name = (material ?? "").trim().slice(0, MATERIAL_NAME_MAX);
  const times_stated = cur.times_stated + 1;
  const isNew = normalizeMaterial(name) !== "" && !cur.materials.some(m => sameMaterial(m.name, name));
  if (!isNew) {
    return { ...cur, times_stated, returns_since_material: cur.returns_since_material + 1, outcome: "returned" };
  }
  const at = new Date(nowMs).toISOString();
  return {
    materials: [...cur.materials, { name, first_seen: at }].slice(-MATERIALS_MAX),
    strength: Math.min(10, (cur.strength ?? 1) + 1),
    times_stated,
    returns_since_material: 0,
    last_new_material_at: at,
    outcome: "new_material",
  };
}

export interface SeatRow {
  returns_since_material: number | null;
  last_new_material_at: string | null;
  created_at: string;
}

/** Cooled = N or more returns since the last new material AND that material is older than D days. */
export function isCooledForSeat(
  row: SeatRow,
  nowMs: number,
  opts?: { returns?: number; days?: number },
): boolean {
  const returns = opts?.returns ?? PATTERN_COOL_RETURNS;
  const days = opts?.days ?? PATTERN_COOL_DAYS;
  if ((row.returns_since_material ?? 0) < returns) return false;
  // sqlite datetime('now') strings have no zone ("2026-10-05 10:46:49"); they are UTC.
  const raw = row.last_new_material_at ?? row.created_at;
  const t = Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
  if (!Number.isFinite(t)) return false;
  return nowMs - t > days * 86_400_000;
}

/** First `n` rows (caller-ordered by strength) that are not cooled. Cooled rows are skipped, not touched. */
export function selectHeadlinePatterns<T extends SeatRow>(
  rows: readonly T[],
  n: number,
  nowMs: number,
  opts?: { returns?: number; days?: number },
): T[] {
  return rows.filter(r => !isCooledForSeat(r, nowMs, opts)).slice(0, n);
}

/** Compact render for orient: "materials: alula, the dime". Empty string when the list is empty. */
export function formatMaterials(materials: readonly Material[]): string {
  return materials.length > 0 ? `materials: ${materials.map(m => m.name).join(", ")}` : "";
}

/** Env knob parse: positive integer or the default. */
export function knob(raw: string | undefined, dflt: number): number {
  const n = Number.parseInt(raw ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : dflt;
}
