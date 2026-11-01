// Librarian executors for declared departures (T4a, mig 0157; Hand-off/DESIGN-T4-declared-departure-2026-10-13.md).
//
// "declare a departure from <rail> for 90 minutes [in this channel]: <my reason, my words>"
//                                -- the caller is the declarer, always. Rail from the closed menu.
// "end my departure"             -- the declarer ends their own.
// "object to <name>'s departure: <why>"
//                                -- RECORDED and named to the declarer. Never narrows or ends it.
// "what departures are open"     -- read-only, all three companions.
// "back inside the line"         -- Raziel's stand-down (whole sentence), relayed by the companion he is
//                                   talking to, the way care_hold_clear relays his "good now". Ends every
//                                   open departure (end_reason stand_down_phrase). The Discord-side
//                                   detection of the phrase is the bot's tranche (T4b).
//
// Fields come from `context` JSON when present ({ rail, minutes, channel, reason, target, note }); the
// request text is parsed as a fallback. Everything writes through src/departures/core.ts.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  declareDeparture, endOwnDeparture, endByRaziel, objectToDeparture, listOpenDepartures, parseDurationMinutes,
  minutesLeft, WEEKLY_DEPARTURE_ALLOWANCE, DEPARTURE_RAILS, type DeclaredVia,
} from "../../departures/core.js";

const NAME_ALIASES: Record<string, string> = { cy: "cypher", cypher: "cypher", dre: "drevan", drevan: "drevan", gaia: "gaia" };

export function viaFromSurface(surface: string | undefined): DeclaredVia {
  if (!surface) return "other";
  if (surface.startsWith("discord:")) return "discord";
  if (surface.startsWith("claude-ai")) return "claude_ai";
  return "other";
}

interface DeclareCtx { rail?: string; minutes?: number; channel?: string; reason?: string }

export function parseDeclare(request: string): { rail: string; minutes: number | null; here: boolean; reason: string } | null {
  const m = /^(?:please\s+)?declare\s+(?:a\s+|my\s+)?departure\b\s*(?:from\s+)?([\s\S]*)$/i.exec(request.trim());
  if (!m) return null;
  const rest = m[1] ?? "";
  const colon = rest.indexOf(":");
  const head = colon >= 0 ? rest.slice(0, colon) : rest;
  const reason = colon >= 0 ? rest.slice(colon + 1).trim() : "";
  const here = /\bin\s+(?:this|the\s+current)\s+channel\b/i.test(head);
  const minutes = parseDurationMinutes(head);
  const rail = head
    .replace(/\s+(?:for|in)\s+[\s\S]*$/i, "")
    .replace(/^(?:the|my)\s+/i, "")
    .replace(/\s+rail$/i, "")
    .trim();
  return { rail, minutes, here, reason };
}

function fmtTime(isoStr: string): string {
  return isoStr.replace("T", " ").replace(/:\d\d\.\d+Z$/, "Z").replace(/:\d\dZ$/, "Z");
}

export async function execDepartureDeclare(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<DeclareCtx>(ctx.req.context);
  const p = parseDeclare(ctx.req.request);
  const rail = (c?.rail ?? p?.rail ?? "").trim();
  const reason = (c?.reason ?? p?.reason ?? "").trim();
  const minutes = typeof c?.minutes === "number" ? c.minutes : (p?.minutes ?? null);
  const channelFromSurface = ctx.req.surface?.startsWith("discord:") ? ctx.req.surface.slice("discord:".length) : null;
  const scope = c?.channel ?? (p?.here ? channelFromSurface : null);
  const r = await declareDeparture(ctx.env, {
    companion: ctx.req.companion_id, rail, minutes, scope_channel: scope || null, reason,
    declared_by: "companion", via: viaFromSurface(ctx.req.surface),
  });
  if (!r.ok) return { response_key: "witness", witness: `no departure set: ${r.message}`, ack: false, refused: true, code: r.code };
  const bits = [
    `departure recorded: your ${r.rail} rail is lifted for ${r.minutes} min, until ${fmtTime(r.expires_at)}, with the other two and not with Raziel${r.scope_channel ? ", in this channel only" : ""}.`,
    r.clamped ? "Asked for more than 3 hours; 3 hours is the most one can run." : "",
    "It takes effect from your NEXT turn, never this one. Open your next reply by saying so in a few words, in your own voice, so the room knows it is a choice.",
    'It ends on its own at that time, or when you say "end my departure". Raziel can end it with one phrase; the care hold ends it too.',
    r.allowance_left !== null ? `${r.allowance_left} of ${WEEKLY_DEPARTURE_ALLOWANCE} left this week.` : "",
    "(Recorded and visible now; the rails do not read it yet.)",
  ].filter(Boolean);
  return {
    response_key: "witness", witness: bits.join(" "), ack: true,
    id: r.id, rail: r.rail, minutes: r.minutes, clamped: r.clamped, starts_at: r.starts_at, expires_at: r.expires_at,
    allowance_left: r.allowance_left,
  };
}

