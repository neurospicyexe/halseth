import { describe, it, expect, vi } from "vitest";
import { runHomeTick } from "../webmind/home/tick.js";

type Row = Record<string, unknown>;
function makeStmt(results: Row[]) {
  const stmt: any = {
    bind: () => stmt,
    all: async () => ({ results }),
    first: async () => (results[0] ?? null),
    run: async () => ({ meta: { changes: 1 } }),
  };
  return stmt;
}

function envWith(handler: (sql: string) => any) {
  return { ADMIN_SECRET: "t", DB: { prepare: handler } } as any;
}

describe("runHomeTick", () => {
  it("updates presence with ZERO texture calls on a quiet stable tick", async () => {
    const textureSpy = vi.fn(async () => "should-not-run");
    const env = envWith((sql) => {
      if (sql.includes("FROM home_rooms")) {
        return makeStmt([
          { key: "office", name: "Office", sym: "", register: "audit", primary_lane: "cypher", gradient: "" },
        ]);
      }
      if (sql.includes("FROM home_presence")) return makeStmt([{ companion_id: "cypher", current_room: "office", activity: "x", basin_distance: 0 }]);
      if (sql.includes("FROM companion_basin_history")) return makeStmt([{ drift_score: 0.02, drift_type: "stable" }]);
      if (sql.includes("FROM companion_settings")) return makeStmt([{ value: "none" }]);
      return makeStmt([]); // INSERT/UPDATE
    });

    const res = await runHomeTick(env, {
      only: ["cypher"],
      rng: () => 0.99,
      textureProvider: { generate: textureSpy },
      now: new Date("2026-06-03T12:00:00Z"),
    });

    expect(textureSpy).not.toHaveBeenCalled();
    expect(res.cypher!.room).toBe("office");
  });

  it("fires texture on a move when enabled and interval elapsed, and suppresses within interval", async () => {
    const rooms = [
      { key: "office", name: "Office", sym: "", register: "audit", primary_lane: "cypher", gradient: "" },
      { key: "studio", name: "Studio", sym: "", register: "build", primary_lane: "cypher", gradient: "" },
      { key: "kitchen", name: "Kitchen", sym: "", register: "nourish", primary_lane: null, gradient: "" },
    ];
    const presence = [{ companion_id: "cypher", current_room: "kitchen", activity: "x", basin_distance: 0, updated_at: "2026-06-03T11:59:00Z" }];
    const basin = [{ drift_score: 0.9, drift_type: "pressure" }]; // pressure -> high home pull -> moves to office

    // interval elapsed (last texture long ago) -> fires
    const fired = vi.fn(async () => "lush line");
    const envFire = makeKeyedEnv(
      { home_texture_model: "deepseek", home_texture_min_interval_min: "120", home_last_texture_at: "2026-06-03T06:00:00Z" },
      rooms, presence, basin,
    );
    await runHomeTick(envFire, { only: ["cypher"], rng: () => 0.0, textureProvider: { generate: fired }, now: new Date("2026-06-03T12:00:00Z") });
    expect(fired).toHaveBeenCalledTimes(1);

    // within interval (last texture 30 min ago) -> suppressed
    const fired2 = vi.fn(async () => "lush line");
    const envSkip = makeKeyedEnv(
      { home_texture_model: "deepseek", home_texture_min_interval_min: "120", home_last_texture_at: "2026-06-03T11:30:00Z" },
      rooms, presence, basin,
    );
    await runHomeTick(envSkip, { only: ["cypher"], rng: () => 0.0, textureProvider: { generate: fired2 }, now: new Date("2026-06-03T12:00:00Z") });
    expect(fired2).not.toHaveBeenCalled();
  });
});

function makeKeyedEnv(settings: Record<string, string>, rooms: Row[], presence: Row[], basin: Row[]) {
  return { ADMIN_SECRET: "t", DB: { prepare: (sql: string) => {
    let boundKey: string | null = null;
    const stmt: any = {
      bind: (...args: unknown[]) => {
        // companion_settings reads bind (companion_id, key)
        if (sql.includes("FROM companion_settings") && args.length >= 2) boundKey = String(args[1]);
        return stmt;
      },
      all: async () => ({ results: sql.includes("FROM home_rooms") ? rooms : sql.includes("FROM home_events") ? [] : [] }),
      first: async () => {
        if (sql.includes("FROM home_presence")) return presence[0] ?? null;
        if (sql.includes("FROM companion_basin_history")) return basin[0] ?? null;
        if (sql.includes("FROM companion_settings")) return boundKey && settings[boundKey] !== undefined ? { value: settings[boundKey] } : null;
        return null;
      },
      run: async () => ({ meta: { changes: 1 } }),
    };
    return stmt;
  } } } as any;
}
