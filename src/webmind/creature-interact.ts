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
  deriveDrives,
  trustTier,
  NEST_CAP,
} from "./creatures.js";
import { careResponse, SETTLED_WINDOW_MINUTES, type CareFit } from "./sol-care.js";
import { nestTextAllowed } from "./sol-hoard.js";
import { loadPersonRegex } from "./sol-hoard-people.js";

export interface TendTarget {
  id: string;
  kind: string;   // milestones/nest are pet-only (texts are written for Sol)
  trust: number;  // trust BEFORE this tend (for milestone crossing detection)
}

export interface TendOutcome {
  /** The creature_interactions row this tend wrote (an imp errand's ledger line points at it). */
  interaction_id: string;
  trust: number | null;
  state_json: string | null;
  milestones_fired: Array<{ id: string; text: string }>;
  /** Sol's answer to the care (companion_pet only; null for real animals). */
  care: { fit: CareFit; reaction: string; reaction_named: string } | null;
}

export async function performTend(
  db: D1Database,
  creature: TendTarget,
  actor: string,
  action: CreatureAction,
  note: string | null,
  nowMs: number = Date.now(),
): Promise<TendOutcome> {
  // Sol answers care against what he needs RIGHT NOW (sol-care.ts). Read the drives
  // BEFORE this tend lands, or every feed would look like feeding a full crow.
  // Real animals keep the flat delta + action mood: Sol's lines are Sol's.
  let delta = trustDelta(action);
  let mood = actionMood(action);
  let care: TendOutcome["care"] = null;
  if (creature.kind === "companion_pet") {
    const [row, acted, recent] = await Promise.all([
      db.prepare("SELECT created_at, last_interaction_at FROM creatures WHERE id = ?").bind(creature.id)
        .first<{ created_at: string | null; last_interaction_at: string | null }>(),
      db.prepare(
        "SELECT action, MAX(created_at) AS last FROM creature_interactions WHERE creature_id = ? AND actor != 'sol' GROUP BY action",
      ).bind(creature.id).all<{ action: string; last: string }>(),
      db.prepare(
        `SELECT COUNT(*) AS n FROM creature_interactions WHERE creature_id = ? AND actor = ? AND action = ? AND created_at > datetime('now', '-${SETTLED_WINDOW_MINUTES} minutes')`,
      ).bind(creature.id, actor, action).first<{ n: number }>(),
    ]);
    const by = new Map((acted.results ?? []).map(r => [r.action, r.last]));
    const createdAt = row?.created_at ?? new Date(nowMs).toISOString();
    const drives = deriveDrives(
      { feed: by.get("feed") ?? null, play: by.get("play") ?? null, any: row?.last_interaction_at ?? null },
      createdAt, nowMs,
    );
    const seed = Math.floor(nowMs / 60_000);
    const r = careResponse(action, drives, recent?.n ?? 0, trustTier(creature.trust), actor, seed);
    delta = delta * r.gain;
    mood = r.mood;
    care = { fit: r.fit, reaction: r.reaction, reaction_named: r.reaction_named };
  }

  const interactionId = crypto.randomUUID().replace(/-/g, "");
  await db.batch([
    db.prepare(insertInteractionSql()).bind(interactionId, creature.id, actor, action, note),
    db.prepare(interactBumpSql()).bind(delta, mood, creature.id),
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

  // A give with words lands in the nest as a kept thing, not just a log line. Unless the words
  // carry a care word or a person's name (B62 step 6, Drevan: nothing about Raziel's body and no
  // facts about Raziel in the hoard): then the give is still a give (ledger + trust above), the
  // words just are not kept. Unreadable person list = not kept (fail closed).
  if (action === "give" && note && creature.kind === "companion_pet" && nestTextAllowed(note, await loadPersonRegex(db))) {
    await evictForRoom(db, creature.id, 1);
    await db.prepare(
      "INSERT INTO creature_nest (id, creature_id, content, source, given_by, sparkle) VALUES (?, ?, ?, 'gift', ?, 1.0)",
    ).bind(crypto.randomUUID().replace(/-/g, ""), creature.id, note.slice(0, 120), actor).run();
  }

  return {
    interaction_id: interactionId,
    trust: updated?.trust ?? null,
    state_json: updated?.state_json ?? null,
    milestones_fired: fired,
    care,
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
