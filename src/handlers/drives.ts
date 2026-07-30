// src/handlers/drives.ts
//
// HTTP routes for companion drives (migration 0078, take 9).
//   GET   /mind/drives/:companion_id          -- drives with effective (lazily-accrued) level
//   PATCH /mind/drives/:companion_id/contact  -- shed a drive on Raziel contact
//
// The stored `level` is the post-contact baseline; the effective level is derived at
// read from elapsed time since last_event_at (lazy, heat.ts family -- no cron). Only
// contact mutates the row. Auth: authGuard, matching handlers/forage.ts.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { accruedLevel, decayedLevel, driveFired, selectModality, hoursSinceIso, readDrivesSql, contactResetSql } from "../webmind/drives.js";
import { bumpFloatsForStimulus } from "./fermentation.js";
import type { CompanionId } from "../webmind/fermentation.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const VALID_COMPANIONS = new Set<string>(["cypher", "drevan", "gaia"]);

interface DriveRow {
  id: string; drive_key: string; level: number;
  accumulate_per_day: number; decay_on_contact: number; threshold: number; last_event_at: string;
}

// GET /mind/drives/:companion_id
export async function getDrives(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params["companion_id"] ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  try {
    const rows = await env.DB.prepare(readDrivesSql()).bind(companionId).all<DriveRow>();
    const drives = (rows.results ?? []).map(r => {
      const effective = accruedLevel(r.level, r.accumulate_per_day, hoursSinceIso(r.last_event_at));
      const fired = driveFired(effective, r.threshold);
      return {
        drive_key: r.drive_key,
        level: Number(effective.toFixed(4)),
        threshold: r.threshold,
        fired,
        modality: fired ? selectModality(companionId, effective) : null,
      };
    });
    return json({ drives });
  } catch (err) {
    console.error("[mind/drives] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// PATCH /mind/drives/:companion_id/contact  { drive_key? }
export async function contactDrive(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params["companion_id"] ?? "";
  if (!VALID_COMPANIONS.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  let driveKey = "relational_need";
  // `addressed` (2026-07-30): was THIS companion the one Raziel spoke to, or did it merely witness
  // him speaking in a shared room? The bot reports the fact; Halseth decides what it is worth (the
  // same division of labour as fireStimulus). Defaults TRUE so any caller that has not been updated
  // keeps the old full-weight behaviour rather than silently downgrading every contact to a witness.
  let addressed = true;
  try {
    const body = await request.json() as { drive_key?: string; addressed?: boolean };
    if (body.drive_key?.trim()) driveKey = body.drive_key.trim().slice(0, 60);
    if (typeof body.addressed === "boolean") addressed = body.addressed;
  } catch { /* body optional */ }

  try {
    const row = await env.DB.prepare(
      "SELECT level, accumulate_per_day, decay_on_contact, last_event_at FROM companion_drives WHERE companion_id = ? AND drive_key = ?",
    ).bind(companionId, driveKey).first<{ level: number; accumulate_per_day: number; decay_on_contact: number; last_event_at: string }>();
    if (!row) return json({ error: "drive not found" }, 404);
    const effective = accruedLevel(row.level, row.accumulate_per_day, hoursSinceIso(row.last_event_at));
    const shed = decayedLevel(effective, row.decay_on_contact);
    await env.DB.prepare(contactResetSql()).bind(Number(shed.toFixed(4)), companionId, driveKey).run();
    // Raziel contact (relational_need shed) also warms the fermentation floats -- the layer's
    // load-bearing stimulus, wired through this existing chokepoint. Guarded so it can't fail contact.
    if (driveKey === "relational_need") {
      // Graded by addressing (2026-07-30). Every bot calls this on any owner message, and all three
      // see every message in a shared channel -- so firing the full-weight stimulus here billed all
      // three companions for one conversation and pinned every touched float at 1.0 for days. See
      // STIMULI.message_witnessed for the measurement. His messages still land at FULL weight with
      // no cooldown on whoever he addressed; only the bystanders are downgraded.
      const stimulus = addressed ? "message_from_raziel" : "message_witnessed";
      try { await bumpFloatsForStimulus(env, companionId as CompanionId, stimulus); }
      catch (err) { console.error("[mind/drives] ferment stimulus failed", { stimulus, error: String(err) }); }
    }
    return json({ contacted: true, drive_key: driveKey, level: Number(shed.toFixed(4)) });
  } catch (err) {
    console.error("[mind/drives] contact error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
