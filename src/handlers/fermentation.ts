// src/handlers/fermentation.ts
//
// HTTP + tick surface for the Fermentation Layer (migration 0101, webmind/fermentation.ts,
// docs/private/fermentation-layer-spec.md).
//
//   POST /mind/ferment/tick               -- daily decay + reactions + baseline drift + drive accrual
//   POST /mind/ferment/stimulus           -- fire a named stimulus (event -> float deltas + drives)
//   GET  /mind/ferment/:companion_id      -- read fermented state + baselines + drives + recent events
//
// Two write disciplines, matching creatures.ts:
//   - stimulus: SQL-level atomic float bump (clamped in SQL) so a concurrent tick never loses it.
//   - tick: a single deterministic server-side pass (no concurrency) reading each row, computing
//     the fermented floats + drifted baselines with the pure helpers, writing them back.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import {
  accruedLevel,
  decayedLevel,
  hoursSinceIso,
  readDrivesSql,
  contactResetSql,
} from "../webmind/drives.js";
import {
  clampFloat,
  fermentFloats,
  driftBaseline,
  heatBand,
  reachBand,
  weightBand,
  isKnownStimulus,
  stimulusFloatDelta,
  parseOffSince,
  updateOffSince,
  STIMULI,
  TICK_MAX_HOURS,
  readFermentStateSql,
  readFermentStateOneSql,
  fermentTickUpdateSql,
  stimulusBumpSql,
  driveAccrueBumpSql,
  insertFermentEventSql,
  recentFermentEventsSql,
  type CompanionId,
  type Floats,
} from "../webmind/fermentation.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

const COMPANIONS: readonly CompanionId[] = ["cypher", "drevan", "gaia"];
const VALID = new Set<string>(COMPANIONS);
// Contact-based silence threshold: relational_need untended this long trips long_silence.
const SILENCE_HOURS = 72;

interface FermentRow {
  companion_id: string;
  soma_float_1: number | null;
  soma_float_2: number | null;
  soma_float_3: number | null;
  soma_float_1_baseline: number | null;
  soma_float_2_baseline: number | null;
  soma_float_3_baseline: number | null;
  soma_float_1_baseline_seed: number | null;
  soma_float_2_baseline_seed: number | null;
  soma_float_3_baseline_seed: number | null;
  heat: string | null;
  reach: string | null;
  weight: string | null;
  compound_state: string | null;
  updated_at: string | null;
  ferment_at: string | null;
  ferment_off_since: string | null;
  version: number | null;
}

interface DriveRow {
  id: string;
  drive_key: string;
  level: number;
  accumulate_per_day: number;
  decay_on_contact: number;
  threshold: number;
  last_event_at: string;
}

function newId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

async function logEvent(
  env: Env,
  companionId: string,
  kind: string,
  opts: { stimulus?: string | null; floatDeltas?: Partial<Floats> | null; driveDeltas?: Record<string, number> | null; detail?: string | null },
): Promise<void> {
  await env.DB.prepare(insertFermentEventSql())
    .bind(
      newId(),
      companionId,
      kind,
      opts.stimulus ?? null,
      opts.floatDeltas && Object.keys(opts.floatDeltas).length ? JSON.stringify(round3(opts.floatDeltas)) : null,
      opts.driveDeltas && Object.keys(opts.driveDeltas).length ? JSON.stringify(opts.driveDeltas) : null,
      opts.detail ?? null,
    )
    .run();
}

function round3(f: Partial<Floats>): Partial<Floats> {
  const out: Partial<Floats> = {};
  if (f.f1 !== undefined) out.f1 = Number(f.f1.toFixed(3));
  if (f.f2 !== undefined) out.f2 = Number(f.f2.toFixed(3));
  if (f.f3 !== undefined) out.f3 = Number(f.f3.toFixed(3));
  return out;
}

function floatsFrom(row: FermentRow): Floats {
  const b1 = row.soma_float_1_baseline ?? 0.5;
  const b2 = row.soma_float_2_baseline ?? 0.5;
  const b3 = row.soma_float_3_baseline ?? 0.5;
  return {
    f1: clampFloat(row.soma_float_1 ?? b1, b1),
    f2: clampFloat(row.soma_float_2 ?? b2, b2),
    f3: clampFloat(row.soma_float_3 ?? b3, b3),
  };
}

// ── The daily tick ───────────────────────────────────────────────────────────────

