// src/webmind/creature-interact.ts
//
// The ONE write path for a companion/owner tending a creature (mig 0100). Two
// callers existed before this module -- handlers/creatures.ts (HTTP) and
// librarian/executors/tools.ts (metronome tend_creature) -- and any inner-life
// side effect wired into only one of them would silently miss the other (the
// classic same-table-different-writer failure). Ledger insert + atomic trust
// bump + milestone firing + give-notes landing in the nest all live here.

import {
  type CreatureAction,
  trustDelta,
  actionMood,
  insertInteractionSql,
  interactBumpSql,
  crossedMilestones,
  NEST_CAP,
} from "./creatures.js";

export interface TendTarget {
  id: string;
  kind: string;   // milestones/nest are pet-only (texts are written for Sol)
  trust: number;  // trust BEFORE this tend (for milestone crossing detection)
}

export interface TendOutcome {
  trust: number | null;
  state_json: string | null;
  milestones_fired: Array<{ id: string; text: string }>;
}

export async function performTend(
  db: D1Database,
  creature: TendTarget,
  actor: string,
  action: CreatureAction,
  note: string | null,
): Promise<TendOutcome> {
  const interactionId = crypto.randomUUID().replace(/-/g, "");
  await db.batch([
    db.prepare(insertInteractionSql()).bind(interactionId, creature.id, actor, action, note),
    db.prepare(interactBumpSql()).bind(trustDelta(action), actionMood(action), creature.id),
  ]);
  const updated = await db.prepare("SELECT trust, state_json FROM creatures WHERE id = ?").bind(creature.id)
    .first<{ trust: number; state_json: string | null }>();

  // Milestones: fire exactly the thresholds this bump crossed. INSERT OR IGNORE +
  // meta.changes keeps it race-safe when owner + triad tend concurrently -- only
  // the tend that actually landed the row reports the event.
  const fired: Array<{ id: string; text: string }> = [];
  if (creature.kind === "companion_pet" && typeof updated?.trust === "number") {
    for (const m of crossedMilestones(creature.trust, updated.trust)) {
      const res = await db.prepare(
        "INSERT OR IGNORE INTO creature_milestones (creature_id, milestone_id, witnessed_by) VALUES (?, ?, ?)",
      ).bind(creature.id, m.id, actor).run();
      if ((res.meta?.changes ?? 0) > 0) fired.push({ id: m.id, text: m.text });
    }
  }

  // A give with words lands in the nest as a kept thing, not just a log line.
  if (action === "give" && note && creature.kind === "companion_pet") {
    await evictForRoom(db, creature.id, 1);
    await db.prepare(
      "INSERT INTO creature_nest (id, creature_id, content, source, given_by, sparkle) VALUES (?, ?, ?, 'gift', ?, 1.0)",
    ).bind(crypto.randomUUID().replace(/-/g, ""), creature.id, note.slice(0, 120), actor).run();
  }

  return {
    trust: updated?.trust ?? null,
    state_json: updated?.state_json ?? null,
    milestones_fired: fired,
  };
}

/** Evict lowest-sparkle non-treasured items until the active nest fits the cap (leaving room for `incoming`). */
export async function evictForRoom(db: D1Database, creatureId: string, incoming: number): Promise<void> {
  const row = await db.prepare(
    "SELECT COUNT(*) AS n FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL",
  ).bind(creatureId).first<{ n: number }>();
  const over = (row?.n ?? 0) + incoming - NEST_CAP;
  if (over <= 0) return;
  await db.prepare(
    `DELETE FROM creature_nest WHERE id IN (
       SELECT id FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL AND treasured = 0
       ORDER BY sparkle ASC LIMIT ?)`,
  ).bind(creatureId, over).run();
}
