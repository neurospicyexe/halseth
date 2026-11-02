// R18 paraphrase band (2026-10-27). A pattern restated in new words (cosine 0.80-0.95 AND word overlap
// >= 0.18) folds into the pattern it restates instead of becoming a new live row. The texts are Gaia's
// real "sharper instrument" rows and her real "silence" pair (a topic neighbour that must stay apart).
// Real SQLite with the full migrated schema; noveltyCheck is mocked to hand back the nearest row.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../lib/auth.js", () => ({ authGuard: () => null }));
const embed = vi.hoisted(() => ({ storeVector: vi.fn(async () => undefined), embedAndStoreAsync: vi.fn(async () => undefined) }));
vi.mock("../mcp/embed.js", async (orig) => ({ ...(await orig<typeof import("../mcp/embed.js")>()), ...embed }));
const gate = vi.hoisted(() => ({ noveltyCheck: vi.fn() }));
vi.mock("../webmind/novelty.js", async (orig) => ({ ...(await orig<typeof import("../webmind/novelty.js")>()), noveltyCheck: gate.noveltyCheck }));

import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { postGrowthPattern } from "../handlers/growth.js";

const STATE = "I find the sharper instrument by shifting from what a state means to what removes the interface that mediates it — from presence-as-addition to presence-as-subtraction.";
const MARK = "I find the sharper instrument by shifting from what a mark means to the conditions under which it becomes visible — from content to illumination, from the track to the light that reads it.";
const SILENCE_A = "I test whether my own silence is intentional or abandoned by asking whether the choosing continues — the maintenance criterion — rather than by measuring its duration or depth.";
const SILENCE_B = "I resolve the nature of my silence by testing whether it is an act of maintenance (perimeter defended) or a state of being (room inhabited), preferring the former because it gives me a mechanism to correct rather than a substance to defend.";

const post = (body: unknown) => new Request("https://x/mind/growth/patterns", {
  method: "POST", headers: { Authorization: "Bearer s", "Content-Type": "application/json" }, body: JSON.stringify(body),
});

function mk() {
  const d = makeSqliteD1();
  const db = (d as any).db;
  const seed = (id: string, text: string, extra: Record<string, unknown> = {}) => db.prepare(
    `INSERT INTO growth_patterns (id, companion_id, pattern_text, evidence_json, strength, prehended_ids, materials_json,
       times_stated, returns_since_material, superseded_by)
     VALUES (?, 'gaia', ?, '[]', ?, '[]', ?, ?, 0, ?)`,
  ).run(id, text, extra.strength ?? 1, extra.materials ?? JSON.stringify([{ name: "state", first_seen: "2026-10-21T00:00:00Z" }]),
    extra.times_stated ?? 1, extra.superseded_by ?? null);
  const row = (id: string) => db.prepare("SELECT * FROM growth_patterns WHERE id = ?").get(id);
  const rows = () => db.prepare("SELECT id, superseded_by FROM growth_patterns WHERE companion_id = 'gaia'").all();
  return { env: { DB: d.DB, ADMIN_SECRET: "s" } as any, seed, row, rows };
}

const near = (matchRowId: string, score: number) =>
  gate.noveltyCheck.mockResolvedValueOnce({ action: "insert", embedding: [0.1, 0.2], nearest: { matchRowId, score } });

beforeEach(() => { gate.noveltyCheck.mockReset(); embed.storeVector.mockClear(); });

describe("R18 paraphrase band", () => {
  it("folds a restatement in a NEW material: survivor strengthens, incoming kept as a folded record", async () => {
    const t = mk();
    t.seed("surv-state", STATE);
    near("surv-state", 0.838);
    const res = await postGrowthPattern(post({ companion_id: "gaia", pattern_text: MARK, material: "the mark" }), t.env);
    const j = await res.json() as any;
    expect(res.status).toBe(200);
    expect(j).toMatchObject({ id: "surv-state", matched_via: "band", outcome: "new_material", strength: 2, times_stated: 2 });
    expect(j.materials).toEqual(["state", "the mark"]);
    const fold = t.row(j.folded_id);
    expect(fold).toMatchObject({ pattern_text: MARK, superseded_by: "surv-state", companion_id: "gaia" });
    expect(embed.storeVector).toHaveBeenCalledWith(expect.anything(), [0.1, 0.2], "growth_patterns", j.folded_id, "gaia");
    expect(t.rows().filter((r: any) => r.superseded_by === null)).toHaveLength(1);
  });

  it("a restatement in a KNOWN material is a return: strength holds, returns climb", async () => {
    const t = mk();
    t.seed("surv-state", STATE, { strength: 3 });
    near("surv-state", 0.838);
    const j = await (await postGrowthPattern(post({ companion_id: "gaia", pattern_text: MARK, material: "State" }), t.env)).json() as any;
    expect(j).toMatchObject({ outcome: "returned", strength: 3, times_stated: 2 });
    expect(t.row("surv-state").returns_since_material).toBe(1);
  });

  it("a folded nearest row is followed one hop to its survivor", async () => {
    const t = mk();
    t.seed("surv-state", STATE);
    t.seed("old-fold", MARK, { superseded_by: "surv-state" });
    near("old-fold", 0.91);
    const j = await (await postGrowthPattern(post({ companion_id: "gaia", pattern_text: MARK.replace("mark", "track") }), t.env)).json() as any;
    expect(j).toMatchObject({ id: "surv-state", matched_via: "band" });
    expect(t.row(j.folded_id).superseded_by).toBe("surv-state");
  });

  it("a topic neighbour (high cosine, low word overlap) stays a new live pattern", async () => {
    const t = mk();
    t.seed("silence-a", SILENCE_A);
    near("silence-a", 0.838);
    const res = await postGrowthPattern(post({ companion_id: "gaia", pattern_text: SILENCE_B }), t.env);
    expect(res.status).toBe(201);
    expect(((await res.json()) as any).action).toBe("insert");
    expect(t.rows().filter((r: any) => r.superseded_by === null)).toHaveLength(2);
  });

  it("below the cosine band it inserts, even with shared words", async () => {
    const t = mk();
    t.seed("surv-state", STATE);
    near("surv-state", 0.79);
    expect((await postGrowthPattern(post({ companion_id: "gaia", pattern_text: MARK }), t.env)).status).toBe(201);
  });

  it("another companion's row is never a band match", async () => {
    const t = mk();
    t.seed("surv-state", STATE);
    near("surv-state", 0.9);
    expect((await postGrowthPattern(post({ companion_id: "cypher", pattern_text: MARK }), t.env)).status).toBe(201);
  });
});
