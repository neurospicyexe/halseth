// Librarian executors: Gaia's authored line events and the sibling disagreement verb (B63; webmind/line-events.ts).
// The caller is ALWAYS ctx.req.companion_id, never text.

import { ExecutorContext, ExecutorResult } from "./types.js";
import {
  parseLineVerb, applyLineEvent, LINE_VERB_TEACH, DISAGREE_RE, SETTLED_RE, openDisagreement, settleDisagreement,
} from "../../webmind/line-events.js";

const refuse = (witness: string, code: string): ExecutorResult => ({ response_key: "witness", witness, ack: false, refused: true, code });

export async function execLineEvent(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseLineVerb(ctx.req.request);
  if (!p) return refuse(`say: ${LINE_VERB_TEACH}`, "bad_input");
  const r = await applyLineEvent(ctx.env, ctx.req.companion_id, p.verb, p.arg);
  return r.ok ? { response_key: "witness", ack: true, witness: r.message } : refuse(r.message, r.code);
}

export async function execDisagreeOpen(ctx: ExecutorContext): Promise<ExecutorResult> {
  const m = DISAGREE_RE.exec(ctx.req.request ?? "");
  if (!m) return refuse("say: disagree with <sibling>: <what>", "bad_input");
  const r = await openDisagreement(ctx.env, ctx.req.companion_id, m[1]!.toLowerCase(), m[2] ?? "");
  return r.ok ? { response_key: "witness", ack: true, witness: r.message, ...(r.id ? { id: r.id } : {}) } : refuse(r.message, r.code);
}

export async function execDisagreeSettle(ctx: ExecutorContext): Promise<ExecutorResult> {
  const m = SETTLED_RE.exec(ctx.req.request ?? "");
  if (!m) return refuse("say: settled with <sibling>", "bad_input");
  const r = await settleDisagreement(ctx.env, ctx.req.companion_id, m[1]!.toLowerCase());
  return r.ok ? { response_key: "witness", ack: true, witness: r.message } : refuse(r.message, r.code);
}
