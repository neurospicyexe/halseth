// Librarian executors for the imp tray (mig 0132, 2026-09-26).
//
// "my tray"                       -- this companion's drafts (journal + notes), newest first, with the
//                                    30-day {draft, kept, dropped} counts and the keep rate.
// "keep draft <id>" / "keep <id>" -- the draft becomes memory. "keep draft <id>: <new text>" rewrites it
//                                    first: the owner's words replace the clerk's.
// "drop draft <id>"               -- the draft never becomes memory (row stays, state = dropped).
//
// Everything routes through webmind/tray.ts, the same functions GET/POST /admin/tray use. Fields come
// from `context` JSON when present ({ id, kind?, content? }); the request string is parsed only as a
// fallback, and only for the id and the rewrite after a colon.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { listTray, reviewDraft, parseTrayKind, type TrayDecision } from "../../webmind/tray.js";

// "keep draft <id>: <text>" / "keep <id>" / "drop draft <id>". The id is the token after the verb
// (a full id or a prefix of 8+ chars); anything after the first colon is the rewrite.
const VERB_RE = /^(?:keep|drop)\s+(?:draft\s+)?([A-Za-z0-9_-]+)\s*(?::\s*([\s\S]+))?$/i;

export function parseTrayVerb(request: string): { id: string; content: string | null } | null {
  const m = VERB_RE.exec(request.trim());
  if (!m || !m[1]) return null;
  const content = m[2]?.trim();
  return { id: m[1], content: content && content.length > 0 ? content : null };
}

export async function execTrayRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ limit?: number }>(ctx.req.context);
  const view = await listTray(ctx.env, ctx.req.companion_id, p?.limit ?? undefined);
  return {
    response_key: "data",
    data: { tray: view.drafts, stats: view.stats, stats_line: view.stats_line },
    count: view.drafts.length,
  };
}

async function review(ctx: ExecutorContext, decision: TrayDecision): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string; ref_id?: string; kind?: string; content?: string; note_text?: string }>(ctx.req.context);
  const fromText = parseTrayVerb(ctx.req.request);
  const id = (p?.id ?? p?.ref_id ?? fromText?.id)?.trim();
  const kind = parseTrayKind(p?.kind);
  const content = decision === "kept" ? (p?.content ?? p?.note_text ?? fromText?.content ?? null) : null;
  const verb = decision === "kept" ? "keep" : "drop";
  if (!id) {
    return { error: `tray_${verb}_failed`, reason: `need { id, kind?${decision === "kept" ? ", content?" : ""} } -- or "${verb} draft <id>"` };
  }

  const r = await reviewDraft(ctx.env, { agent: ctx.req.companion_id, kind, id, decision, content });
  if (!r.ok) {
    if (r.reason === "bad_id") return { error: `tray_${verb}_failed`, reason: "id must be the full id or a prefix of at least 8 characters" };
    if (r.reason === "empty_content") return { error: "tray_keep_failed", reason: "a rewrite cannot be empty -- omit the colon to keep the draft as written" };
    return { response_key: "witness", witness: "no change (not found or not yours)", ack: false };
  }
  const already = r.previous_state === decision;
  const witness = decision === "kept"
    ? (r.rewritten ? `kept, in your words -- it is memory now (${r.kind} ${r.id})` : `kept -- it is memory now (${r.kind} ${r.id})`)
    : `dropped -- it never becomes memory (${r.kind} ${r.id})`;
  return {
    response_key: "witness",
    witness: already ? `${witness}; it already was` : witness,
    ack: true,
    id: r.id,
    kind: r.kind,
    decision: r.decision,
    rewritten: r.rewritten,
  };
}

export async function execTrayKeep(ctx: ExecutorContext): Promise<ExecutorResult> {
  return review(ctx, "kept");
}

export async function execTrayDrop(ctx: ExecutorContext): Promise<ExecutorResult> {
  return review(ctx, "dropped");
}
