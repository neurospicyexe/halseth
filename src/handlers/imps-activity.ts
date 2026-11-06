// src/handlers/imps-activity.ts
//
// GET /mind/imps/activity -- the Imps page's one read (Hearth). Read-only, ADMIN_SECRET Bearer.
//
// Raziel-facing, so it carries the lane's rules: a reply ride's `trigger` holds his mood/spoons/pain and is
// NEVER returned (every row is mapped to a plain phrase here); open imp lines never appear (only a per-companion
// COUNT); Hex lines never appear at all, open or kept; no per-companion tally of asks (events, not totals).

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { countImpWaitingByCompanion, loadKeptImpLines, type KeptImpLine } from "../ledger/store.js";

function json(d: unknown, s = 200): Response {
  return new Response(JSON.stringify(d), { status: s, headers: { "Content-Type": "application/json" } });
}

export const IMP_NAMES = ["iris", "nimbus", "hex", "mossling", "rock"] as const;
const RECENT_LIMIT = 40;
const KEPT_LIMIT = 20;

export interface ImpOuting { imp: string; companion_id: string; kind: "errand" | "reply"; errand: string | null; created_at: string }

/**
 * Pure. The plain phrase for an errand trigger (`errand:<function>`), or null for a reply ride.
 * Errands log `errand:<ledger function>`; Iris's cooling marker and Mossling's care-lane check share `flag`,
 * so the imp disambiguates. Anything unrecognised is "ran an errand".
 */
export function errandPhrase(imp: string, trigger: string | null): string | null {
  if (typeof trigger !== "string" || !trigger.startsWith("errand:")) return null;
  const fn = trigger.slice("errand:".length);
  switch (fn) {
    case "gap-reader": return "checked for gaps";
    case "pattern-counter": return "counted loops";
    case "fetch": return imp === "hex" ? "left a pointer" : imp === "rock" ? "fetched" : "ran an errand";
    case "salt": return imp === "hex" ? "left a pointer" : "ran an errand";
    case "sort": return "sorted the tray";
    case "tend": return "tended Sol";
    case "flag": return imp === "iris" ? "marked cooling interests" : imp === "mossling" ? "checked the care lane" : "ran an errand";
    default: return "ran an errand";
  }
}

export function toOuting(r: { imp: string; companion_id: string; trigger: string | null; created_at: string }): ImpOuting {
  const errand = errandPhrase(r.imp, r.trigger);
  return { imp: r.imp, companion_id: r.companion_id, kind: errand === null ? "reply" : "errand", errand, created_at: r.created_at };
}

export async function getImpsActivity(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;

  try {
    const rows = await env.DB.prepare(
      "SELECT imp, companion_id, trigger, created_at FROM imp_activations ORDER BY created_at DESC, id DESC LIMIT ?",
    ).bind(RECENT_LIMIT).all<{ imp: string; companion_id: string; trigger: string | null; created_at: string }>();
    const recent = (rows.results ?? []).map(toOuting);

    // Newest row per imp, from its own query: the 40-row window may not reach a quiet imp.
    const last_by_imp: Record<string, Pick<ImpOuting, "created_at" | "companion_id" | "kind" | "errand"> | null> = {};
    for (const imp of IMP_NAMES) {
      const r = await env.DB.prepare(
        "SELECT imp, companion_id, trigger, created_at FROM imp_activations WHERE imp = ? ORDER BY created_at DESC, id DESC LIMIT 1",
      ).bind(imp).first<{ imp: string; companion_id: string; trigger: string | null; created_at: string }>();
      if (!r) { last_by_imp[imp] = null; continue; }
      const o = toOuting(r);
      last_by_imp[imp] = { created_at: o.created_at, companion_id: o.companion_id, kind: o.kind, errand: o.errand };
    }

    const waiting = await countImpWaitingByCompanion(env);
    const kept: KeptImpLine[] = (await loadKeptImpLines(env, KEPT_LIMIT)).map((k) => ({
      id: k.id, imp: k.imp, companion_id: k.companion_id, content: k.content, state_at: k.state_at,
    }));

    return json({ recent, last_by_imp, waiting, kept });
  } catch (e) {
    console.error("[mind/imps/activity] read error", String(e));
    return json({ error: "Internal server error" }, 500);
  }
}
