// src/webmind/home/tick.ts
import { Env } from "../../types.js";
import { CompanionId, Placement } from "../types.js";
import { getRooms } from "./rooms.js";
import { placeCompanion } from "./placement.js";
import {
  allCompanions, getPresence, upsertPresence, appendEvent,
  latestBasin, getConfig, setConfig, pruneOldEvents,
} from "./store.js";
import {
  shouldFireTexture, recycleTextureProvider, TextureProvider,
} from "./texture.js";

export interface HomeTickDeps {
  only?: CompanionId[];
  rng?: () => number;
  textureProvider?: TextureProvider;
  now?: Date;
}

export async function runHomeTick(
  env: Env, deps: HomeTickDeps = {},
): Promise<Record<string, Placement>> {
  const now = deps.now ?? new Date();
  const rooms = await getRooms(env);
  const targets = deps.only ?? allCompanions();
  const provider = deps.textureProvider ?? recycleTextureProvider;
  const out: Record<string, Placement> = {};

  for (const id of targets) {
    try {
      // --- cadence gate: skip if last tick for this companion was too recent ---
      const cadenceRaw = Number(await getConfig(env, id, "home_tick_cadence_min", "30"));
      const cadenceMin = Number.isFinite(cadenceRaw) ? cadenceRaw : 30;
      const lastTickRaw = await getConfig(env, id, "home_last_tick_at", "");
      if (lastTickRaw) {
        const sinceMin = (now.getTime() - new Date(lastTickRaw).getTime()) / 60000;
        if (sinceMin < cadenceMin) {
          continue; // not yet time for this companion
        }
      }
      await setConfig(env, id, "home_last_tick_at", now.toISOString());

      const prior = await getPresence(env, id);
      const basin = await latestBasin(env, id);

      const placement = placeCompanion({
        companionId: id, rooms, priorRoom: prior?.current_room ?? null,
        driftScore: basin.driftScore, driftType: basin.driftType, rng: deps.rng,
      });

      const driftChanged = (prior?.basin_distance ?? 0).toFixed(2) !== placement.basin_distance.toFixed(2);
      const model = await getConfig(env, id, "home_texture_model", "none");
      const lastTextureRaw = await getConfig(env, id, "home_last_texture_at", "");
      const lastTextureAt = lastTextureRaw || null;
      const minRaw = Number(await getConfig(env, id, "home_texture_min_interval_min", "120"));
      const minInterval = Number.isFinite(minRaw) ? minRaw : 120;

      let activity = placement.activity;
      const room = rooms.find(r => r.key === placement.room);
      if (room && shouldFireTexture({
        moved: placement.moved, encountered: false, driftChanged,
        model, lastTextureAt, minIntervalMin: minInterval, now,
      })) {
        activity = await provider.generate(env, {
          companionId: id, room, activity: placement.activity, driftType: basin.driftType,
        });
        await setConfig(env, id, "home_last_texture_at", now.toISOString());
      }

      await upsertPresence(env, id, placement.room, activity, placement.basin_distance);
      if (placement.moved) {
        await appendEvent(env, id, "move", placement.room, activity);
      }
      out[id] = { ...placement, activity };
    } catch (err) {
      console.error(`home tick failed for ${id}`, err);
    }
  }

  // Rolling-window prune: home_events are ephemeral (spec). Guarded so a prune
  // failure never breaks the tick.
  try {
    await pruneOldEvents(env);
  } catch (err) {
    console.error("home event prune failed", err);
  }

  return out;
}