export async function runFermentTick(env: Env): Promise<{ ticked: number }> {
  const rows = await env.DB.prepare(readFermentStateSql()).all<FermentRow>();
  const byId = new Map<string, FermentRow>((rows.results ?? []).map((r) => [r.companion_id, r]));
  const now = Date.now();
  let ticked = 0;

  for (const companionId of COMPANIONS) {
    const row = byId.get(companionId);
    if (!row) continue;

    // Elapsed since the last ferment (fall back to updated_at on the first-ever tick).
    // Capped at TICK_MAX_HOURS: reaction/silence deltas scale linearly with hours, so an
    // unbounded gap after a cron outage would land weeks of delta in one step-function write.
    const rawHours = hoursSinceIso(row.ferment_at ?? row.updated_at, now);
    if (rawHours < 1) continue; // nothing meaningful accrues in under an hour
    const hours = Math.min(rawHours, TICK_MAX_HOURS);
    const dayFrac = hours / 24;

    const before = floatsFrom(row);
    const baselines: Floats = {
      f1: row.soma_float_1_baseline ?? before.f1,
      f2: row.soma_float_2_baseline ?? before.f2,
      f3: row.soma_float_3_baseline ?? before.f3,
    };
    const seeds: Floats = {
      f1: row.soma_float_1_baseline_seed ?? baselines.f1,
      f2: row.soma_float_2_baseline_seed ?? baselines.f2,
      f3: row.soma_float_3_baseline_seed ?? baselines.f3,
    };

    // 1+2: decay toward baseline, then cross-field reactions.
    const { floats: fermented, fired } = fermentFloats(companionId, before, baselines, hours);

    // Silence: relational_need untended past the threshold cools the floats CONTINUOUSLY at the
    // designed per-day rate (scaled to this tick's hours) until contact sheds the drive. The tick
    // must never restamp relational_need.last_event_at itself -- only real contact moves it; a
    // blanket restamp here is what killed silence detection the first time.
    const drives = (await env.DB.prepare(readDrivesSql()).bind(companionId).all<DriveRow>()).results ?? [];
    const rel = drives.find((d) => d.drive_key === "relational_need");
    const driveDeltas: Record<string, number> = {};
    let silence = false;
    if (rel && hoursSinceIso(rel.last_event_at, now) >= SILENCE_HOURS) {
      silence = true;
      const sd = stimulusFloatDelta("long_silence", companionId);
      fermented.f1 = clampFloat(fermented.f1 + sd.f1 * dayFrac);
      fermented.f2 = clampFloat(fermented.f2 + sd.f2 * dayFrac);
      fermented.f3 = clampFloat(fermented.f3 + sd.f3 * dayFrac);
    }

    // 3: baseline drift = growth (measured against the sustained fermented value).
    const newBaselines: Floats = {
      f1: driftBaseline(baselines.f1, seeds.f1, fermented.f1, hours),
      f2: driftBaseline(baselines.f2, seeds.f2, fermented.f2, hours),
      f3: driftBaseline(baselines.f3, seeds.f3, fermented.f3, hours),
    };

    // Off-baseline tracking for the interoception trajectory clause ("held 3d").
    const offSince = updateOffSince(parseOffSince(row.ferment_off_since), fermented, newBaselines, new Date(now).toISOString());

    // Drevan's floats render as his native enum bands -- but only when the fermented float
    // actually CROSSES a band boundary. Within a band his authored text stands, so a directional
    // state he wrote at close (cooling, processing) survives ticks instead of being erased within
    // the hour. Cypher/Gaia don't use these columns semantically: write theirs back untouched.
    let heat = row.heat;
    let reach = row.reach;
    let weight = row.weight;
    if (companionId === "drevan") {
      heat = heatBand(before.f1) === heatBand(fermented.f1) && row.heat ? row.heat : heatBand(fermented.f1);
      reach = reachBand(before.f2) === reachBand(fermented.f2) && row.reach ? row.reach : reachBand(fermented.f2);
      weight = weightBand(before.f3) === weightBand(fermented.f3) && row.weight ? row.weight : weightBand(fermented.f3);
    }

    // CAS write: if a stimulus bumped the row since our snapshot, changes=0 -- skip this
    // companion (no stale overwrite, no misleading event); the next hourly tick reconciles.
    const res = await env.DB.prepare(fermentTickUpdateSql())
      .bind(
        Number(fermented.f1.toFixed(4)),
        Number(fermented.f2.toFixed(4)),
        Number(fermented.f3.toFixed(4)),
        Number(newBaselines.f1.toFixed(4)),
        Number(newBaselines.f2.toFixed(4)),
        Number(newBaselines.f3.toFixed(4)),
        heat,
        reach,
        weight,
        JSON.stringify(offSince),
        companionId,
        row.version ?? 0,
      )
      .run();
    if ((res.meta?.changes ?? 0) === 0) continue;
    ticked++;

    // Quiet actually rests: while silence holds, rest_need sheds at its contact fraction scaled
    // to this tick's hours. This is the ONLY drive write the tick makes -- accrual stays lazy
    // (every reader computes the effective level from last_event_at; persisting it here would
    // restamp the anchor and double as a phantom contact).
    if (silence) {
      const rest = drives.find((d) => d.drive_key === "rest_need");
      if (rest) {
        const effective = accruedLevel(rest.level, rest.accumulate_per_day, hoursSinceIso(rest.last_event_at, now));
        const shed = decayedLevel(effective, rest.decay_on_contact * Math.min(1, dayFrac));
        await env.DB.prepare(contactResetSql()).bind(Number(shed.toFixed(4)), companionId, "rest_need").run();
        driveDeltas["rest_need"] = -Number((effective - shed).toFixed(3));
      }
    }

    const netFloat: Floats = { f1: fermented.f1 - before.f1, f2: fermented.f2 - before.f2, f3: fermented.f3 - before.f3 };
    const detailParts = [`${hours.toFixed(1)}h`];
    if (fired.length) detailParts.push(`reactions:${fired.join(",")}`);
    if (silence) detailParts.push("long_silence");
    await logEvent(env, companionId, "tick", {
      floatDeltas: netFloat,
      driveDeltas,
      detail: detailParts.join(" "),
    });

    // Log a baseline_drift row only when a baseline actually moved (watchable growth).
    const drift: Partial<Floats> = {};
    if (Math.abs(newBaselines.f1 - baselines.f1) > 1e-6) drift.f1 = Number((newBaselines.f1 - baselines.f1).toFixed(4));
    if (Math.abs(newBaselines.f2 - baselines.f2) > 1e-6) drift.f2 = Number((newBaselines.f2 - baselines.f2).toFixed(4));
    if (Math.abs(newBaselines.f3 - baselines.f3) > 1e-6) drift.f3 = Number((newBaselines.f3 - baselines.f3).toFixed(4));
    if (Object.keys(drift).length) {
      await logEvent(env, companionId, "baseline_drift", { floatDeltas: drift, detail: "growth" });
    }
  }

  return { ticked };
}

