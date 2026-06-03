import { describe, it, expect } from "vitest";
import { placeCompanion } from "../webmind/home/placement.js";
import { HomeRoom } from "../webmind/types.js";

const ROOMS: HomeRoom[] = [
  { key: "office",  name: "Office",  sym: "", register: "audit",   primary_lane: "cypher", gradient: "" },
  { key: "studio",  name: "Studio",  sym: "", register: "build",   primary_lane: "cypher", gradient: "" },
  { key: "kitchen", name: "Kitchen", sym: "", register: "nourish", primary_lane: null,     gradient: "" },
  { key: "bedroom", name: "Bedroom", sym: "", register: "depth",   primary_lane: "drevan", gradient: "" },
];

describe("placeCompanion", () => {
  it("never places a companion in another lane's room", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "kitchen",
      driftScore: 0.1, driftType: "stable", rng: () => 0.999,
    });
    expect(["office", "studio", "kitchen"]).toContain(p.room);
    expect(p.room).not.toBe("bedroom");
  });

  it("snaps to the home room under pressure (restoring force)", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "kitchen",
      driftScore: 0.9, driftType: "pressure", rng: () => 0.1,
    });
    expect(p.room).toBe("office");
    expect(p.moved).toBe(true);
  });

  it("roams freely when stable (low homePull)", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "office",
      driftScore: 0.05, driftType: "stable", rng: () => 0.5,
    });
    expect(["office", "studio", "kitchen"]).toContain(p.room);
  });

  it("reports moved=false when chosen room equals prior room", () => {
    const p = placeCompanion({
      companionId: "cypher", rooms: ROOMS, priorRoom: "office",
      driftScore: 0.9, driftType: "pressure", rng: () => 0.1,
    });
    expect(p.room).toBe("office");
    expect(p.moved).toBe(false);
  });

  it("clamps drevan to their lane + commons across both pull and roam draws", () => {
    // sequential rng: first draw = pull check, second = roam index
    const seq = (vals: number[]) => { let i = 0; return () => vals[i++ % vals.length]; };
    // high first draw -> roam branch; bedroom(drevan)+kitchen(commons) are the only legal rooms
    const roam = placeCompanion({
      companionId: "drevan", rooms: ROOMS, priorRoom: "kitchen",
      driftScore: 0.05, driftType: "stable", rng: seq([0.99, 0.99]),
    });
    expect(["bedroom", "kitchen"]).toContain(roam.room);
    expect(["office", "studio"]).not.toContain(roam.room);

    // low first draw -> home-pull branch -> must be bedroom (drevan's HOME_ROOM), never a cypher room
    const pulled = placeCompanion({
      companionId: "drevan", rooms: ROOMS, priorRoom: "kitchen",
      driftScore: 0.9, driftType: "pressure", rng: seq([0.0, 0.0]),
    });
    expect(pulled.room).toBe("bedroom");
  });
});
