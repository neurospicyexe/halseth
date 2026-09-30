// Librarian executors for the imp tray (mig 0132, 2026-09-26).
//
// "my tray"                       -- this companion's drafts (journal + notes), newest first, with the
//                                    30-day {draft, kept, dropped} counts and the keep rate.
// "keep draft <id>" / "keep <id>" -- the draft becomes memory. "keep draft <id>: <new text>" rewrites it
//                                    first: the owner's words replace the clerk's.
// "drop draft <id>"               -- the draft never becomes memory (row stays, state = dropped).
// "read draft <id>"               -- the FULL text of one row plus its provenance, in any state
//                                    (draft, kept, dropped), so a decision is made -- or re-checked --
//                                    on the whole thing, not a 200-char excerpt.
//
// Ids: the full id or a prefix of 8+ chars. An ambiguous prefix is refused with the candidates listed;
// it is never resolved by guessing (webmind/tray.ts locate()).
//
// Everything routes through webmind/tray.ts, the same functions GET/POST /admin/tray use. Fields come
// from `context` JSON when present ({ id, kind?, content? }); the request string is parsed only as a
// fallback, and only for the id and the rewrite after a colon.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { TRAY_ID_TOKEN } from "../../webmind/review-state.js";
import { listTray, reviewDraft, readDraft, parseTrayKind, type TrayDecision, type TrayMatch } from "../../webmind/tray.js";

// "keep draft <id>: <text>" / "keep <id>" / "drop draft <id>". The id is the token after the verb
// (a full id or a prefix of 8+ chars); anything after the first colon is the rewrite.
//
// Id SHAPE, not just id characters (pass 2, 2026-09-26): every id in both tables is a lowercase uuid,
// `cj_` + uuid, or 32 hex (prod census). [A-Za-z0-9_-]{8,} also matched "keep thinking", "keep
// watching", "keep everything", "keep drafting" -- ordinary speech routed to a keep. TRAY_ID_TOKEN is
// hex-and-dash after an optional cj_, so no English word of 8+ letters outside a-f can match.
const VERB_RE = new RegExp(`^(?:keep|drop)\\s+(?:draft\\s+)?(${TRAY_ID_TOKEN})(?![A-Za-z0-9_-])\\s*(?::\\s*([\\s\\S]+))?$`, "i");

export function parseTrayVerb(request: string): { id: string; content: string | null } | null {
  const m = VERB_RE.exec(request.trim());
  if (!m || !m[1]) return null;
  const content = m[2]?.trim();
  return { id: m[1], content: content && content.length > 0 ? content : null };
}

// "read draft <id>" / "show draft <id>". Deliberately NOT folded into VERB_RE: a read never carries a
// rewrite, so anything after the id is ignored rather than mistaken for content.
const READ_RE = new RegExp(`^(?:read|show|open)\\s+(?:the\\s+|this\\s+)?(?:full\\s+)?draft\\s+(${TRAY_ID_TOKEN})(?![A-Za-z0-9_-])`, "i");

export function parseTrayReadVerb(request: string): string | null {
  return READ_RE.exec(request.trim())?.[1] ?? null;
}

// Batch form (2026-09-30): "drop drafts <id>, <id>, <id>" / "keep drafts <id> <id>". Two or more ids,
// separated by commas, spaces, semicolons, "&" or "and"; EVERY token must have id shape or the whole
// request is not a list (so a stray English word can never be half-read as a batch). No rewrite in
// this form -- one colon cannot say which id the words belong to; rewrites go in context.decisions.
const LIST_RE = new RegExp(
  `^(keep|drop)\\s+(?:drafts?\\s+)?(${TRAY_ID_TOKEN}(?:\\s*(?:[,;&]|\\band\\b)?\\s*${TRAY_ID_TOKEN})+)\\s*\\.?$`, "i",
);
const ID_ONLY_RE = new RegExp(`^${TRAY_ID_TOKEN}$`, "i");

