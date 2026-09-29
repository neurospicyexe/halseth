// R9 (Raziel 2026-09-28): one cold conclusion resurfaces at orient on a deterministic day rotation, and
// is NOT warmed by being shown. Runs against the REAL schema (every migration, node:sqlite) so the window
// function, the junk predicate and the warm UPDATE are exercised as SQL, not as fixture string-matches.

import { describe, it, expect, vi } from "vitest";

vi.mock("../mcp/embed.js", () => ({
  embedAndStoreAsync: vi.fn(async () => undefined),
  storeVector: vi.fn(async () => undefined),
}));

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import {
  mindOrient, readResurfacedConclusion, resurfaceDayIndex,
  RESURFACE_COLD_HEAT_MAX, RESURFACE_MIN_CHARS,
} from "../webmind/orient.js";
import { loadMindState } from "../mind/loader.js";
import { botWireFromMindState } from "../mind/adapters/bot-wire.js";
import { buildContinuityBlock, renderResurfacedConclusion } from "../librarian/response/builder.js";

const DAY = 86_400_000;

function setup() {
  const { db, DB } = makeSqliteD1();
  const env: any = { DB, ADMIN_SECRET: "s", MCP_AUTH_SECRET: "m", SYSTEM_OWNER: "raziel" };
  return { db, env };
}

