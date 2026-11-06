// Librarian executors for basins that move (mig 0172; logic in webmind/basins.ts).
//
//   revise my basin <name>: <new description> because <kind> <id-prefix>   the companion, for their OWN basin
//   my basins                                                                names, status, causes, dates (no text)
//   basin moves waiting                                                      the caller's own revisions awaiting Raziel
//
// The caller is ALWAYS ctx.req.companion_id, never text. Witnessing is Raziel's door (Hearth + admin route),
// deliberately not a Librarian verb: the Librarian cannot tell Raziel from a companion.

import { ExecutorContext, ExecutorResult } from "./types.js";
import { parseReviseVerb, reviseBasin, listBasins, listWaiting, renderBasinLine, REVISE_TEACH, type BasinResult } from "../../webmind/basins.js";

function out(r: BasinResult): ExecutorResult {
  if (!r.ok) return { response_key: "witness", witness: r.message, ack: false, refused: true, code: r.code };
  return { response_key: "witness", ack: true, id: r.id, outcome: r.outcome, basin: r.basin, witness: r.message };
}

export async function execBasinRevise(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseReviseVerb(ctx.req.request);
  if (!p) {
    return { response_key: "witness", witness: `say: ${REVISE_TEACH}`, ack: false, refused: true, code: "bad_input" };
  }
  return out(await reviseBasin(ctx.env, { caller: ctx.req.companion_id, name: p.name, description: p.description, kind: p.kind, ref: p.ref }));
}

export async function execBasinsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await listBasins(ctx.env, ctx.req.companion_id);
  return { response_key: "data", data: { basins: rows.map(renderBasinLine), footer: REVISE_TEACH } };
}

export async function execBasinWaiting(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await listWaiting(ctx.env, ctx.req.companion_id);
  return { response_key: "data", data: { waiting: rows.map(renderBasinLine), footer: "Raziel witnesses on Hearth; the old words stay yours until then." } };
}
