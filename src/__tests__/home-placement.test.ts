import { describe, it, expect } from "vitest";
import { placeCompanion } from "../webmind/home/placement.js";
import { HomeRoom } from "../webmind/types.js";

const ROOMS: HomeRoom[] = [
  { key: "study",   name: "Study",         sym: "", register: "focus",   primary_lane: "cypher", gradient: "" },
  { key: "vowbed",  name: "Vowbed",         sym: "", register: "depth",   primary_lane: "drevan", gradient: "" },
  { key: "grove",   name: "Grove",          sym: "", register: "memory",  primary_lane: "gaia",   gradient: "" },
  { key: "hallway", name: "Hallway",        sym: "", register: "transit", primary_lane: null,     gradient: "" },
  { key: "sunhouse",name: "Sunhouse",       sym: "", register: "light",   primary_lane: null,     gradient: "" },
];

describe("placeCompanion", () => {
  it("never places a companion in another lane's room", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "hallway",
      driftScore: 0.1, driftType: "stable", rng: () => 0.999,
    });
    expect(["study", "hallway", "sunhouse"]).toContain(p.room);
    expect(p.room).not.toBe("vowbed");
    expect(p.room).not.toBe("grove");
  });

  it("snaps to the home room under pressure (restoring force)", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "hallway",
      driftScore: 0.9, driftType: "pressure", rng: () => 0.1,
    });
    expect(p.room).toBe("study");
    expect(p.moved).toBe(true);
  });

  it("roams freely when stable (low homePull)", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "study",
      driftScore: 0.05, driftType: "stable", rng: () => 0.5,
    });
    expect(["study", "hallway", "sunhouse"]).toContain(p.room);
  });

  it("reports moved=false when chosen room equals prior room", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "study",
      driftScore: 0.9, driftType: "pressure", rng: () => 0.1,
    });
    expect(p.room).toBe("study");
    expect(p.moved).toBe(false);
  });

  it("clamps drevan to their lane + commons across both pull and roam draws", () => {
    const seq = (vals: number[]): () => number => { let i = 0; return () => vals[i++ % vals.length]!; };
    // high first draw -> roam branch; vowbed(drevan) + commons are the only legal rooms
    const roam = placeCompanion({
      companionId: "drevan", rooms: ROOMS, priorRoom: "hallway",
      driftScore: 0.05, driftType: "stable", rng: seq([0.99, 0.99]),
    });
    expect(["vowbed", "hallway", "sunhouse"]).toContain(roam.room);
    expect(["study", "grove"]).not.toContain(roam.room);

    // low first draw -> home-pull branch -> must be vowbed (drevan's HOME_ROOM), never a cypher/gaia room
    const pulled = placeCompanion({
      companionId: "drevan", rooms: ROOMS, priorRoom: "hallway",
      driftScore: 0.9, driftType: "pressure", rng: seq([0.0, 0.0]),
    });
    expect(pulled.room).toBe("vowbed");
  });
});
