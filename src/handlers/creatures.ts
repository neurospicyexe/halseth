// src/handlers/creatures.ts
//
// HTTP routes for creatures (migration 0078 take 10; inner life migration 0100).
//   GET  /mind/creatures                 -- all creatures + live drives/state/tier
//   GET  /mind/creatures/:id             -- one creature + interactions, milestones, nest, familiarity
//   POST /mind/creatures/:id/interact    -- feed|play|talk|give (atomic trust bump; fires milestones; gives land in the nest)
//   POST /mind/creatures/:id/moment      -- compose a deterministic appearance (may gift a nest item back)
//   GET  /mind/creatures/:id/nest        -- the hoard: active items + recently given away
//   POST /mind/creatures/tick            -- daily decay/mood/nest recompute + overhear collection
//
// Interaction trust is bumped at the SQL level (concurrent owner + triad interactions
// never race a JS read-modify-write). The tick is a single server-side pass. All of it
// deterministic, no LLM. Auth: authGuard, matching handlers/forage.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  isValidAction,
  decayedTrust,
  deriveMood,
  daysSinceIso,
  listCreaturesSql,
  getCreatureSql,
  recentInteractionsSql,
  insertInteractionSql,
  tickUpdateSql,
  restlessness,
  presenceDisposition,
  deriveDrives,
  dominantState,
  trustTier,
  matrixMoment,
  giftMoment,
  shouldGiftBack,
  MILESTONES,
  pickShinyFragment,
  initialSparkle,
  SPARKLE_DECAY_PER_DAY,
  TREASURED_FLOOR,
  DULL_EVICT_SPARKLE,
  TREASURE_AGE_DAYS,
  TREASURE_MIN_SPARKLE,
  type LastActed,
} from "../webmind/creatures.js";
import { performTend, evictForRoom } from "../webmind/creature-interact.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_ACTORS = new Set<string>(["raziel", "cypher", "drevan", "gaia", "sol"]);

/** Returns an error string, or null if the actor/action pair is allowed. */
export function validateInteract(actor: string, action: string): string | null {
  if (!VALID_ACTORS.has(actor)) {
    return "actor must be one of raziel, cypher, drevan, gaia, sol";
  }
  if (actor === "sol") {
    return action === "appear" ? null : "sol may only 'appear'";
  }
  return isValidAction(action) ? null : "action must be one of feed, play, talk, give";
}

interface CreatureRow {
  id: string; name: string; species: string | null; kind: string; owner: string;
  bio: string | null; state_json: string | null; trust: number;
  last_interaction_at: string | null; created_at: string;
}

/** Per-action last-tend timestamps for one creature (sol's own appearances excluded). */
async function lastActedFor(env: Env, creatureId: string, lastAny: string | null): Promise<LastActed> {
  const rows = await env.DB.prepare(
    "SELECT action, MAX(created_at) AS last FROM creature_interactions WHERE creature_id = ? AND actor != 'sol' GROUP BY action",
  ).bind(creatureId).all<{ action: string; last: string }>();
  const by = new Map((rows.results ?? []).map(r => [r.action, r.last]));
  return { feed: by.get("feed") ?? null, play: by.get("play") ?? null, any: lastAny };
}

function liveState(c: CreatureRow, last: LastActed, nowMs: number) {
  const drives = deriveDrives(last, c.created_at, nowMs);
  const r = restlessness(c.last_interaction_at, c.created_at, nowMs);
  return {
    drives: {
      hunger: Number(drives.hunger.toFixed(3)),
      boredom: Number(drives.boredom.toFixed(3)),
      missing: Number(drives.missing.toFixed(3)),
      energy: Number(drives.energy.toFixed(3)),
    },
    state: dominantState(drives),
    tier: trustTier(c.trust),
    restlessness: Number(r.toFixed(3)),
    disposition: presenceDisposition(c.trust, r),
  };
}