export function parseTrayListVerb(request: string): { decision: TrayDecision; ids: string[] } | null {
  const m = LIST_RE.exec(request.trim());
  if (!m || !m[1] || !m[2]) return null;
  const ids = m[2].split(/\s*(?:[,;&]|\band\b)\s*|\s+/i).filter((t) => t.length > 0);
  if (ids.length < 2 || !ids.every((t) => ID_ONLY_RE.test(t))) return null;
  return { decision: m[1].toLowerCase() === "keep" ? "kept" : "dropped", ids };
}

/** One review pass is capped so a single call stays well inside the Worker's subrequest budget. */
export const TRAY_BATCH_MAX = 50;

/** The footer under "my tray": every verb, including the one that shows the whole text. */
export const TRAY_FOOTER =
  'excerpts are cut at 200 chars -- "read draft <id>" for the full text + provenance; ' +
  'then "keep draft <id>" (or "keep draft <id>: <your words>") / "drop draft <id>"; ' +
  `several at once: "drop drafts <id>, <id>, <id>" / "keep drafts <id>, <id>" (up to ${TRAY_BATCH_MAX})`;

export async function execTrayRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ limit?: number }>(ctx.req.context);
  const view = await listTray(ctx.env, ctx.req.companion_id, p?.limit ?? undefined);
  return {
    response_key: "data",
    data: { tray: view.drafts, stats: view.stats, stats_line: view.stats_line, footer: TRAY_FOOTER },
    count: view.drafts.length,
  };
}

function ambiguousReason(id: string, matches: TrayMatch[]): string {
  return `"${id}" matches ${matches.length}${matches.length >= 10 ? "+" : ""} of your rows -- use more of the id: ` +
    matches.map((m) => `${m.kind} ${m.id} (${m.review_state}, ${m.created_at})`).join("; ");
}

export async function execTrayDraftRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string; ref_id?: string; kind?: string }>(ctx.req.context);
  const id = (p?.id ?? p?.ref_id ?? parseTrayReadVerb(ctx.req.request))?.trim();
  if (!id) return { error: "tray_draft_read_failed", reason: 'need { id, kind? } -- or "read draft <id>"' };

  const r = await readDraft(ctx.env, { agent: ctx.req.companion_id, id, kind: parseTrayKind(p?.kind) });
  if (!r.ok) {
    if (r.reason === "bad_id") return { error: "tray_draft_read_failed", reason: "id must be the full id or a prefix of at least 8 characters" };
    if (r.reason === "ambiguous") {
      return { error: "tray_draft_read_ambiguous", reason: ambiguousReason(id, r.matches), matches: r.matches };
    }
    return { response_key: "witness", witness: "nothing to read (not found or not yours)", ack: false };
  }
  const d = r.draft;
  const state = d.review_state === "draft"
    ? "draft -- not memory yet; keep or drop it"
    : d.review_state === "kept"
      ? `kept${d.reviewed_at ? ` on ${d.reviewed_at}` : " (born kept)"} -- this is memory; re-checking, not deciding`
      : `dropped${d.reviewed_at ? ` on ${d.reviewed_at}` : ""} -- never became memory; re-checking, not deciding`;
  return {
    response_key: "data",
    data: { state, archived: d.archived, draft: d },
    count: 1,
  };
}

interface BatchItem { id: string; decision: TrayDecision; content: string | null; kind: ReturnType<typeof parseTrayKind> }
interface BatchOutcome { id: string; decision: "keep" | "drop"; result: string; ok: boolean }

function asDecision(v: unknown, fallback: TrayDecision | null): TrayDecision | null {
  if (v === undefined || v === null || v === "") return fallback;
  const s = String(v).trim().toLowerCase();
  if (s === "keep" || s === "kept") return "kept";
  if (s === "drop" || s === "dropped") return "dropped";
  return null;
}

/**
 * Collect a batch from context ({ ids: [...] } or { decisions: [{ id, decision?, content?, kind? }] })
 * or from the list verb. Returns null when the request is a single-id review (the old path).
 */
