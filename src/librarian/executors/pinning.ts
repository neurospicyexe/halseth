// Librarian executors for pins (mig 0148, Memory Kit gap 4). Rules: src/webmind/pins.ts.
//
// "pin conclusion" / "pin note" -- { kind: "conclusion" | "note", id }. Owner-only: a companion pins
// its own rows, pinned_by = its id. Raziel pins through POST /mind/pin (pinned_by = 'raziel').
// At the cap the pin is REFUSED with the current pins listed -- no silent eviction; unpinning one is
// the companion's choice, not the system's.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { listPins, parsePinKind, pinRow, unpinRow, PIN_CAP, type PinKind, type PinnedRow } from "../../webmind/pins.js";

const label = (kind: PinKind) => (kind === "conclusion" ? "conclusion" : "note");
const brief = (pins: PinnedRow[]) =>
  pins.map((p) => `${p.id}: ${p.text.replace(/\s+/g, " ").slice(0, 80)}`).join(" | ") || "none";

function parse(ctx: ExecutorContext): { kind: PinKind; id: string } | null {
  const p = parseContext<{ kind?: string; id?: string; ref_id?: string }>(ctx.req.context);
  const kind = parsePinKind(p?.kind);
  const id = (p?.id ?? p?.ref_id)?.trim();
  return kind && id ? { kind, id } : null;
}

export async function execMemoryPin(ctx: ExecutorContext): Promise<ExecutorResult> {
  const a = parse(ctx);
  if (!a) return { error: "memory_pin_failed", reason: 'need { kind: "conclusion" | "note", id }' };
  const r = await pinRow(ctx.env, { ...a, owner: ctx.req.companion_id, by: ctx.req.companion_id });
  if (!r.ok && r.reason === "not_found") {
    return { response_key: "witness", witness: `no change (not found, not yours, released, superseded, or a draft ${label(a.kind)})`, ack: false };
  }
  if (!r.ok) {
    return {
      response_key: "witness",
      witness: `not pinned: you already hold ${PIN_CAP[a.kind]} pinned ${label(a.kind)}s (the cap). Unpin one first. Current: ${brief(r.pins)}`,
      ack: false,
    };
  }
  return {
    response_key: "witness",
    witness: r.changed ? `pinned ${label(a.kind)} ${a.id} (${r.pins.length}/${PIN_CAP[a.kind]})` : `already pinned (${r.pins.length}/${PIN_CAP[a.kind]})`,
    ack: true,
  };
}

export async function execMemoryUnpin(ctx: ExecutorContext): Promise<ExecutorResult> {
  const a = parse(ctx);
  if (!a) return { error: "memory_unpin_failed", reason: 'need { kind: "conclusion" | "note", id }' };
  const r = await unpinRow(ctx.env, { ...a, owner: ctx.req.companion_id });
  return {
    response_key: "witness",
    witness: r.changed ? `unpinned ${label(a.kind)} ${a.id} (${r.pins.length}/${PIN_CAP[a.kind]})` : "no change (not pinned, or not yours)",
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
