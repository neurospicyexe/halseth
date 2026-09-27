// Librarian executors for the ledger lane (mig 0134, 2026-09-26). Owner-only: the acting companion
// reads and acts on entries ABOUT ITSELF (companion_id = ctx.req.companion_id on every read and UPDATE).
//
// "my ledger"                        -- open entries about me, newest first, each line verbatim with
//                                       its mark (a clerk record is never shown as my words).
// "keep ledger <id>"                 -- path 1: a sourced fact kept as written. It stays a ledger line.
// "keep ledger <id>: <my words>"     -- path 2: my OWN words go into my journal (kept, source
//                                       'tray_rewrite', external_id 'ledger:<id>'); the ledger row keeps
//                                       its original line and records the journal id.
// "drop ledger <id>"                 -- never recalled; Second Brain purges the chunk.
//
// Ids: `led_<uuid>`, full or a prefix of led_ + 8 or more. An ambiguous prefix is refused with the
// candidates listed, never resolved by guessing (store.ts locate()). Fields come from `context` JSON
// when present ({ id, content? }); the request text is parsed only as a fallback.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { LEDGER_ID_TOKEN, listLedger, keepLedger, dropLedger, promoteLedger, LEDGER_LIST_LIMIT, type LedgerMoveResult } from "../../ledger/store.js";

const VERB_RE = new RegExp(`^(?:keep|drop)\\s+(?:the\\s+|this\\s+)?ledger(?:\\s+entry)?\\s+(${LEDGER_ID_TOKEN})(?![A-Za-z0-9_-])\\s*(?::\\s*([\\s\\S]+))?$`, "i");

export function parseLedgerVerb(request: string): { id: string; words: string | null } | null {
  const m = VERB_RE.exec(request.trim());
  if (!m || !m[1]) return null;
  const words = m[2]?.trim();
  return { id: m[1], words: words && words.length > 0 ? words : null };
}

export const LEDGER_FOOTER =
  'these are clerk records about you, not your words -- "keep ledger <id>" keeps a record as written; ' +
  '"keep ledger <id>: <your words>" puts it in your journal in your own words; "drop ledger <id>" drops it';

export async function execLedgerRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ limit?: number }>(ctx.req.context);
  const rows = await listLedger(ctx.env, ctx.req.companion_id, "open", p?.limit ?? LEDGER_LIST_LIMIT);
  return {
    response_key: "data",
    data: {
      ledger: rows.map((r) => ({ id: r.id, content: r.content, observed_on: r.observed_on, created_at: r.created_at })),
      footer: LEDGER_FOOTER,
    },
    count: rows.length,
  };
}

function refusal(verb: string, id: string, r: Exclude<LedgerMoveResult, { ok: true }>): ExecutorResult {
  switch (r.reason) {
    case "bad_id":
      return { error: `ledger_${verb}_failed`, reason: "id must be a ledger id (led_...) or a prefix of led_ plus at least 8 characters" };
    case "empty_words":
      return { error: "ledger_keep_failed", reason: "your words cannot be empty -- omit the colon to keep the record as written" };
    case "ambiguous":
      return { error: `ledger_${verb}_ambiguous`, reason: `"${id}" matches ${r.matches.length} of your ledger entries -- use more of the id: ${r.matches.map((m) => `${m.id} (${m.state})`).join("; ")}. Nothing changed.`, matches: r.matches };
    case "already_decided":
      return { response_key: "witness", witness: `no change -- ledger ${r.id} is already ${r.state}${r.state_at ? ` (${r.state_at})` : ""}`, ack: false, id: r.id, state: r.state };
    case "already_promoted":
      return { response_key: "witness", witness: `no change -- ledger ${r.id} is already in your journal in your words (${r.promoted_journal_id})`, ack: false, id: r.id };
    case "not_found":
    default:
      return { response_key: "witness", witness: "no change (not found, or not a record about you)", ack: false };
  }
}

async function act(ctx: ExecutorContext, verb: "keep" | "drop"): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string; ref_id?: string; content?: string; words?: string }>(ctx.req.context);
  const fromText = parseLedgerVerb(ctx.req.request);
  const id = (p?.id ?? p?.ref_id ?? fromText?.id)?.trim();
  if (!id) return { error: `ledger_${verb}_failed`, reason: `need { id${verb === "keep" ? ", content?" : ""} } -- or "${verb} ledger <id>"` };
  const words = verb === "keep" ? (p?.content ?? p?.words ?? fromText?.words ?? null) : null;

  const companion = ctx.req.companion_id;
  const r = verb === "drop"
    ? await dropLedger(ctx.env, companion, id)
    : words !== null
      ? await promoteLedger(ctx.env, companion, id, words)
      : await keepLedger(ctx.env, companion, id);
  if (!r.ok) return refusal(verb, id, r);

  const witness = verb === "drop"
    ? `dropped -- that record is not recalled, and its search copy is purged (ledger ${r.id})`
    : r.promoted_journal_id
      ? `kept, in your words -- your journal holds what you said (${r.promoted_journal_id}); the ledger keeps its own line (ledger ${r.id})`
      : `kept as written -- it stays a ledger line, marked as a clerk's record (ledger ${r.id})`;
  return {
    response_key: "witness", witness, ack: true, id: r.id, state: r.state,
    ...(r.promoted_journal_id ? { promoted_journal_id: r.promoted_journal_id } : {}),
  };
}

export function execLedgerKeep(ctx: ExecutorContext): Promise<ExecutorResult> {
  return act(ctx, "keep");
}

export function execLedgerDrop(ctx: ExecutorContext): Promise<ExecutorResult> {
  return act(ctx, "drop");
}
