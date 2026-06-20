// Librarian executors for the private interiority room (migration 0084).
//
// Security invariant: the owner is ALWAYS ctx.req.companion_id, which the Librarian has already
// authenticated against the caller's per-companion token (handleLibrarian rejects a companion_id
// that doesn't match the token). A companion therefore can never read, write, or disclose into
// another companion's room through this path -- the owner is not a caller-supplied field.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { insertInteriority, readInteriority, discloseInteriority } from "../../handlers/interiority.js";

// "write to my interiority" -- { content, mood?, tags? } in context.
export async function execInteriorityWrite(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ content?: string; text?: string; note?: string; mood?: string; tags?: string[] }>(ctx.req.context);
  // Accept content from structured payload; fall back to the raw context string, then the request.
  const content =
    p?.content ?? p?.text ?? p?.note ?? (ctx.req.context && !p ? ctx.req.context : undefined);
  if (!content || !content.trim()) {
    return { error: "interiority_write_failed", reason: "missing content (pass { content } in context)" };
  }
  const out = await insertInteriority(ctx.env, ctx.req.companion_id, content, p?.mood ?? null, p?.tags ?? null);
  return { response_key: "witness", witness: "held, sealed", ack: true, id: out.id };
}

// "read my interiority" -- optional { limit } in context.
export async function execInteriorityRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ limit?: number }>(ctx.req.context);
  const rows = await readInteriority(ctx.env, ctx.req.companion_id, p?.limit ?? 50);
  return {
    response_key: "interiority",
    interiority: rows,
    meta: { operation: "interiority_read", companion_id: ctx.req.companion_id, count: rows.length },
  };
}

// "disclose interiority <id>" -- the companion chooses to surface ONE entry. { id } in context.
export async function execInteriorityDisclose(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string }>(ctx.req.context);
  if (!p?.id) {
    return { error: "interiority_disclose_failed", reason: "missing id (pass { id } in context)" };
  }
  const result = await discloseInteriority(ctx.env, ctx.req.companion_id, p.id);
  if (!result.disclosed) {
    return { response_key: "witness", witness: "no change (not found, not yours, or already disclosed)", ack: false };
  }
  return { response_key: "witness", witness: "disclosed", ack: true, id: p.id, disclosed_at: result.disclosed_at };
}