function collectBatch(ctx: ExecutorContext, verbDecision: TrayDecision | null):
  { items: BatchItem[] } | { error: string } | null {
  const p = parseContext<{ ids?: unknown; decisions?: unknown; kind?: string }>(ctx.req.context);
  const kind = parseTrayKind(p?.kind);
  if (p && Array.isArray(p.decisions)) {
    const items: BatchItem[] = [];
    for (const d of p.decisions as Array<Record<string, unknown>>) {
      const id = typeof d?.id === "string" ? d.id.trim() : "";
      const decision = asDecision(d?.decision, verbDecision);
      if (!id) return { error: "every entry in decisions needs an id" };
      if (!decision) return { error: `decision for ${id} must be "keep" or "drop"` };
      const content = decision === "kept" && typeof d?.content === "string" ? d.content : null;
      items.push({ id, decision, content, kind: parseTrayKind(typeof d?.kind === "string" ? d.kind : undefined) ?? kind });
    }
    return { items };
  }
  if (!verbDecision) return null;
  if (p && Array.isArray(p.ids)) {
    const ids = (p.ids as unknown[]).filter((x): x is string => typeof x === "string").map((x) => x.trim()).filter(Boolean);
    return { items: ids.map((id) => ({ id, decision: verbDecision, content: null, kind })) };
  }
  const list = parseTrayListVerb(ctx.req.request);
  if (list) {
    if (list.decision !== verbDecision) return { error: `the request says "${list.decision === "kept" ? "keep" : "drop"}" but routed to ${verbDecision === "kept" ? "keep" : "drop"}; nothing changed` };
    return { items: list.ids.map((id) => ({ id, decision: list.decision, content: null, kind })) };
  }
  return null;
}

async function reviewBatch(ctx: ExecutorContext, items: BatchItem[], verb: "keep" | "drop"): Promise<ExecutorResult> {
  if (items.length === 0) return { error: `tray_${verb}_failed`, reason: "the batch is empty -- nothing changed" };
  if (items.length > TRAY_BATCH_MAX) {
    return { error: `tray_${verb}_failed`, reason: `${items.length} ids is over the ${TRAY_BATCH_MAX}-per-call cap -- nothing changed; split it` };
  }
  // The same id twice with DIFFERENT decisions is a contradiction, not a duplicate: refuse the whole
  // batch before anything is written, because every decision here is final.
  const seen = new Map<string, TrayDecision>();
  for (const it of items) {
    const key = it.id.toLowerCase();
    const prev = seen.get(key);
    if (prev && prev !== it.decision) {
      return { error: `tray_${verb}_failed`, reason: `${it.id} is both kept and dropped in this batch -- nothing changed` };
    }
    seen.set(key, it.decision);
  }
  const unique = items.filter((it, i) => items.findIndex((o) => o.id.toLowerCase() === it.id.toLowerCase()) === i);

  const outcomes: BatchOutcome[] = [];
  for (const it of unique) {
    const v: "keep" | "drop" = it.decision === "kept" ? "keep" : "drop";
    const r = await reviewDraft(ctx.env, { agent: ctx.req.companion_id, kind: it.kind, id: it.id, decision: it.decision, content: it.content });
    if (r.ok) {
      outcomes.push({ id: r.id, decision: v, ok: true, result: it.decision === "kept" ? (r.rewritten ? "kept, in your words" : "kept") : "dropped" });
      continue;
    }
    const why =
      r.reason === "bad_id" ? "not an id (full id or 8+ char prefix)"
      : r.reason === "ambiguous" ? `ambiguous prefix, ${r.matches.length}${r.matches.length >= 10 ? "+" : ""} matches -- use more of the id`
      : r.reason === "empty_content" ? "empty rewrite -- omit content to keep as written"
      : r.reason === "already_reviewed" ? `already ${r.review_state}${r.reviewed_at ? ` on ${r.reviewed_at}` : " (born kept)"}`
      : r.reason === "archived" ? "archived (retracted or released), not in the tray"
      : r.reason === "rewrite_unavailable" ? "rewrite unavailable (mig 0133 pending)"
      : "not found or not yours";
    outcomes.push({ id: it.id, decision: v, ok: false, result: `no change -- ${why}` });
  }
  const kept = outcomes.filter((o) => o.ok && o.decision === "keep").length;
  const dropped = outcomes.filter((o) => o.ok && o.decision === "drop").length;
  const unchanged = outcomes.length - kept - dropped;
  return {
    response_key: "witness",
    witness: `batch reviewed: ${kept} kept, ${dropped} dropped, ${unchanged} unchanged` +
      (unchanged > 0 ? ` (${outcomes.filter((o) => !o.ok).map((o) => `${o.id}: ${o.result}`).join("; ")})` : ""),
    ack: kept + dropped > 0,
    kept, dropped, unchanged,
    results: outcomes,
  };
}