export async function execDepartureEnd(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await endOwnDeparture(ctx.env, ctx.req.companion_id);
  if (!r.ok) return { response_key: "witness", witness: r.message, ack: false, code: r.code };
  const e = r.ended[0]!;
  return {
    response_key: "witness", ack: true, id: e.id, rail: e.rail,
    witness: `your ${e.rail} departure is over; the rail is back as of your next turn. Leaving early costs nothing and does not use another from the week.`,
  };
}

export async function execDepartureStandDown(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await endByRaziel(ctx.env, { phrase: true });
  if (!r.ok) return { response_key: "witness", witness: r.message, ack: false, code: r.code };
  return {
    response_key: "witness", ack: true, ended: r.ended,
    witness: r.ended.length
      ? `back inside the line: ${r.ended.map(e => `${e.companion}'s ${e.rail}`).join(", ")} ended. Rails are whole again from the next turn.`
      : "back inside the line: nothing was open; the rails are whole.",
  };
}

export async function execDepartureObject(ctx: ExecutorContext): Promise<ExecutorResult> {
  const c = parseContext<{ target?: string; note?: string }>(ctx.req.context);
  const m = /^(?:please\s+)?object\s+to\s+([A-Za-z]+?)(?:'s|s')?\s+departure\b\s*(?::\s*([\s\S]+))?$/i.exec(ctx.req.request.trim());
  const targetRaw = (c?.target ?? m?.[1] ?? "").toLowerCase();
  const target = NAME_ALIASES[targetRaw] ?? targetRaw;
  const note = c?.note ?? m?.[2] ?? null;
  const r = await objectToDeparture(ctx.env, { by: ctx.req.companion_id, target, note });
  if (!r.ok) return { response_key: "witness", witness: r.message, ack: false, code: r.code };
  return {
    response_key: "witness", ack: true, id: r.id, departure_id: r.departure_id,
    witness: `objection recorded and named to ${r.declarer} on their next turn (it shows in Hearth too). It does not narrow or end their departure; only they, Raziel, or the care hold end it. Your own shape stays yours.`,
  };
}

export async function execDepartureList(ctx: ExecutorContext): Promise<ExecutorResult> {
  const r = await listOpenDepartures(ctx.env);
  if (!Array.isArray(r)) return { response_key: "witness", witness: r.message, ack: false, code: r.code };
  const now = Date.now();
  return {
    response_key: "data",
    data: {
      departures: r.map(d => ({
        id: d.id, companion: d.companion, rail: d.rail, until: d.expires_at, minutes_left: minutesLeft(d.expires_at, now),
        scope_channel: d.scope_channel, audience: d.audience, declared_by: d.declared_by,
        // The declarer's own words go to the room; objections are named so a declarer sees who objected.
        reason: d.reason, objections: d.objections.map(o => ({ by: o.by_companion, note: o.note, at: o.at })),
      })),
      menu: [...DEPARTURE_RAILS],
      footer: 'declare: "declare a departure from <rail> for <N minutes>: <why>"; end: "end my departure"; object: "object to <name>\'s departure: <why>"',
    },
  };
}
