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
  interactBumpSql,
  crossedMilestones,
  deriveDrives,
  trustTier,
  tierGroup,
  NEST_CAP,
} from "./creatures.js";
import { careResponse, renderCare, tenderName, SETTLED_WINDOW_MINUTES, type CareFit } from "./sol-care.js";
import { appraise, resolveVia, type Via } from "../pets/appraise.js";
import {
  stepGrudge, expired, grudgeProgress, sulkLine, makeUpLine, type GrudgeStep, type OpenGrudge,
} from "../pets/grudge.js";
import {
  loadActiveQuirks, loadOpenGrudge, writeAppraisal, applyGrudgeStep, type LoadedQuirk,
} from "../pets/store.js";
import { INSERT_INTERACTION_VIA } from "../pets/sql.js";
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
  /**
   * Sol's grudge toward THIS tender, when one was involved in this tend (B64): opened, progressed,
   * resolved, or simply still open ("none"). Null when no grudge touched the tend (and for real animals).
   */
  grudge: { label: string; progress: number; of: number; step: "open" | "progress" | "resolve" | "none" } | null;
  /** The creature_appraisals row this tend wrote (companion_pet only). */
  appraisal_id: string | null;
}

export async function performTend(
  db: D1Database,
  creature: TendTarget,
  actor: string,
  action: CreatureAction,
  note: string | null,
  nowMs: number = Date.now(),
  via?: Via,
): Promise<TendOutcome> {
  // Unknown callers default to autonomous (under-weights, never over-weights): never assume hand.
  const resolvedVia: Via = via ?? resolveVia(undefined, actor);
  const interactionId = crypto.randomUUID().replace(/-/g, "");
  const extra: D1PreparedStatement[] = [];
  let grudge: TendOutcome["grudge"] = null;
  let appraisalId: string | null = null;
  // Sol answers care against what he needs RIGHT NOW (sol-care.ts). Read the drives
  // BEFORE this tend lands, or every feed would look like feeding a full crow.
  // Real animals keep the flat delta + action mood: Sol's lines are Sol's.
  let delta = trustDelta(action);
  let mood = actionMood(action);
  let care: TendOutcome["care"] = null;
  if (creature.kind === "companion_pet") {
    const [row, acted, recent, quirks, loadedOpen] = await Promise.all([
      db.prepare("SELECT created_at, last_interaction_at FROM creatures WHERE id = ?").bind(creature.id)
        .first<{ created_at: string | null; last_interaction_at: string | null }>(),
      db.prepare(
        "SELECT action, MAX(created_at) AS last FROM creature_interactions WHERE creature_id = ? AND actor != 'sol' GROUP BY action",
      ).bind(creature.id).all<{ action: string; last: string }>(),
      db.prepare(
        `SELECT COUNT(*) AS n FROM creature_interactions WHERE creature_id = ? AND actor = ? AND action = ? AND created_at > datetime('now', '-${SETTLED_WINDOW_MINUTES} minutes')`,
      ).bind(creature.id, actor, action).first<{ n: number }>(),
      loadActiveQuirks(db, creature.id),
      loadOpenGrudge(db, creature.id, actor),
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

    // Appraisal: deterministic, closed tags, never reads the note (B64 5.2).
    const ap = appraise({
      actor, action, fit: r.fit, via: resolvedVia, nowMs, quirks, recentSame: recent?.n ?? 0,
    });
    appraisalId = crypto.randomUUID().replace(/-/g, "");
    extra.push(writeAppraisal(db, {
      id: appraisalId, creature_id: creature.id, interaction_id: interactionId, actor, action, via: resolvedVia,
      fit: r.fit, valence: ap.valence, arousal: ap.arousal, friction: ap.friction, tags: ap.tags,
      weight: ap.weight, source: "live", created_at: new Date(nowMs).toISOString(),
    }));

    // Grudge (B64 5.5). An expired one resolves FIRST (time), then this tend is read as if none were
    // open, so it may open a fresh one. The resolve UPDATE precedes any INSERT in the batch, or the
    // one-open index would reject the insert and roll the whole tend back.
    let open: OpenGrudge | null = loadedOpen;
    let expiredOld: OpenGrudge | null = null;
    if (open && expired(open, nowMs)) {
      extra.push(...applyGrudgeStep(db, creature.id, actor, open, { kind: "resolve", how: "time" }, nowMs));
      expiredOld = open;
      open = null;
    }
    const aversion = (ap.matched.find(q => q.kind === "aversion") ?? null) as LoadedQuirk | null;
    const step: GrudgeStep = stepGrudge(open, {
      actor, action, friction: ap.friction, matchedAversion: aversion,
      quirkTitle: aversion?.title ?? null, quirkResolution: aversion?.resolution ?? null, nowMs,
    });
    extra.push(...applyGrudgeStep(db, creature.id, actor, open, step, nowMs));

    // Only the reaction text changes; delta (trust gain) is untouched by anything below (R7).
    const group = tierGroup(trustTier(creature.trust));
    let line: string | null = null;
    if (step.kind === "open") {
      const shown: OpenGrudge = {
        id: "", quirk_id: step.quirk_id, actor, label: step.label, resolution: step.resolution,
        progress: 0, opened_at: new Date(nowMs).toISOString(),
      };
      grudge = { label: step.label, ...grudgeProgress(shown, nowMs), step: "open" };
      line = sulkLine(group, seed);
    } else if (open && step.kind === "progress") {
      grudge = { label: open.label, ...grudgeProgress({ ...open, progress: step.progress }, nowMs), step: "progress" };
      line = sulkLine(group, seed);
    } else if (open && step.kind === "resolve") {
      const r0 = open.resolution;
      const done = step.how === "met" && (r0.kind === "visits" || r0.kind === "item") ? { ...open, progress: r0.n } : open;
      grudge = { label: open.label, ...grudgeProgress(done, nowMs), step: "resolve" };
      if (step.how === "met") line = makeUpLine(seed);
    } else if (open) {
      grudge = { label: open.label, ...grudgeProgress(open, nowMs), step: "none" };
      line = sulkLine(group, seed);
    } else if (expiredOld) {
      // Resolved by the clock on this tend: the end is shown, the normal care line stays.
      grudge = { label: expiredOld.label, ...grudgeProgress(expiredOld, nowMs), step: "resolve" };
    }
    if (line) care = { fit: r.fit, reaction: renderCare(line, "you"), reaction_named: renderCare(line, tenderName(actor)) };
  }

  await db.batch([
    db.prepare(INSERT_INTERACTION_VIA).bind(interactionId, creature.id, actor, action, note, resolvedVia),
    db.prepare(interactBumpSql()).bind(delta, mood, creature.id),
    ...extra,
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
    grudge,
    appraisal_id: appraisalId,
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