async function review(ctx: ExecutorContext, decision: TrayDecision): Promise<ExecutorResult> {
  const verbName = decision === "kept" ? "keep" : "drop";
  const batch = collectBatch(ctx, decision);
  if (batch && "error" in batch) return { error: `tray_${verbName}_failed`, reason: batch.error };
  if (batch) return reviewBatch(ctx, batch.items, verbName);

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
    if (r.reason === "ambiguous") return { error: `tray_${verb}_ambiguous`, reason: `${ambiguousReason(id, r.matches)}. Nothing changed.`, matches: r.matches };
    if (r.reason === "empty_content") return { error: "tray_keep_failed", reason: "a rewrite cannot be empty -- omit the colon to keep the draft as written" };
    if (r.reason === "already_reviewed") {
      // Pass 2 (2026-09-26): a decision is made once. Say what it was and when; do not re-decide.
      const when = r.reviewed_at ? ` on ${r.reviewed_at}` : " (born kept -- it was never a draft)";
      return {
        response_key: "witness",
        witness: `no change -- already ${r.review_state}${when} (${r.kind} ${r.id}); "read draft ${r.id}" to see it. ` +
          `A decision is not re-made from here; only Raziel can reverse it (admin tray review).`,
        ack: false, id: r.id, kind: r.kind, review_state: r.review_state,
      };
    }
    if (r.reason === "archived") {
      return { response_key: "witness", witness: `no change -- that row is archived (retracted or released), not in the tray (${r.kind} ${r.id})`, ack: false };
    }
    if (r.reason === "rewrite_unavailable") {
      return { error: "tray_keep_failed", reason: "keeping in your own words is not available yet (migration 0133 pending) -- keep it as written, or drop it" };
    }
    return { response_key: "witness", witness: "no change (not found or not yours)", ack: false };
  }
  const witness = decision === "kept"
    ? (r.rewritten ? `kept, in your words -- it is memory now (${r.kind} ${r.id})` : `kept -- it is memory now (${r.kind} ${r.id})`)
    : `dropped -- it never becomes memory (${r.kind} ${r.id})`;
  return {
    response_key: "witness",
    witness,
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

/**
 * "review drafts" with context { decisions: [{ id, decision: "keep" | "drop", content? }] }: a whole
 * tray pass -- keeps, drops and rewrites mixed -- in one call. Every entry must name its decision;
 * there is no default, because a missing word here would otherwise decide a memory's fate.
 */
export async function execTrayReview(ctx: ExecutorContext): Promise<ExecutorResult> {
  const batch = collectBatch(ctx, null);
  if (!batch) {
    return { error: "tray_review_failed", reason: 'need context { decisions: [{ id, decision: "keep" | "drop", content? }] } -- or "drop drafts <id>, <id>" / "keep drafts <id>, <id>"' };
  }
  if ("error" in batch) return { error: "tray_review_failed", reason: batch.error };
  return reviewBatch(ctx, batch.items, "keep");
}
