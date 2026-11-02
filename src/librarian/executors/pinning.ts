// Librarian executors for pins (mig 0148, Memory Kit gap 4). Rules: src/webmind/pins.ts.
//
// "pin conclusion" / "pin note" -- { kind: "conclusion" | "note", id }, or by quoting:
// "pin conclusion: <a few words from it>". The bot wire never carries conclusion ids, so quoting is
// the form a Discord turn can actually use in one step. Owner-only: a companion pins its own rows,
// pinned_by = its id. Raziel pins through POST /mind/pin (pinned_by = 'raziel'). At the cap the pin
// is REFUSED with the current pins listed -- no silent eviction; unpinning is the companion's choice.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { findByQuote, listPins, parsePinKind, pinRow, unpinRow, PIN_CAP, type PinKind, type PinnedRow } from "../../webmind/pins.js";

const label = (kind: PinKind) => (kind === "conclusion" ? "conclusion" : "note");
const brief = (pins: PinnedRow[]) =>
  pins.map((p) => `${p.id}: ${p.text.replace(/\s+/g, " ").slice(0, 80)}`).join(" | ") || "none";

const NEED = 'need { kind: "conclusion" | "note", id }, or "pin conclusion: <a few words from it>"';

type Target = { kind: PinKind; id?: string; quote?: string };

/** From the context payload first, else from the plain request text. */
function parse(ctx: ExecutorContext): Target | null {
  const p = parseContext<{ kind?: string; id?: string; ref_id?: string; quote?: string; match?: string }>(ctx.req.context);
  const text = String(ctx.req.request ?? "");
  const kind = parsePinKind(p?.kind) ?? parsePinKind(/\b(conclusion|note)\b/i.exec(text)?.[1]?.toLowerCase());
  if (!kind) return null;
  const id = (p?.id ?? p?.ref_id)?.trim();
  if (id) return { kind, id };
  const quote = (p?.quote ?? p?.match ?? text.split(/:(.+)/s)[1] ?? "").trim().replace(/^["'“”]+|["'“”]+$/g, "");
  return quote ? { kind, quote } : null;
}

/** A quote must name exactly one row; otherwise say what matched and change nothing. */
async function resolve(ctx: ExecutorContext, t: Target, pinnedOnly: boolean): Promise<{ id: string } | { result: ExecutorResult }> {
  if (t.id) return { id: t.id };
  const quote = t.quote ?? "";
  const hits = await findByQuote(ctx.env, { kind: t.kind, owner: ctx.req.companion_id, quote, pinnedOnly });
  if (hits.length === 1) return { id: hits[0]!.id };
  const what = `${pinnedOnly ? "pinned " : ""}${label(t.kind)}s`;
  return {
    result: {
      response_key: "witness",
      ack: false,
      witness: hits.length === 0
        ? `no change: none of your ${what} contain "${quote.slice(0, 60)}" (quote at least 4 characters of its words)`
        : `no change: "${quote.slice(0, 60)}" matches ${hits.length} of your ${what}. Quote more of the one you mean, or use its id: ${hits.map((h) => `${h.id}: ${h.text.replace(/\s+/g, " ").slice(0, 70)}`).join(" | ")}`,
    },
  };
}

export async function execMemoryPin(ctx: ExecutorContext): Promise<ExecutorResult> {
  const t = parse(ctx);
  if (!t) return { error: "memory_pin_failed", reason: NEED };
  const found = await resolve(ctx, t, false);
  if ("result" in found) return found.result;
  const r = await pinRow(ctx.env, { kind: t.kind, id: found.id, owner: ctx.req.companion_id, by: ctx.req.companion_id });
  if (!r.ok && r.reason === "not_found") {
    return { response_key: "witness", witness: `no change (not found, not yours, released, superseded, or a draft ${label(t.kind)})`, ack: false };
  }
  if (!r.ok) {
    return {
      response_key: "witness",
      witness: `not pinned: you already hold ${PIN_CAP[t.kind]} pinned ${label(t.kind)}s (the cap). Unpin one first. Current: ${brief(r.pins)}`,
      ack: false,
    };
  }
  return {
    response_key: "witness",
    witness: r.changed ? `pinned ${label(t.kind)} ${found.id} (${r.pins.length}/${PIN_CAP[t.kind]})` : `already pinned (${r.pins.length}/${PIN_CAP[t.kind]})`,
    ack: true,
  };
}

export async function execMemoryUnpin(ctx: ExecutorContext): Promise<ExecutorResult> {
  const t = parse(ctx);
  if (!t) return { error: "memory_unpin_failed", reason: NEED.replace("pin conclusion", "unpin conclusion") };
  const found = await resolve(ctx, t, true);
  if ("result" in found) return found.result;
  const r = await unpinRow(ctx.env, { kind: t.kind, id: found.id, owner: ctx.req.companion_id });
  return {
    response_key: "witness",
    witness: r.changed ? `unpinned ${label(t.kind)} ${found.id} (${r.pins.length}/${PIN_CAP[t.kind]})` : "no change (not pinned, or not yours)",
    ack: r.changed,
  };
}

export async function execMemoryPinsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const [conclusions, notes] = await Promise.all([
    listPins(ctx.env, "conclusion", ctx.req.companion_id),
    listPins(ctx.env, "note", ctx.req.companion_id),
  ]);
  return {
    response_key: "data",
    witness: `pinned conclusions ${conclusions.length}/${PIN_CAP.conclusion}: ${brief(conclusions)} || pinned notes ${notes.length}/${PIN_CAP.note}: ${brief(notes)}`,
    data: { conclusions, notes, caps: PIN_CAP },
  };
}