function seedConclusion(db: any, o: {
  id: string; text?: string; heat?: number; created_at: string; companion?: string;
  superseded_by?: string | null; archived?: number; flagged?: number; last_access_at?: string | null;
}) {
  db.prepare(
    `INSERT INTO companion_conclusions
       (id, companion_id, conclusion_text, created_at, superseded_by, archived, contradiction_flagged, heat, last_access_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    o.id, o.companion ?? "drevan",
    o.text ?? `A conclusion long enough to count, row ${o.id}.`,
    o.created_at, o.superseded_by ?? null, o.archived ?? 0, o.flagged ?? 0, o.heat ?? 1, o.last_access_at ?? null,
  );
}

function heatOf(db: any, id: string): { heat: number; last_access_at: string | null } {
  return db.prepare("SELECT heat, last_access_at FROM companion_conclusions WHERE id = ?").get(id);
}

/** Five valid cold rows, created on consecutive days (pool order = created_at). */
function seedPool(db: any) {
  for (let i = 0; i < 5; i++) {
    seedConclusion(db, { id: `cold${i}`, created_at: `2026-05-0${i + 1}T00:00:00Z` });
  }
}

describe("readResurfacedConclusion -- selection", () => {
  it("rotates through the whole pool, one row per UTC day, then wraps", async () => {
    const { db, env } = setup();
    seedPool(db);
    const base = 20_000 * DAY; // dayIndex 20000 -> 20000 % 5 = 0
    const picks: string[] = [];
    for (let d = 0; d < 10; d++) {
      const r = await readResurfacedConclusion(env, "drevan", [], new Date(base + d * DAY + 3_600_000));
      picks.push(r!.id);
      expect(r!.pool_size).toBe(5);
    }
    expect(picks.slice(0, 5)).toEqual(["cold0", "cold1", "cold2", "cold3", "cold4"]);
    expect(picks.slice(5)).toEqual(picks.slice(0, 5)); // cycles, no random repeats
    expect(resurfaceDayIndex(new Date(base + 3_600_000))).toBe(20_000);
  });

  it("is stable within a day (every loom sees the same row that day)", async () => {
    const { db, env } = setup();
    seedPool(db);
    const a = await readResurfacedConclusion(env, "drevan", [], new Date(20_002 * DAY + 60_000));
    const b = await readResurfacedConclusion(env, "drevan", [], new Date(20_002 * DAY + 23 * 3_600_000));
    expect(a!.id).toBe(b!.id);
  });

  it("excludes junk (trimmed text < RESURFACE_MIN_CHARS), hot, flagged, superseded, archived, other companions", async () => {
    const { db, env } = setup();
    expect(RESURFACE_MIN_CHARS).toBe(25);
    seedConclusion(db, { id: "keep", created_at: "2026-05-01T00:00:00Z" });
    seedConclusion(db, { id: "junk1", text: "the above", created_at: "2026-05-02T00:00:00Z" });
    seedConclusion(db, { id: "junk2", text: "s", created_at: "2026-05-03T00:00:00Z" });
    seedConclusion(db, { id: "junk3", text: "   padded but short    ", created_at: "2026-05-04T00:00:00Z" });
    seedConclusion(db, { id: "hotset", created_at: "2026-05-05T00:00:00Z" });
    seedConclusion(db, { id: "warm", heat: RESURFACE_COLD_HEAT_MAX + 0.5, created_at: "2026-05-06T00:00:00Z" });
    seedConclusion(db, { id: "flag", flagged: 1, created_at: "2026-05-07T00:00:00Z" });
    seedConclusion(db, { id: "super", superseded_by: "keep", created_at: "2026-05-08T00:00:00Z" });
    seedConclusion(db, { id: "arch", archived: 1, created_at: "2026-05-09T00:00:00Z" });
    seedConclusion(db, { id: "other", companion: "cypher", created_at: "2026-05-10T00:00:00Z" });
    // Near-default counts as cold: a few SURFACE_BUMPs (0.02 each) do not remove a row from rotation.
    seedConclusion(db, { id: "nearcold", heat: 1.06, created_at: "2026-05-11T00:00:00Z" });

    const seen = new Set<string>();
    for (let d = 0; d < 6; d++) {
      const r = await readResurfacedConclusion(env, "drevan", ["hotset"], new Date((20_000 + d) * DAY));
      seen.add(r!.id);
      expect(r!.pool_size).toBe(2);
    }
    expect([...seen].sort()).toEqual(["keep", "nearcold"]);
  });

  it("empty pool returns null, and the render is empty", async () => {
    const { db, env } = setup();
    seedConclusion(db, { id: "only", created_at: "2026-05-01T00:00:00Z" });
    expect(await readResurfacedConclusion(env, "drevan", ["only"], new Date())).toBeNull();
    expect(await readResurfacedConclusion(env, "gaia", [], new Date())).toBeNull();
    expect(renderResurfacedConclusion(null)).toBe("");
  });
});

describe("mindOrient -- the resurfaced slot", () => {
  /** Six hot rows fill CONCLUSION_CAP, so everything cold is outside the hot set. */
  function seedHouse(db: any) {
    for (let i = 0; i < 6; i++) {
      seedConclusion(db, { id: `hot${i}`, heat: 4, last_access_at: "2026-09-27T00:00:00Z", created_at: `2026-06-0${i + 1}T00:00:00Z` });
    }
    seedPool(db);
  }

  it("surfaces one cold row outside active_conclusions and does NOT warm it (the hot set is warmed)", async () => {
    const { db, env } = setup();
    seedHouse(db);
    const o = await mindOrient(env, "drevan"); // consuming path: warms what it surfaces
    const hotIds = o.active_conclusions.map((c) => c.id);
    expect(hotIds.sort()).toEqual(["hot0", "hot1", "hot2", "hot3", "hot4", "hot5"]);
    const r = o.resurfaced_conclusion!;
    expect(r).toBeTruthy();
    expect(r.id).toMatch(/^cold/);
    expect(hotIds).not.toContain(r.id);

    // The hot set was warmed; the resurfaced row was not touched at all.
    expect(heatOf(db, "hot0").heat).toBeGreaterThan(4);
    expect(heatOf(db, r.id)).toEqual({ heat: 1, last_access_at: null });
    for (let i = 0; i < 5; i++) expect(heatOf(db, `cold${i}`).heat).toBe(1);
  });

  it("never lets a hot-set row take the slot even when the pool would otherwise land on it", async () => {
    const { db, env } = setup();
    // Only 3 rows, all cold, so all three are ALSO in the hot set: nothing left to rotate.
    for (let i = 0; i < 3; i++) seedConclusion(db, { id: `c${i}`, created_at: `2026-05-0${i + 1}T00:00:00Z` });
    const o = await mindOrient(env, "drevan", { readOnly: true });
    expect(o.active_conclusions).toHaveLength(3);
    expect(o.resurfaced_conclusion).toBeNull();
  });

  it("reaches the MindState contract and the bot wire; the Claude.ai continuity block labels it", async () => {
    const { db, env } = setup();
    seedHouse(db);
    const ms = await loadMindState(env, "drevan", "discord" as any);
    expect(ms.beliefs.resurfaced).toBeTruthy();
    expect(ms.beliefs.conclusions.map((c) => c.id)).not.toContain(ms.beliefs.resurfaced!.id);

    const wire = botWireFromMindState(ms, { synthesis_summary: null, rag_excerpts: [], history_excerpts: [], continuity_notes: [], owner: "raziel" }, "drevan") as any;
    expect(wire.resurfaced_conclusion).toMatchObject({ pool_size: 5, belief_type: "self" });
    expect(wire.resurfaced_conclusion.concluded_at).toMatch(/^2026-05-0/);
    expect((wire.active_conclusions as any[]).some((c) => c.conclusion_text === wire.resurfaced_conclusion.conclusion_text)).toBe(false);

    const o = await mindOrient(env, "drevan", { readOnly: true });
    const block = buildContinuityBlock(o, "drevan");
    expect(block).toContain("[An older conclusion, resurfacing -- 1 of 5 cold conclusions in rotation.");
    expect(block).toContain("not because it is current");
    expect(block).toContain(`[concluded @ ${o.resurfaced_conclusion!.created_at.slice(0, 10)}]`);
  });

  it("an empty pool renders nothing in the continuity block", async () => {
    const { db, env } = setup();
    for (let i = 0; i < 6; i++) seedConclusion(db, { id: `hot${i}`, heat: 4, created_at: `2026-06-0${i + 1}T00:00:00Z` });
    const o = await mindOrient(env, "drevan", { readOnly: true });
    expect(o.resurfaced_conclusion).toBeNull();
    expect(buildContinuityBlock(o, "drevan")).not.toContain("resurfacing");
  });
});
