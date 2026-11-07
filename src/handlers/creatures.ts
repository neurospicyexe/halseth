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
import { fireTendSol } from "../webmind/loop-stimuli.js";
import { KEPT_LIVE_SQL } from "../webmind/review-state.js";
import {
  hoardSkipReason,
  hoardReaction,
  nestTextAllowed,
  startingSparkle,
  favouriteOf,
  SOL_LIKES,
  HOARD_LOOKBACK_HOURS,
  HOARD_REACTIONS_PER_DAY,
  HOARD_BATCH,
  type HoardCandidate,
} from "../webmind/sol-hoard.js";
import { loadPersonRegex } from "../webmind/sol-hoard-people.js";
import { resolveVia, VIA_WEIGHT } from "../pets/appraise.js";
import { expired, grudgeProgress } from "../pets/grudge.js";
import { loadOpenGrudges, writeAppraisal } from "../pets/store.js";
import { halsethPetModel, hasPetModel, type PetModel } from "../pets/model.js";
import { notRun, runSleepPass, SLEEP_TEMPERATURE, type SleepResult } from "../pets/sleep.js";
import { INSERT_INTERACTION_VIA, SELECT_TRAITS_FORMING, SELECT_VISIBLE_QUIRKS } from "../pets/sql.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

// `imp` (Drevan, 2026-11-03: "Sol gets fed by Iris and tended by Mossling"): an imp on an errand
// tends as ITSELF, never as the companion it serves -- his hard line is that an imp never writes to
// Halseth under his name. One nameless actor: the imp's name is not a voice on the record.
const VALID_ACTORS = new Set<string>(["raziel", "cypher", "drevan", "gaia", "sol", "imp"]);

/** An imp feeds, plays or talks. It never `give`s: a give carries words into the nest, and an imp
 *  authors nothing. */
const IMP_ACTIONS = new Set<string>(["feed", "play", "talk"]);

