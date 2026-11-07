// Sol's grudges: legible, finite, one open per (creature, actor). Pure, no DB.
// A grudge is Sol's right to say no at a crow's scale; it never touches trust.
import type { CreatureAction, TierGroup } from "../webmind/creatures.js";
import type { ActiveQuirk } from "./appraise.js";

export type Resolution =
  | { kind: "visits"; n: number; by?: string }
  | { kind: "item"; action: "give" | "feed"; n: number }
  | { kind: "quiet"; hours: number }
  | { kind: "time"; hours: number };

export interface OpenGrudge {
  id: string; quirk_id: string; actor: string; label: string;
  resolution: Resolution; progress: number; opened_at: string;
}

export const GRUDGE_MAX_HOURS = 72;
const HOUR_MS = 3_600_000;

export type GrudgeStep =
  | { kind: "none" }
  | { kind: "open"; quirk_id: string; label: string; resolution: Resolution }
  | { kind: "progress"; progress: number }
  | { kind: "resolve"; how: "met" | "time" };

const PREFIX = "still sore about ";

export function grudgeLabel(title: string): string {
  return (PREFIX + title.toLowerCase()).slice(0, 60).trimEnd();
}

// D1's datetime('now') is "YYYY-MM-DD HH:MM:SS" with no zone; it is UTC, never local (same rule as daysSinceIso).
function openedMs(open: OpenGrudge): number {
  const s = typeof open.opened_at === "string" ? open.opened_at : "";
  return Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s) ? s.replace(" ", "T") + "Z" : s);
}

function limitHours(open: OpenGrudge): number {
  const r = open.resolution;
  if (r.kind !== "time") return GRUDGE_MAX_HOURS;
  const h = Number.isFinite(r.hours) ? r.hours : GRUDGE_MAX_HOURS;
  return Math.min(Math.max(h, 1), GRUDGE_MAX_HOURS);
}

/** Past its limit. An unreadable opened_at counts as expired: fail toward resolving, never toward a stuck grudge. */
export function expired(open: OpenGrudge, nowMs: number): boolean {
  const at = openedMs(open);
  if (!Number.isFinite(at)) return true;
  return nowMs - at >= limitHours(open) * HOUR_MS;
}

/**
 * The visible count: "progress of of". visits/item count tends; quiet/time count whole hours since it
 * opened, capped at the limit (and at 72h). Shared by the tend reply and GET /mind/creatures/:id.
 */
export function grudgeProgress(open: OpenGrudge, nowMs: number): { progress: number; of: number } {
  const r = open.resolution;
  if (r.kind === "visits" || r.kind === "item") {
    const of = Math.max(1, Math.floor(r.n));
    return { progress: Math.min(Math.max(0, Math.floor(open.progress)), of), of };
  }
  const of = r.kind === "time" ? limitHours(open) : Math.min(Math.max(1, Math.floor(r.hours)), GRUDGE_MAX_HOURS);
  const at = openedMs(open);
  const hours = Number.isFinite(at) ? Math.floor((nowMs - at) / HOUR_MS) : of;
  return { progress: Math.min(Math.max(0, hours), of), of };
}

export type GrudgeUnit = "visits" | "gives" | "feeds" | "hours";

/** What the count counts (R29): "1 of 2 visits", "0 of 1 gives", "5 of 12 hours". */
export function grudgeUnit(r: Resolution): GrudgeUnit {
  if (r.kind === "visits") return "visits";
  if (r.kind === "item") return r.action === "feed" ? "feeds" : "gives";
  return "hours";
}

// ── What a grudge looks like (authored; Task 6's voice replaces these when SOL_VOICE_MODE is on) ──
//
// Sulking is IN VIEW, never leaving: back turned, takes it late, drops it pointedly. He never speaks
// words. No digits, no double quotes, <= 220 chars. {who} is the tender slot (renderCare).

export const SULK_LINES: Record<TierGroup, string[]> = {
  low: [
    "*Sol takes it, but only after turning his back on {who} and studying the gutter for a long, pointed while. He stays on the rail.*",
    "*Sol leaves it on the sill untouched, then eats it late and slowly, facing the wall, so {who} can watch him not looking.*",
    "*a flat* kraa *aimed at nothing. Sol keeps to the far rail with his back to {who}, still in plain view, still sore.*",
  ],
  mid: [
    "*Sol takes it from {who} and drops it pointedly on the rail, then picks it up again a minute later when he thinks nobody is watching.*",
    "*Sol turns his back on {who} and preens one shoulder with great ceremony. He has not gone anywhere; he wants that noticed.*",
    "*Sol takes it late, with a short rattle-click of complaint, and eats it on the chair back facing the window instead of {who}.*",
  ],
  high: [
    "*Sol accepts it from {who} with his head turned firmly away, then edges one step closer anyway. The sulk is in progress, and in sight.*",
    "*Sol drops it at the foot of the rail with a pointed little clack, stares at {who}, and stays exactly where he can be seen being put out.*",
    "*a long, aggrieved* prruk *from the chair back. Sol keeps his back to {who} but leaves one eye turned that way the whole time.*",
  ],
};

export const MAKE_UP_LINES: string[] = [
  "*Sol turns around at last, hops the whole length of the rail to {who}, and bumps his head once against the offered hand. Forgiven, and he wants it seen.*",
  "*a soft* prruk*, and Sol sets a pebble down in front of {who} like a settled account. The sulk is over; he leans back in.*",
];

function pick(pool: string[], seed: number): string {
  return pool[Math.abs(Math.floor(seed)) % pool.length]!;
}

/** A sulk in sight, {who} slot unrendered. */
export function sulkLine(group: TierGroup, seed: number): string {
  return pick(SULK_LINES[group], seed);
}

/** The resolving tend's clear make-up moment, {who} slot unrendered. */
export function makeUpLine(seed: number): string {
  return pick(MAKE_UP_LINES, seed);
}

export function stepGrudge(
  open: OpenGrudge | null,
  ev: {
    actor: string; action: CreatureAction; friction: boolean;
    matchedAversion: ActiveQuirk | null; quirkTitle: string | null;
    quirkResolution: Resolution | null; nowMs: number;
  },
): GrudgeStep {
  if (open) {
    if (expired(open, ev.nowMs)) return { kind: "resolve", how: "time" };
    if (ev.actor !== open.actor || ev.friction) return { kind: "none" };
    const r = open.resolution;
    switch (r.kind) {
      case "visits": {
        const progress = open.progress + 1;
        return progress >= r.n ? { kind: "resolve", how: "met" } : { kind: "progress", progress };
      }
      case "item": {
        if (ev.action !== r.action) return { kind: "none" };
        const progress = open.progress + 1;
        return progress >= r.n ? { kind: "resolve", how: "met" } : { kind: "progress", progress };
      }
      case "quiet":
        return ev.nowMs - openedMs(open) >= r.hours * HOUR_MS
          ? { kind: "resolve", how: "met" } : { kind: "none" };
      case "time":
        return { kind: "none" };
    }
  }
  if (!ev.matchedAversion) return { kind: "none" };
  return {
    kind: "open",
    quirk_id: ev.matchedAversion.id,
    label: grudgeLabel(ev.quirkTitle ?? ev.matchedAversion.id),
    resolution: ev.quirkResolution ?? { kind: "visits", n: 2 },
  };
}
