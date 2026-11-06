// Librarian executor for `loss: <what>` / `loss for <companion>: <what>` (B63, mig 0174 companion_losses).
//
// Any companion (or Raziel, speaking through one, with context { logged_by: "raziel" }) may log a loss for
// a companion; with no name given it is the speaker's own. LOGGING NEVER CLOSES IT: the loss closes only
// when that companion authors a line naming it (webmind/losses.ts, the nightly pass).

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { parseLossVerb, logLoss } from "../../webmind/losses.js";

export async function execLossLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseLossVerb(ctx.req.request);
  if (!p) return { response_key: "witness", witness: "say: loss: <what>   or   loss for drevan: <what>", ack: false, refused: true, code: "bad_input" };
  const c = parseContext<{ logged_by?: string }>(ctx.req.context);
  const loggedBy = c?.logged_by === "raziel" ? "raziel" : ctx.req.companion_id;
  const r = await logLoss(ctx.env, { companion: p.companion ?? ctx.req.companion_id, what: p.what, loggedBy });
  if (!r.ok) return { response_key: "witness", witness: r.message, ack: false, refused: true, code: r.code };
  return {
    response_key: "witness", ack: true, id: r.id,
    witness: `held for ${r.companion} (loss ${r.id.slice(0, 8)}). It stays open until ${r.companion} writes a line naming it: a feeling, a journal line, or a note to Raziel. Logging it does not close it.`,
  };
}
