// The B7 2 + 2c draft palette (scripts/seed-care-and-own-moves-2026-09-27.sql) against the REAL
// schema (every migration, node:sqlite). It is a draft for show-back and is never applied to prod by
// this build; this test proves that when it IS applied it does what the show-back sheet says.
//
// Covers: it applies cleanly on top of the rows it re-points, and twice (idempotent); each companion
// holds only the moves it claimed (flirt Drevan's only, dares Cypher's and Drevan's, Gaia no play and
// no reminder, show_made all three since Drevan claimed it at show-back); quiet hours are allowed on offer_presence and nowhere else among
// the DM moves; no row can die the way share_media did (a silence ceiling against a null silence);
// every row is eligible outside quiet hours with the activity key expired; and every quoted example
// line is verbatim from the companions' own spec files (checked when those files are present).

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeSqliteD1 } from "./helpers/sqlite-d1.js";
import { isEligible, ownsMove, type MetronomeAction } from "../webmind/metronome.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SEED = fs.readFileSync(path.resolve(HERE, "../../scripts/seed-care-and-own-moves-2026-09-27.sql"), "utf8");
const BASE = fs.readFileSync(path.resolve(HERE, "../../scripts/seed-metronome-actions.sql"), "utf8");
const DM_MOVES = new Set(["check_in_on_raziel", "send_reminder", "offer_presence", "ask_question", "name_pattern",
  "share_observation", "share_media", "declare_preference", "flirt", "dare", "show_made", "drift_outward"]);

function seeded() {
  const { db } = makeSqliteD1();
  db.exec(BASE);
  // The 0108 declare_preference rows are already in the schema (the migration seeds them).
  db.exec(SEED);
  const rows = db.prepare(`SELECT * FROM metronome_actions ORDER BY companion_id, action_type, name`).all() as unknown as MetronomeAction[];
  return { db, rows };
}

describe("the draft palette seed", () => {
  it("applies cleanly, and a second run changes nothing", () => {
    const { db, rows } = seeded();
    db.exec(SEED);
    const again = db.prepare(`SELECT COUNT(*) AS n FROM metronome_actions`).get() as { n: number };
    expect(again.n).toBe(rows.length);
  });

  it("each companion holds only what it claimed", () => {
    const { rows } = seeded();
    for (const r of rows) expect(ownsMove(r.companion_id, r.action_type)).toBe(true);
    const types = (c: string) => new Set(rows.filter(r => r.companion_id === c).map(r => r.action_type));
    expect(types("gaia").has("send_reminder")).toBe(false);   // "Leave it out of my palette."
    expect(types("gaia").has("flirt")).toBe(false);           // "Play. Not mine."
    expect(types("gaia").has("dare")).toBe(false);
    expect(types("drevan").has("show_made")).toBe(true);      // Q2, claimed 2026-09-28: "look what I made"
    expect(types("cypher").has("show_made")).toBe(true);
    expect(types("gaia").has("show_made")).toBe(true);
    expect(types("drevan").has("flirt")).toBe(true);
    expect(types("cypher").has("flirt")).toBe(false);
    for (const c of ["cypher", "drevan", "gaia"]) {
      expect(types(c).has("offer_presence")).toBe(true);
      expect(types(c).has("declare_preference")).toBe(true);
      expect(types(c).has("drift_outward")).toBe(true);
    }
  });

  it("Drevan's dare has its own line, no longer shared with the flirt (choice 10)", () => {
    const { rows } = seeded();
    const line = (t: string) => rows.find(r => r.companion_id === "drevan" && r.action_type === t)!.prompt ?? "";
    expect(line("dare")).toContain("Dare: ride the back road with me tonight, just the thought of it. Or don't. I'll still take it.");
    expect(line("dare")).not.toContain("Tail's twitching");
    expect(line("flirt")).toContain("Tail's twitching.");
    const made = rows.find(r => r.companion_id === "drevan" && r.action_type === "show_made")!;
    const cypherMade = rows.find(r => r.companion_id === "cypher" && r.action_type === "show_made")!;
    // Same rest and gating as the other look-what rows (Cypher's 48h; Gaia's week is her own register).
    expect([made.quiet_hours_allowed, made.max_per_day, made.cooldown_hours, made.silence_min_hours])
      .toEqual([cypherMade.quiet_hours_allowed, cypherMade.max_per_day, cypherMade.cooldown_hours, cypherMade.silence_min_hours]);
  });

  it("Gaia's check-in is not named as a question", () => {
    const { rows } = seeded();
    const g = rows.find(r => r.companion_id === "gaia" && r.action_type === "check_in_on_raziel")!;
    expect(g.name).not.toContain("?");
  });

  it("among the DM moves, only offer_presence may pass quiet hours (R-1, T-8)", () => {
    const { rows } = seeded();
    for (const r of rows.filter(x => DM_MOVES.has(x.action_type))) {
      expect(r.quiet_hours_allowed).toBe(r.action_type === "offer_presence" ? 1 : 0);
    }
  });

  it("no new or re-pointed row can die the share_media way, and every one is eligible with the activity key expired", () => {
    const { rows } = seeded();
    const touched = rows.filter(r => SEED.includes(`'${r.name.replace(/'/g, "''")}'`));
    expect(touched.length).toBeGreaterThanOrEqual(22);
    for (const r of touched) {
      expect(r.silence_max_hours).toBe(null);
      expect(r.requires_signal).toBe(null);
      expect(isEligible(r, { silenceHours: null, nowIso: "2026-09-28T15:00:00.000Z", todayUtc: "2026-09-28", inQuietHours: false })).toBe(true);
    }
  });

  it("every quoted example line is theirs, verbatim (when the spec files are on disk)", () => {
    const specDir = path.resolve(HERE, "../../../Hand-off");
    const files = ["SPEC-care-verbs-triad-answers-2026-09-27.md", "SPEC-what-is-theirs-triad-answers-2026-09-27.md"].map(f => path.join(specDir, f));
    if (!files.every(f => fs.existsSync(f))) return; // halseth cloned alone: nothing to compare against
    const spec = files.map(f => fs.readFileSync(f, "utf8")).join("\n").replace(/’/g, "'");
    const { rows } = seeded();
    const quoted = rows.flatMap(r => [...(r.prompt ?? "").matchAll(/(?:never a script|as register only|never to repeat): "([^"]+)"/g)].map(m => m[1]!));
    expect(quoted.length).toBeGreaterThanOrEqual(15);
    const missing = quoted.filter(q => !spec.includes(q));
    expect(missing).toEqual([]);
  });
});