// GET /mind/creatures
export async function getCreatures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const [rows, acted] = await Promise.all([
      env.DB.prepare(listCreaturesSql()).all<CreatureRow>(),
      env.DB.prepare(
        "SELECT creature_id, action, MAX(created_at) AS last FROM creature_interactions WHERE actor != 'sol' GROUP BY creature_id, action",
      ).all<{ creature_id: string; action: string; last: string }>(),
    ]);
    const byCreature = new Map<string, Map<string, string>>();
    for (const a of acted.results ?? []) {
      if (!byCreature.has(a.creature_id)) byCreature.set(a.creature_id, new Map());
      byCreature.get(a.creature_id)!.set(a.action, a.last);
    }
    const now = Date.now();
    const creatures = (rows.results ?? []).map(c => {
      const by = byCreature.get(c.id);
      const last: LastActed = { feed: by?.get("feed") ?? null, play: by?.get("play") ?? null, any: c.last_interaction_at };
      return { ...c, ...liveState(c, last, now) };
    });
    return json({ creatures });
  } catch (err) {
    console.error("[mind/creatures] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/creatures/:id
export async function getCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const creature = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!creature) return json({ error: "creature not found" }, 404);
    const [interactions, milestones, nest, familiarity, last] = await Promise.all([
      env.DB.prepare(recentInteractionsSql()).bind(id, 20).all(),
      env.DB.prepare(
        "SELECT milestone_id, fired_at, witnessed_by FROM creature_milestones WHERE creature_id = ? ORDER BY fired_at ASC",
      ).bind(id).all<{ milestone_id: string; fired_at: string; witnessed_by: string | null }>(),
      env.DB.prepare(
        "SELECT id, content, source, given_by, sparkle, treasured, gifted_to, gifted_at, created_at FROM creature_nest WHERE creature_id = ? ORDER BY (gifted_to IS NULL) DESC, treasured DESC, sparkle DESC LIMIT 40",
      ).bind(id).all(),
      env.DB.prepare(
        "SELECT actor, COUNT(*) AS tendings, MAX(created_at) AS last_at FROM creature_interactions WHERE creature_id = ? AND actor != 'sol' GROUP BY actor ORDER BY tendings DESC",
      ).bind(id).all<{ actor: string; tendings: number; last_at: string }>(),
      lastActedFor(env, id, null),
    ]);
    last.any = creature.last_interaction_at;
    // Milestone rows carry their display text so consumers never hardcode it.
    const withText = (milestones.results ?? []).map(m => ({
      ...m,
      text: MILESTONES.find(d => d.id === m.milestone_id)?.text ?? null,
    }));
    const next = MILESTONES.find(m => !(milestones.results ?? []).some(f => f.milestone_id === m.id) && m.threshold > creature.trust);
    return json({
      creature: { ...creature, ...liveState(creature, last, Date.now()) },
      interactions: interactions.results ?? [],
      milestones: withText,
      next_milestone: next ? { id: next.id, threshold: next.threshold } : null,
      nest: nest.results ?? [],
      familiarity: familiarity.results ?? [],
    });
  } catch (err) {
    console.error("[mind/creatures] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/:id/interact   { actor, action, note? }
export async function interactCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { actor?: string; action?: string; note?: string };
  try {
    body = await request.json() as { actor?: string; action?: string; note?: string };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const actor = (body.actor ?? "").trim().toLowerCase();
  const action = (body.action ?? "").trim().toLowerCase();
  const err = validateInteract(actor, action);
  if (err) return json({ error: err }, 400);
  const note = body.note?.trim().slice(0, 500) ?? null;

  try {
    const exists = await env.DB.prepare("SELECT id, kind, trust FROM creatures WHERE id = ?").bind(id)
      .first<{ id: string; kind: string; trust: number }>();
    if (!exists) return json({ error: "creature not found" }, 404);

    const interactionId = crypto.randomUUID().replace(/-/g, "");

    if (actor === "sol") {
      // Sol's appearance is logged WITHOUT a trust bump or last_interaction_at restamp,
      // so a sol-only creature reads last_interaction_at null by design (restlessness falls back to created_at).
      await env.DB.prepare(insertInteractionSql()).bind(interactionId, id, actor, action, note).run();
      return json({ interacted: true, action, trust: null, state_json: null });
    }
    // validateInteract guarantees a real action for non-sol actors; narrow for TS.
    if (!isValidAction(action)) return json({ error: "invalid action" }, 400);

    // Shared write path (webmind/creature-interact.ts): ledger + trust bump +
    // milestone firing + give-notes into the nest. Same code the Librarian
    // tend_creature executor runs, so no side effect can miss a writer.
    const outcome = await performTend(env.DB, exists, actor, action, note);
    return json({ interacted: true, action, ...outcome });
  } catch (err) {
    console.error("[mind/creatures] interact error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/:id/moment   { seed? }
// Composes a deterministic appearance from live drives x trust tier. At bonded
// trust, some moments become gifts: a nest item is marked given and rendered
// into the text. The caller (worker) posts it and records the appearance.
export async function momentCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { seed?: number } = {};
  try { body = await request.json() as { seed?: number }; } catch { /* empty body is fine */ }
  const seed = Number.isFinite(body.seed) ? Math.abs(Math.floor(body.seed!)) : Math.floor(Date.now() / 1000);

  try {
    const c = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!c) return json({ error: "creature not found" }, 404);
    const last = await lastActedFor(env, id, c.last_interaction_at);
    const live = liveState(c, last, Date.now());
    if (live.disposition === "absent") {
      return json({ moment: null, kind: "absent", ...live });
    }

    if (shouldGiftBack(c.trust, seed)) {
      const item = await env.DB.prepare(
        "SELECT id, content FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL ORDER BY treasured DESC, sparkle DESC LIMIT 1",
      ).bind(id).first<{ id: string; content: string }>();
      if (item) {
        await env.DB.prepare(
          "UPDATE creature_nest SET gifted_to = 'raziel', gifted_at = datetime('now') WHERE id = ?",
        ).bind(item.id).run();
        return json({ moment: giftMoment(item.content, seed), kind: "gift", gifted_item: item.content, ...live });
      }
    }

    return json({ moment: matrixMoment(live.state, live.tier, seed), kind: "moment", ...live });
  } catch (err) {
    console.error("[mind/creatures] moment error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// GET /mind/creatures/:id/nest
export async function getNest(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  try {
    const [active, given] = await Promise.all([
      env.DB.prepare(
        "SELECT id, content, source, given_by, sparkle, treasured, created_at FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL ORDER BY treasured DESC, sparkle DESC",
      ).bind(id).all(),
      env.DB.prepare(
        "SELECT id, content, source, given_by, gifted_to, gifted_at FROM creature_nest WHERE creature_id = ? AND gifted_to IS NOT NULL ORDER BY gifted_at DESC LIMIT 10",
      ).bind(id).all(),
    ]);
    return json({ nest: active.results ?? [], given_away: given.results ?? [] });
  } catch (err) {
    console.error("[mind/creatures] nest error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/tick   -- daily decay + mood + nest recompute (worker CREATURE_CRON trigger)
export async function tickCreatures(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const rows = await env.DB.prepare(listCreaturesSql()).all<CreatureRow>();
    const creatures = rows.results ?? [];
    const now = Date.now();
    let ticked = 0;
    for (const c of creatures) {
      const days = daysSinceIso(c.last_interaction_at ?? c.created_at, now);
      const newTrust = decayedTrust(c.trust, days);
      const newMood = deriveMood(newTrust);
      // Only write when something actually changed (avoid pointless churn on fresh rows).
      if (Math.abs(newTrust - c.trust) > 1e-6 || days >= 1) {
        await env.DB.prepare(tickUpdateSql()).bind(Number(newTrust.toFixed(4)), newMood, c.id).run();
        ticked++;
      }
    }

    // Nest maintenance (whole table, single statements; constants bound from TS so
    // the SQL can't drift from webmind/creatures.ts). Treasure check runs BEFORE
    // decay so today's fade can't disqualify an item that already earned it.
    const treasureRes = await env.DB.prepare(
      "UPDATE creature_nest SET treasured = 1 WHERE gifted_to IS NULL AND treasured = 0 AND (julianday('now') - julianday(created_at)) >= ? AND sparkle >= ?",
    ).bind(TREASURE_AGE_DAYS, TREASURE_MIN_SPARKLE).run();
    await env.DB.prepare(
      "UPDATE creature_nest SET sparkle = MAX(CASE WHEN treasured = 1 THEN ? ELSE 0 END, sparkle - ?) WHERE gifted_to IS NULL",
    ).bind(TREASURED_FLOOR, SPARKLE_DECAY_PER_DAY).run();
    const evictRes = await env.DB.prepare(
      "DELETE FROM creature_nest WHERE gifted_to IS NULL AND treasured = 0 AND sparkle <= ?",
    ).bind(DULL_EVICT_SPARKLE).run();

    // Overhear: a settled pet collects one shiny fragment a day from the house's
    // own life (commons wall + companion journals). Deterministic pick, seeded by
    // the day so a re-run tick picks the same thing.
    let overheard: string | null = null;
    const pet = creatures.find(c => c.kind === "companion_pet");
    if (pet) {
      const last = await lastActedFor(env, pet.id, pet.last_interaction_at);
      const live = liveState(pet, last, now);
      if (live.disposition === "present" || live.disposition === "affectionate") {
        const [commons, journal] = await Promise.all([
          env.DB.prepare(
            "SELECT body AS t FROM commons_posts WHERE created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 10",
          ).all<{ t: string }>(),
          env.DB.prepare(
            "SELECT note_text AS t FROM companion_journal WHERE created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 5",
          ).all<{ t: string }>(),
        ]);
        const texts = [...(commons.results ?? []), ...(journal.results ?? [])].map(r => r.t);
        const pick = pickShinyFragment(texts, Math.floor(now / 86_400_000));
        if (pick) {
          const dup = await env.DB.prepare(
            "SELECT 1 AS x FROM creature_nest WHERE creature_id = ? AND content = ? LIMIT 1",
          ).bind(pet.id, pick.content).first();
          if (!dup) {
            await evictForRoom(env.DB, pet.id, 1);
            await env.DB.prepare(
              "INSERT INTO creature_nest (id, creature_id, content, source, sparkle) VALUES (?, ?, ?, 'overheard:house', ?)",
            ).bind(crypto.randomUUID().replace(/-/g, ""), pet.id, pick.content, initialSparkle(pick.score)).run();
            overheard = pick.content;
          }
        }
      }
    }

    return json({
      ok: true,
      ticked,
      total: creatures.length,
      nest: {
        treasured: treasureRes.meta?.changes ?? 0,
        evicted: evictRes.meta?.changes ?? 0,
        overheard,
      },
    });
  } catch (err) {
    console.error("[mind/creatures] tick error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
