// Sol's deterministic appraisal of a tend: pure, no DB, no raw text.
import type { CareFit } from "../webmind/sol-care.js";
import type { CreatureAction } from "../webmind/creatures.js";

export type Via = "hand" | "errand" | "imp" | "autonomous" | "appear" | "backfill";

export const VIA_WEIGHT: Record<Via, number> = {
  hand: 1.0, errand: 0.6, imp: 0.3, autonomous: 0.2, appear: 0.05, backfill: 0.2,
};

const VIAS = new Set<string>(Object.keys(VIA_WEIGHT));

export function resolveVia(raw: unknown, actor: string): Via {
  if (typeof raw === "string" && VIAS.has(raw)) return raw as Via;
  if (actor === "sol") return "appear";
  if (actor === "imp") return "imp";
  return "autonomous";
}

export type TimeBand = "dawn" | "day" | "dusk" | "roost";

const CHI_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago", hour: "numeric", hour12: false,
});

export function timeBand(nowMs: number): TimeBand {
  const part = CHI_HOUR.formatToParts(new Date(nowMs)).find((p) => p.type === "hour");
  let h = Number(part?.value ?? 0);
  if (h === 24) h = 0;
  if (h >= 5 && h <= 7) return "dawn";
  if (h >= 8 && h <= 16) return "day";
  if (h >= 17 && h <= 20) return "dusk";
  return "roost";
}

export interface QuirkTrigger { actor?: string; action?: CreatureAction; time_band?: TimeBand; fit?: CareFit }

export interface ActiveQuirk {
  id: string;
  kind: "aversion" | "preference";
  trigger: QuirkTrigger;
  target_actor: string | null;
}

export interface Appraisal {
  valence: number;
  arousal: number;
  friction: boolean;
  tags: string[];
  weight: number;
  matched: ActiveQuirk[];
}

export function triggerMatches(
  t: QuirkTrigger,
  ev: { actor: string; action: string; time_band: TimeBand; fit: CareFit | null },
): boolean {
  const keys = (["actor", "action", "time_band", "fit"] as const).filter((k) => t[k] !== undefined);
  if (keys.length === 0) return false;
  return keys.every((k) => t[k] === ev[k]);
}

const FIT_VA: Record<CareFit, [number, number]> = {
  met: [0.8, 0.6], welcome: [0.5, 0.4], full: [0.1, 0.2], drowsy: [-0.2, 0.3], settled: [0, 0.1],
};

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

export function appraise(input: {
  actor: string; action: CreatureAction | "appear"; fit: CareFit | null; via: Via;
  nowMs: number; quirks: ActiveQuirk[]; recentSame: number;
}): Appraisal {
  const band = timeBand(input.nowMs);
  let [valence, arousal] = input.fit ? FIT_VA[input.fit] : [0, 0.1];
  const tags: string[] = [input.action, input.actor];
  if (input.fit) tags.push(input.fit);
  tags.push(band);

  const ev = { actor: input.actor, action: input.action, time_band: band, fit: input.fit };
  const matched = input.quirks.filter(
    (q) => triggerMatches(q.trigger, ev) && (q.target_actor === null || q.target_actor === input.actor),
  );
  let friction = false;
  for (const q of matched) {
    if (q.kind === "aversion") { valence -= 0.6; friction = true; } else valence += 0.3;
    tags.push(`quirk:${q.id}`);
  }
  if (input.recentSame >= 2) tags.push("repeat");

  return {
    valence: clamp(valence, -1, 1), arousal: clamp(arousal, 0, 1), friction, tags,
    weight: VIA_WEIGHT[input.via], matched,
  };
}
