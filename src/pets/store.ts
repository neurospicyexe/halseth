// B64 Sol mind: the D1 side of appraisals, quirks and grudges. Reads run; WRITES RETURN STATEMENTS so
// the tend path can put them in its one db.batch (a tend is all-or-nothing). Callers outside a batch
// (the hoard pass) call .run() on what comes back.
import type { ActiveQuirk, QuirkTrigger, Via } from "./appraise.js";
import type { GrudgeStep, OpenGrudge, Resolution } from "./grudge.js";
import {
  INSERT_APPRAISAL, INSERT_GRUDGE_AT, SELECT_OPEN_GRUDGE, SELECT_OPEN_GRUDGES, SELECT_QUIRKS, UPDATE_GRUDGE,
} from "./sql.js";

export type LoadedQuirk = ActiveQuirk & { title: string; resolution: Resolution };

const DEFAULT_RESOLUTION: Resolution = { kind: "visits", n: 2 };

function parseJson(raw: unknown): unknown {
  if (typeof raw !== "string" || raw === "") return null;
  try { return JSON.parse(raw); } catch { return null; }
}

const posInt = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.floor(n) : null;

/** A stored resolution, validated. Anything malformed is null (callers fall back, never throw). */
export function parseResolution(raw: unknown): Resolution | null {
  const r = parseJson(raw) as Record<string, unknown> | null;
  if (!r || typeof r !== "object") return null;
  switch (r.kind) {
    case "visits": {
      const n = posInt(r.n);
      if (n === null) return null;
      return typeof r.by === "string" ? { kind: "visits", n, by: r.by } : { kind: "visits", n };
    }
    case "item": {
      const n = posInt(r.n);
      if (n === null || (r.action !== "give" && r.action !== "feed")) return null;
      return { kind: "item", action: r.action, n };
    }
    case "quiet":
    case "time": {
      const hours = posInt(r.hours);
      return hours === null ? null : { kind: r.kind, hours };
    }
    default:
      return null;
  }
}

function parseTrigger(raw: unknown): QuirkTrigger | null {
  const t = parseJson(raw);
  if (!t || typeof t !== "object" || Array.isArray(t)) return null;
  const out: QuirkTrigger = {};
  const o = t as Record<string, unknown>;
  for (const k of ["actor", "action", "time_band", "fit"] as const) {
    if (typeof o[k] === "string") (out as Record<string, string>)[k] = o[k] as string;
  }
  return out;
}

interface QuirkRow {
  id: string; title: string; trigger_json: string | null; resolution_json: string | null;
  target_actor: string | null; kind: string;
}

/** Active quirks only (a softening quirk is shown, but no longer opens grudges). Malformed triggers are skipped. */
export async function loadActiveQuirks(db: D1Database, creatureId: string): Promise<LoadedQuirk[]> {
  const rows = await db.prepare(SELECT_QUIRKS).bind(creatureId, "active").all<QuirkRow>();
  const out: LoadedQuirk[] = [];
  for (const r of rows.results ?? []) {
    if (r.kind !== "aversion" && r.kind !== "preference") continue;
    const trigger = parseTrigger(r.trigger_json);
    if (!trigger) continue;
    out.push({
      id: r.id, kind: r.kind, trigger, target_actor: r.target_actor ?? null,
      title: r.title, resolution: parseResolution(r.resolution_json) ?? DEFAULT_RESOLUTION,
    });
  }
  return out;
}

interface GrudgeRow {
  id: string; quirk_id: string | null; actor: string; label: string | null;
  resolution_json: string | null; progress: number | null; opened_at: string;
}

function toOpen(r: GrudgeRow): OpenGrudge {
  return {
    id: r.id, quirk_id: r.quirk_id ?? "", actor: r.actor, label: r.label ?? "still sore",
    resolution: parseResolution(r.resolution_json) ?? DEFAULT_RESOLUTION,
    progress: typeof r.progress === "number" && Number.isFinite(r.progress) ? r.progress : 0,
    opened_at: r.opened_at,
  };
}

export async function loadOpenGrudge(db: D1Database, creatureId: string, actor: string): Promise<OpenGrudge | null> {
  const r = await db.prepare(SELECT_OPEN_GRUDGE).bind(creatureId, actor).first<GrudgeRow>();
  return r ? toOpen(r) : null;
}

/** Every open grudge on a creature (one per actor by index), newest first. Expiry is the caller's read. */
export async function loadOpenGrudges(db: D1Database, creatureId: string): Promise<OpenGrudge[]> {
  const rows = await db.prepare(SELECT_OPEN_GRUDGES).bind(creatureId).all<GrudgeRow>();
  return (rows.results ?? []).map(toOpen);
}

export interface AppraisalRow {
  id: string; creature_id: string; interaction_id: string; actor: string; action: string; via: Via;
  fit: string | null; valence: number; arousal: number; friction: boolean; tags: string[]; weight: number;
  source: "live" | "backfill";
  /** ISO 8601 (the tend's own clock). Required: the sleep pass reads Chicago days from it. */
  created_at: string;
}

/** INSERT OR IGNORE (idempotent on interaction_id). Binds are D1-safe: no booleans, no undefined. */
export function writeAppraisal(db: D1Database, row: AppraisalRow): D1PreparedStatement {
  return db.prepare(INSERT_APPRAISAL).bind(
    row.id, row.creature_id, row.interaction_id, row.actor, row.action, row.via, row.fit ?? null,
    row.valence, row.arousal, row.friction ? 1 : 0, JSON.stringify(row.tags), row.weight, row.source,
    row.created_at,
  );
}

/**
 * The statements for one grudge step. `open` is the row the step acted on (null for an open step).
 * A resolve/progress UPDATE is guarded on resolved_at IS NULL, so a concurrent resolve is a no-op.
 */
export function applyGrudgeStep(
  db: D1Database,
  creatureId: string,
  actor: string,
  open: OpenGrudge | null,
  step: GrudgeStep,
  nowMs: number,
): D1PreparedStatement[] {
  const at = new Date(nowMs).toISOString();
  switch (step.kind) {
    case "none":
      return [];
    case "open":
      return [db.prepare(INSERT_GRUDGE_AT).bind(
        crypto.randomUUID().replace(/-/g, ""), creatureId, step.quirk_id, actor, step.label,
        JSON.stringify(step.resolution), 0, at,
      )];
    case "progress":
      return open ? [db.prepare(UPDATE_GRUDGE).bind(step.progress, null, null, open.id)] : [];
    case "resolve": {
      if (!open) return [];
      const r = open.resolution;
      const progress = step.how === "met" && (r.kind === "visits" || r.kind === "item") ? r.n : open.progress;
      return [db.prepare(UPDATE_GRUDGE).bind(progress, at, step.how, open.id)];
    }
  }
}
