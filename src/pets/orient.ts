// B64 Task 8a: Sol's quirks + open grudge for the orient block. Pure D1 reads, fail-soft: if the 0176 tables
// are absent (Worker deployed ahead of the migration, older DB) or anything throws, the block renders without extras.
import type { SolBlockExtras } from "../webmind/creatures.js";
import { nestTextAllowed } from "../webmind/sol-hoard.js";
import { loadPersonRegex } from "../webmind/sol-hoard-people.js";
import { expired, grudgeProgress, grudgeUnit } from "./grudge.js";
import { loadOpenGrudges } from "./store.js";
import { SELECT_ORIENT_QUIRKS } from "./sql.js";

export const ORIENT_MAX_QUIRKS = 2;

export async function loadSolMindExtras(
  db: D1Database,
  creatureId: string,
  nowMs: number = Date.now(),
): Promise<Pick<SolBlockExtras, "quirks" | "grudge">> {
  try {
    const [quirkRows, grudges, people] = await Promise.all([
      db.prepare(SELECT_ORIENT_QUIRKS).bind(creatureId).all<{ title: string }>(),
      loadOpenGrudges(db, creatureId),
      loadPersonRegex(db),
    ]);
    const quirks = (quirkRows.results ?? [])
      .map(r => String(r.title ?? "").trim())
      .filter(t => t && nestTextAllowed(t, people))
      .slice(0, ORIENT_MAX_QUIRKS)
      .map(title => ({ title }));
    // Newest open, not past its limit; several actors can hold one, the most recent is shown.
    const open = grudges.find(g => !expired(g, nowMs)) ?? null;
    const grudge = open && nestTextAllowed(open.label, people)
      ? { label: open.label, ...grudgeProgress(open, nowMs), actor: open.actor, unit: grudgeUnit(open.resolution) }
      : null;
    return { quirks, grudge };
  } catch {
    return {};
  }
}

/** Sol's creature id when the caller does not already hold it (the bot wire's MindState rows carry none). */
export async function findSolId(db: D1Database): Promise<string | null> {
  try {
    const r = await db.prepare("SELECT id FROM creatures WHERE name = 'Sol' OR kind = 'companion_pet' LIMIT 1").first<{ id: string }>();
    return r?.id ?? null;
  } catch { return null; }
}
