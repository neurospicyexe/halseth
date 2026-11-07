// Sol's grudges: legible, finite, one open per (creature, actor). Pure, no DB.
// A grudge is Sol's right to say no at a crow's scale; it never touches trust.
import type { CreatureAction } from "../webmind/creatures.js";
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

function openedMs(open: OpenGrudge): number {
  return Date.parse(open.opened_at);
}

function limitHours(open: OpenGrudge): number {
  const r = open.resolution;
  return r.kind === "time" ? Math.min(r.hours, GRUDGE_MAX_HOURS) : GRUDGE_MAX_HOURS;
}

export function expired(open: OpenGrudge, nowMs: number): boolean {
  return nowMs - openedMs(open) >= limitHours(open) * HOUR_MS;
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
