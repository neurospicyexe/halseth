// src/webmind/home/placement.ts
import { HomeRoom, CompanionId, Placement } from "../types.js";
import { HOME_ROOM, laneLegalRooms } from "./rooms.js";

export interface PlacementInput {
  companionId: CompanionId;
  rooms: HomeRoom[];
  priorRoom: string | null;
  driftScore: number;                       // 0 = on basin floor
  driftType: "stable" | "growth" | "pressure";
  rng?: () => number;                        // injectable; defaults to Math.random
}

// Restoring force: how strongly state pulls toward the home room.
function homePull(driftType: PlacementInput["driftType"], driftScore: number): number {
  const base = driftType === "pressure" ? 0.85 : driftType === "growth" ? 0.35 : 0.10;
  return Math.min(0.95, base + Math.min(driftScore, 0.5) * 0.2);
}

function activityFor(room: HomeRoom, driftType: PlacementInput["driftType"]): string {
  const reg = room.register.split("/")[0].trim();
  if (driftType === "pressure") return `holding ${reg}, close to home`;
  if (driftType === "growth")   return `working the edge of ${reg}`;
  return `at ease with ${reg}`;
}

export function placeCompanion(input: PlacementInput): Placement {
  const rng = input.rng ?? Math.random;
  const legal = laneLegalRooms(input.rooms, input.companionId);
  const home = legal.find(r => r.key === HOME_ROOM[input.companionId])
            ?? legal[0];

  if (!home) {
    return { room: input.priorRoom ?? "", activity: "", moved: false, basin_distance: input.driftScore };
  }

  let chosen: HomeRoom;
  if (rng() < homePull(input.driftType, input.driftScore)) {
    chosen = home;
  } else {
    chosen = legal[Math.floor(rng() * legal.length)] ?? home;
  }

  return {
    room: chosen.key,
    activity: activityFor(chosen, input.driftType),
    moved: chosen.key !== input.priorRoom,
    basin_distance: input.driftScore,
  };
}