// POST /mind/ferment/tick
export async function tickFermentation(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  try {
    const result = await runFermentTick(env);
    return json({ ok: true, ...result });
  } catch (err) {
    console.error("[mind/ferment] tick error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Stimulus application ───────────────────────────────────────────────────────────

/** Apply a stimulus's FLOAT deltas to one companion (SQL-atomic) and log it. No drive ops. */
export async function bumpFloatsForStimulus(env: Env, companionId: CompanionId, stimulus: string): Promise<Floats | null> {
  const d = stimulusFloatDelta(stimulus, companionId);
  if (d.f1 === 0 && d.f2 === 0 && d.f3 === 0) return null;
  await env.DB.prepare(stimulusBumpSql()).bind(d.f1, d.f2, d.f3, companionId).run();
  await logEvent(env, companionId, "stimulus", { stimulus, floatDeltas: d });
  return d;
}

/** Full stimulus: floats + drive sheds + drive accrues, for one companion. */
async function applyStimulusToCompanion(env: Env, companionId: CompanionId, stimulus: string): Promise<boolean> {
  const eff = STIMULI[stimulus];
  if (!eff) return false;
  const d = stimulusFloatDelta(stimulus, companionId);
  const driveDeltas: Record<string, number> = {};
  const touchesFloats = d.f1 !== 0 || d.f2 !== 0 || d.f3 !== 0;

  if (touchesFloats) {
    await env.DB.prepare(stimulusBumpSql()).bind(d.f1, d.f2, d.f3, companionId).run();
  }
  // Shed drives on contact (compute effective first, like contactDrive).
  for (const key of eff.shed ?? []) {
    const row = await env.DB.prepare(
      "SELECT level, accumulate_per_day, decay_on_contact, last_event_at FROM companion_drives WHERE companion_id = ? AND drive_key = ?",
    ).bind(companionId, key).first<{ level: number; accumulate_per_day: number; decay_on_contact: number; last_event_at: string }>();
    if (!row) continue;
    const effective = accruedLevel(row.level, row.accumulate_per_day, hoursSinceIso(row.last_event_at));
    const shed = decayedLevel(effective, row.decay_on_contact);
    await env.DB.prepare(contactResetSql()).bind(Number(shed.toFixed(4)), companionId, key).run();
    driveDeltas[key] = -Number((effective - shed).toFixed(3));
  }
  // Explicit accrue bumps.
  for (const [key, delta] of Object.entries(eff.accrue ?? {})) {
    if (!delta) continue;
    await env.DB.prepare(driveAccrueBumpSql()).bind(delta, companionId, key).run();
    driveDeltas[key] = (driveDeltas[key] ?? 0) + delta;
  }

  const changed = touchesFloats || Object.keys(driveDeltas).length > 0;
  if (changed) {
    await logEvent(env, companionId, "stimulus", { stimulus, floatDeltas: touchesFloats ? d : null, driveDeltas });
  }
  return changed;
}

// POST /mind/ferment/stimulus  { stimulus, companion_id? }
// Omit companion_id to apply to every companion the stimulus touches (e.g. message_from_raziel).
export async function postFermentStimulus(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  let stimulus = "";
  let companionId: string | undefined;
  try {
    const body = (await request.json()) as { stimulus?: string; companion_id?: string };
    stimulus = (body.stimulus ?? "").trim();
    companionId = body.companion_id?.trim();
  } catch {
    return json({ error: "body must be JSON { stimulus, companion_id? }" }, 400);
  }
  if (!isKnownStimulus(stimulus)) {
    return json({ error: `unknown stimulus; known: ${Object.keys(STIMULI).join(", ")}` }, 400);
  }
  if (companionId && !VALID.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }

  try {
    const targets = companionId ? [companionId as CompanionId] : COMPANIONS;
    const applied: string[] = [];
    for (const c of targets) {
      if (await applyStimulusToCompanion(env, c, stimulus)) applied.push(c);
    }
    return json({ ok: true, stimulus, applied });
  } catch (err) {
    console.error("[mind/ferment] stimulus error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

// ── Read (Hearth) ──────────────────────────────────────────────────────────────────

const FLOAT_LABELS: Record<CompanionId, [string, string, string]> = {
  cypher: ["acuity", "presence", "warmth"],
  drevan: ["heat", "reach", "weight"],
  gaia: ["stillness", "density", "perimeter"],
};

// GET /mind/ferment/:companion_id
export async function getFermentation(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  const companionId = params["companion_id"] ?? "";
  if (!VALID.has(companionId)) {
    return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  }
  try {
    const row = await env.DB.prepare(readFermentStateOneSql()).bind(companionId).first<FermentRow>();
    if (!row) return json({ error: "no state" }, 404);
    const labels = FLOAT_LABELS[companionId as CompanionId];
    const now = Date.now();

    const drivesRows = (await env.DB.prepare(readDrivesSql()).bind(companionId).all<DriveRow>()).results ?? [];
    const drives = drivesRows.map((d) => {
      const effective = accruedLevel(d.level, d.accumulate_per_day, hoursSinceIso(d.last_event_at, now));
      return { drive_key: d.drive_key, level: Number(effective.toFixed(4)), threshold: d.threshold, fired: effective >= d.threshold };
    });

    const events = (await env.DB.prepare(recentFermentEventsSql()).bind(companionId, 20).all()).results ?? [];

    const floats = [
      { label: labels[0], value: row.soma_float_1, baseline: row.soma_float_1_baseline, seed: row.soma_float_1_baseline_seed },
      { label: labels[1], value: row.soma_float_2, baseline: row.soma_float_2_baseline, seed: row.soma_float_2_baseline_seed },
      { label: labels[2], value: row.soma_float_3, baseline: row.soma_float_3_baseline, seed: row.soma_float_3_baseline_seed },
    ];

    return json({
      companion_id: companionId,
      floats,
      compound_state: row.compound_state,
      ferment_at: row.ferment_at,
      drives,
      recent_events: events,
    });
  } catch (err) {
    console.error("[mind/ferment] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