/** Returns an error string, or null if the actor/action pair is allowed. */
export function validateInteract(actor: string, action: string): string | null {
  if (!VALID_ACTORS.has(actor)) {
    return "actor must be one of raziel, cypher, drevan, gaia, sol, imp";
  }
  if (actor === "sol") {
    return action === "appear" ? null : "sol may only 'appear'";
  }
  if (actor === "imp") {
    return IMP_ACTIONS.has(action) ? null : "an imp may only feed, play or talk (an imp never gives: it authors nothing)";
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
        "SELECT id, content, source, given_by, sparkle, treasured, gifted_to, gifted_at, created_at, ref_type, ref_id FROM creature_nest WHERE creature_id = ? ORDER BY (gifted_to IS NULL) DESC, treasured DESC, sparkle DESC LIMIT 40",
      ).bind(id).all(),
      env.DB.prepare(
        // imp excluded: an errand is not familiarity (Hearth reads [0] as "knows best").
        "SELECT actor, COUNT(*) AS tendings, MAX(created_at) AS last_at FROM creature_interactions WHERE creature_id = ? AND actor NOT IN ('sol','imp') GROUP BY actor ORDER BY tendings DESC",
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
    const mind = creature.kind === "companion_pet" ? await mindView(env.DB, id, Date.now()) : EMPTY_MIND;
    return json({
      creature: { ...creature, ...liveState(creature, last, Date.now()) },
      interactions: interactions.results ?? [],
      milestones: withText,
      next_milestone: next ? { id: next.id, threshold: next.threshold } : null,
      nest: nest.results ?? [],
      familiarity: familiarity.results ?? [],
      ...mind,
    });
  } catch (err) {
    console.error("[mind/creatures] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// B64: what Sol's mind shows on Hearth. Forming traits (top 5 candidates), visible quirks (active +
// softening; retired ones stay in the table as his history), open grudges with legible progress. A grudge
// past its 72h limit is not shown even before a tend resolves it (no grudge outlives 72h).
type MindView = {
  traits_forming: Array<{ slug: string; category: string | null; entrenchment: number }>;
  quirks: Array<{ title: string; behavior: string | null; status: string }>;
  grudge: { actor: string; label: string; progress: number; of: number } | null;
  grudges: Array<{ actor: string; label: string; progress: number; of: number }>;
};
const EMPTY_MIND: MindView = { traits_forming: [], quirks: [], grudge: null, grudges: [] };

async function mindView(db: D1Database, creatureId: string, nowMs: number): Promise<MindView> {
  const [traits, quirks, open] = await Promise.all([
    db.prepare(SELECT_TRAITS_FORMING).bind(creatureId).all<{ slug: string; category: string | null; entrenchment: number }>(),
    db.prepare(SELECT_VISIBLE_QUIRKS).bind(creatureId).all<{ title: string; behavior: string | null; status: string }>(),
    loadOpenGrudges(db, creatureId),
  ]);
  const grudges = open
    .filter(g => !expired(g, nowMs))
    .map(g => ({ actor: g.actor, label: g.label, ...grudgeProgress(g, nowMs) }));
  return {
    traits_forming: (traits.results ?? []).map(t => ({ slug: t.slug, category: t.category, entrenchment: t.entrenchment })),
    quirks: (quirks.results ?? []).map(q => ({ title: q.title, behavior: q.behavior, status: q.status })),
    grudge: grudges[0] ?? null,
    grudges,
  };
}

// POST /mind/creatures/:id/interact   { actor, action, note?, via? }
export async function interactCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);

  let body: { actor?: string; action?: string; note?: string; via?: unknown };
  try {
    body = await request.json() as { actor?: string; action?: string; note?: string; via?: unknown };
  } catch {
    return json({ error: "invalid JSON body" }, 400);
  }
  const actor = (body.actor ?? "").trim().toLowerCase();
  const action = (body.action ?? "").trim().toLowerCase();
  const err = validateInteract(actor, action);
  if (err) return json({ error: err }, 400);
  const note = body.note?.trim().slice(0, 500) ?? null;
  // An unknown or missing via is autonomous (sol = appear, imp = imp), never hand (B64 5.1).
  const via = resolveVia(body.via, actor);

  try {
    const exists = await env.DB.prepare("SELECT id, kind, trust FROM creatures WHERE id = ?").bind(id)
      .first<{ id: string; kind: string; trust: number }>();
    if (!exists) return json({ error: "creature not found" }, 404);

    const interactionId = crypto.randomUUID().replace(/-/g, "");

    if (actor === "sol") {
      // Sol's appearance is logged WITHOUT a trust bump or last_interaction_at restamp,
      // so a sol-only creature reads last_interaction_at null by design (restlessness falls back to created_at).
      await env.DB.prepare(INSERT_INTERACTION_VIA).bind(interactionId, id, actor, action, note, via).run();
      return json({ interacted: true, action, trust: null, state_json: null });
    }
    // validateInteract guarantees a real action for non-sol actors; narrow for TS.
    if (!isValidAction(action)) return json({ error: "invalid action" }, 400);

    // Shared write path (webmind/creature-interact.ts): ledger + trust bump +
    // milestone firing + give-notes into the nest. Same code the Librarian
    // tend_creature executor runs, so no side effect can miss a writer.
    const outcome = await performTend(env.DB, exists, actor, action, note, Date.now(), via);
    await fireTendSol(env, exists.kind, actor, action);
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
        // A hoarded make is the triad's, never carried to Raziel (Drevan: Sol never couriers).
        "SELECT id, content FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL AND ref_id IS NULL ORDER BY treasured DESC, sparkle DESC LIMIT 1",
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
        "SELECT id, content, source, given_by, sparkle, treasured, created_at, ref_type, ref_id FROM creature_nest WHERE creature_id = ? AND gifted_to IS NULL ORDER BY treasured DESC, sparkle DESC",
      ).bind(id).all<{ id: string; content: string; source: string; given_by: string | null; sparkle: number; treasured: number; created_at: string; ref_type: string | null; ref_id: string | null }>(),
      env.DB.prepare(
        "SELECT id, content, source, given_by, gifted_to, gifted_at FROM creature_nest WHERE creature_id = ? AND gifted_to IS NOT NULL ORDER BY gifted_at DESC LIMIT 10",
      ).bind(id).all(),
    ]);
    const items = active.results ?? [];
    const fav = favouriteOf(items);
    return json({
      nest: items,
      given_away: given.results ?? [],
      // Sol's own taste (B62 step 6): what he is drawn to, and the one make he prefers.
      likes: SOL_LIKES,
      favourite: fav ? { nest_id: fav.id, make_id: fav.ref_id, title: fav.content, maker: fav.given_by } : null,
    });
  } catch (err) {
    console.error("[mind/creatures] nest error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// POST /mind/creatures/tick   -- daily decay + mood + nest recompute (worker CREATURE_CRON trigger)
export async function tickCreatures(request: Request, env: Env, deps: { petModel?: PetModel } = {}): Promise<Response> {
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
            // Raziel's own wall posts are never Sol's to overhear (B62 step 6, Drevan: no facts
            // about Raziel in the hoard). Only the triad's lines.
            "SELECT body AS t FROM commons_posts WHERE author != 'raziel' AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 10",
          ).all<{ t: string }>(),
          env.DB.prepare(
            // KEPT_LIVE_SQL (tray pass 2): the nest fragment is quoted back to the house as something
            // a companion said; a draft or a retracted line must not become Sol's hoard.
            `SELECT note_text AS t FROM companion_journal WHERE ${KEPT_LIVE_SQL} AND created_at >= datetime('now', '-3 days') ORDER BY created_at DESC LIMIT 5`,
          ).all<{ t: string }>(),
        ]);
        // A line with a care word or a person's name is dropped whole, before any word is picked
        // from it: a fragment out of a line about Raziel is still about Raziel.
        const people = await loadPersonRegex(env.DB);
        const texts = [...(commons.results ?? []), ...(journal.results ?? [])].map(r => r.t)
          .filter(t => nestTextAllowed(t, people));
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

    // B64 sleep pass (spec 5.3): per companion_pet, after the day's maintenance. Never fails the tick and
    // never touches trust. One pet today, so `sleep` is that pet's result; every pet's is in sleep_all.
    const sleepAll: Array<SleepResult & { creature_id: string }> = [];
    for (const c of creatures) {
      if (c.kind !== "companion_pet") continue;
      let r: SleepResult;
      try {
        const model = deps.petModel ?? (hasPetModel(env) ? halsethPetModel(env, SLEEP_TEMPERATURE) : null);
        r = model ? await runSleepPass(env, c.id, model, now) : notRun("no_model");
        if (!model) console.log("[pets/sleep] skipped no_model");
      } catch (err) {
        console.log(`[pets/sleep] skipped error: ${String(err).slice(0, 200)}`);
        r = notRun("error");
      }
      sleepAll.push({ creature_id: c.id, ...r });
    }

    return json({
      ok: true,
      ticked,
      total: creatures.length,
      sleep: sleepAll[0] ?? null,
      sleep_all: sleepAll,
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

// POST /mind/creatures/:id/hoard   { seed? }   (B62 step 6, mig 0166; worker SOL_HOARD pass)
//
// Sol looks over the triad's new makes (ready, last HOARD_LOOKBACK_HOURS, not yet seen) and keeps
// the ones he may: a REFERENCE row in the nest, content = the title, sparkle from his taste for the
// kind. Every make he looks at is recorded in creature_hoard_seen (hoarded or skipped, with why), so
// nothing is looked at twice. At most one channel reaction is composed per call, and at most
// HOARD_REACTIONS_PER_DAY per UTC day; past that he still hoards, quietly. Away (absent) Sol hoards
// nothing and leaves the makes for later. The reaction text is composed here (one author), the
// worker only posts it.
export async function hoardCreature(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  let body: { seed?: number; via?: unknown } = {};
  try { body = await request.json() as { seed?: number; via?: unknown }; } catch { /* empty body is fine */ }
  // Sol looking at a make is not a hand tend: autonomous unless the caller names a valid via.
  const via = resolveVia(body.via, "");
  const seed = Number.isFinite(body.seed) ? Math.abs(Math.floor(body.seed!)) : Math.floor(Date.now() / 1000);

  try {
    const c = await env.DB.prepare(getCreatureSql()).bind(id).first<CreatureRow>();
    if (!c) return json({ error: "creature not found" }, 404);
    if (c.kind !== "companion_pet") return json({ error: "only a companion pet keeps a hoard" }, 400);
    const last = await lastActedFor(env, id, c.last_interaction_at);
    const live = liveState(c, last, Date.now());
    if (live.disposition === "absent") {
      return json({ hoarded: [], skipped: [], moment: null, reason: "away", disposition: live.disposition });
    }

    const fresh = await env.DB.prepare(
      `SELECT m.id, m.companion_id, m.kind, m.title FROM companion_makes m
        WHERE m.status = 'ready' AND m.created_at >= datetime('now', ?)
          AND NOT EXISTS (SELECT 1 FROM creature_hoard_seen s WHERE s.creature_id = ? AND s.ref_id = m.id)
        ORDER BY m.created_at ASC LIMIT ?`,
    ).bind(`-${HOARD_LOOKBACK_HOURS} hours`, id, HOARD_BATCH).all<HoardCandidate>();
    const makes = fresh.results ?? [];
    if (makes.length === 0) return json({ hoarded: [], skipped: [], moment: null, reason: "nothing_new", disposition: live.disposition });

    const people = await loadPersonRegex(env.DB);
    if (people === undefined) {
      // Fail closed and record nothing: the makes stay unseen and the next pass tries again.
      return json({ hoarded: [], skipped: [], moment: null, reason: "people_unreadable", disposition: live.disposition });
    }

    const reactedToday = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM creature_hoard_seen WHERE creature_id = ? AND reacted = 1 AND seen_at >= date('now')",
    ).bind(id).first<{ n: number }>();
    let reactionsLeft = Math.max(0, HOARD_REACTIONS_PER_DAY - (reactedToday?.n ?? 0));

    const hoarded: Array<{ make_id: string; companion_id: string; kind: string; title: string }> = [];
    const skipped: Array<{ make_id: string; reason: string }> = [];
    let moment: string | null = null;
    let reactedTo: string | null = null;

    for (const m of makes) {
      const skip = hoardSkipReason(m, people);
      if (skip) {
        await env.DB.prepare(
          "INSERT OR IGNORE INTO creature_hoard_seen (creature_id, ref_id, outcome, reason) VALUES (?, ?, 'skipped', ?)",
        ).bind(id, m.id, skip).run();
        skipped.push({ make_id: m.id, reason: skip });
        continue;
      }
      // Claim first: only the pass that lands the seen row hoards (two concurrent passes cannot double-keep).
      const react = moment === null && reactionsLeft > 0;
      const claim = await env.DB.prepare(
        "INSERT OR IGNORE INTO creature_hoard_seen (creature_id, ref_id, outcome, reacted) VALUES (?, ?, 'hoarded', ?)",
      ).bind(id, m.id, react ? 1 : 0).run();
      if ((claim.meta?.changes ?? 0) === 0) continue;
      await evictForRoom(env.DB, id, 1);
      await env.DB.prepare(
        "INSERT OR IGNORE INTO creature_nest (id, creature_id, content, source, given_by, sparkle, ref_type, ref_id) VALUES (?, ?, ?, 'make', ?, ?, 'make', ?)",
      ).bind(crypto.randomUUID().replace(/-/g, ""), id, m.title.slice(0, 120), m.companion_id, startingSparkle(m.kind), m.id).run();
      // B64 5.2: a hoarded make is appraised too (actor = maker), so he can grow tastes in things.
      // Closed tags only (the kind, never the title). Keyed per creature+make: idempotent.
      await writeAppraisal(env.DB, {
        id: crypto.randomUUID().replace(/-/g, ""), creature_id: id, interaction_id: `hoard:${id}:${m.id}`,
        actor: m.companion_id, action: "hoard", via, fit: null, valence: 0.3, arousal: 0.3, friction: false,
        tags: [`hoard:${m.kind}`], weight: VIA_WEIGHT[via], source: "live", created_at: new Date().toISOString(),
      }).run();
      hoarded.push({ make_id: m.id, companion_id: m.companion_id, kind: m.kind, title: m.title });
      if (react) {
        moment = hoardReaction(m, seed);
        reactedTo = m.id;
        reactionsLeft--;
      }
    }

    return json({ hoarded, skipped, moment, reacted_to: reactedTo, disposition: live.disposition });
  } catch (err) {
    console.error("[mind/creatures] hoard error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
