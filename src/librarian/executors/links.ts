// Librarian executors for our own links (M4, mig 0151). Rules: src/graph/links.ts.
//
// "link conclusion: <a few words> to journal: <a few words>[: why]"
// "unlink conclusion: <words> to journal: <words>"   (Claude.ai only -- see links.ts)
// "my links"
// Either end may name whose row it is ("drevan's tension: ..."), and a quote may sit in quotation
// marks when it holds " to " or a colon. The context payload is the unambiguous form (Hearth, bots):
// { src: { kind, quote | id, owner? }, dst: { ... }, why?, link_id? }.

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import {
  LINK_KIND_RE, LINK_OWNER_RE, LINK_WRITERS, WHY_CHARS, librarianVia, listLinks, makeLink, removeLink,
  type LinkEnd, type LinkWriter,
} from "../../graph/links.js";

const NEED = 'need "link <kind>: <a few words> to <kind>: <a few words>: why" (kinds: conclusion, note, journal, tension, letter, question, project, thread, watching, person, ...), or context { src: { kind, quote | id }, dst: { kind, quote | id }, why }';

const KIND_RE = LINK_KIND_RE;
const OWNER_RE = LINK_OWNER_RE;
// An end: optional owner, a kind word, a colon, then the words (to the next end / why).
const END_HEAD = new RegExp(`^${OWNER_RE}(?:the\\s+)?${KIND_RE}\\s*:\\s*`, "i");
const SPLIT = new RegExp(`\\s+to\\s+(?=${OWNER_RE}(?:the\\s+)?${KIND_RE}\\s*:)`, "i");

function ownerWord(w: string | undefined): string | undefined {
  if (!w) return undefined;
  const o = w.toLowerCase().replace(/'?s$/, "");
  if (o === "my" || o === "mine") return "my";
  return o === "crash" ? "raziel" : o;
}

const QUOTED = /^["“”']([\s\S]+?)["“”'](?:\s*:\s*([\s\S]*))?$/;

/** "drevan's tension: words" -> { owner, kind, quote, rest } where rest is anything after a quoted quote. */
function parseEnd(s: string, allowWhy: boolean): { end: LinkEnd; why?: string } | null {
  const head = END_HEAD.exec(s.trim());
  if (!head) return null;
  let body = s.trim().slice(head[0].length).trim();
  let why: string | undefined;
  const q = QUOTED.exec(body);
  if (q) {
    body = q[1]!;
    if (q[2] !== undefined) { if (!allowWhy) return null; why = q[2].trim(); }
  } else if (allowWhy) {
    const i = body.indexOf(":");
    if (i >= 0) { why = body.slice(i + 1).trim(); body = body.slice(0, i).trim(); }
  }
  return { end: { owner: ownerWord(head[1]), kind: head[2]!.toLowerCase(), quote: body.trim() }, why: why || undefined };
}

export interface ParsedLink { src: LinkEnd; dst: LinkEnd; why?: string; linkId?: string }

/** From the context payload first, else the plain request text. Exported for the grammar tests. */
export function parseLinkRequest(request: string, context?: string): ParsedLink | null {
  const p = parseContext<{ src?: LinkEnd; dst?: LinkEnd; why?: string; link_id?: string; id?: string }>(context);
  if (p?.link_id) return { src: {}, dst: {}, linkId: p.link_id };
  if (p?.src && p?.dst) return { src: p.src, dst: p.dst, why: p.why };
  const text = String(request ?? "").trim().replace(/^(?:please\s+)?(?:un)?link\s+/i, "");
  // "unlink link <id>": the id the witness and "my links" print.
  const byId = /^link\s+([0-9a-f-]{8,})\s*$/i.exec(text);
  if (byId) return { src: {}, dst: {}, linkId: byId[1] };
  // The FIRST " to <kind>:" after the first end's words splits the ends. When those words sit in
  // quote marks, the split is looked for only after the closing mark, so a quoted " to journal:"
  // stays inside the quote.
  const head = END_HEAD.exec(text);
  let from = 0;
  if (head && /^["“”']/.test(text.slice(head[0].length))) {
    const close = text.slice(head[0].length + 1).search(/["“”']/);
    if (close >= 0) from = head[0].length + 1 + close + 1;
  }
  const tail = text.slice(from);
  const m = SPLIT.exec(tail);
  if (!m) return null;
  const left = text.slice(0, from + m.index);
  const right = tail.slice(m.index + m[0].length);
  const a = parseEnd(left, false);
  const b = parseEnd(right, true);
  if (!a || !b || !a.end.quote || !b.end.quote) return null;
  return { src: a.end, dst: b.end, why: b.why };
}

function writerOf(ctx: ExecutorContext): LinkWriter | null {
  const w = ctx.req.companion_id as string;
  return (LINK_WRITERS as readonly string[]).includes(w) ? (w as LinkWriter) : null;
}

const witness = (text: string, ack: boolean): ExecutorResult => ({ response_key: "witness", witness: text, ack });

export async function execGraphLink(ctx: ExecutorContext): Promise<ExecutorResult> {
  const writer = writerOf(ctx);
  const t = parseLinkRequest(ctx.req.request, ctx.req.context);
  if (!writer || !t || t.linkId) return { error: "graph_link_failed", reason: NEED };
  const r = await makeLink(ctx.env, {
    writer, src: t.src, dst: t.dst, why: t.why ?? null, via: librarianVia(ctx.req), surface: ctx.req.surface ?? null,
  });
  if (!r.ok) return witness(`no change: ${r.reason}`, false);
  const line = `"${r.src.text}" (${r.src.kind}) to "${r.dst.text}" (${r.dst.kind})`;
  if (!r.changed) return witness(`already linked: ${line}${r.link.why ? ` -- ${r.link.why}` : ""} (link ${r.link.id})`, false);
  return witness(`linked ${line}${r.link.why ? ` -- ${r.link.why}` : ""}. Drawn in your colour on the map (link ${r.link.id}). Unlinking it takes a Claude.ai conversation.`, true);
}

export async function execGraphUnlink(ctx: ExecutorContext): Promise<ExecutorResult> {
  const writer = writerOf(ctx);
  const t = parseLinkRequest(ctx.req.request, ctx.req.context);
  if (!writer || !t) return { error: "graph_unlink_failed", reason: NEED.replace('"link', '"unlink') };
  const r = await removeLink(ctx.env, {
    writer, via: librarianVia(ctx.req), surface: ctx.req.surface ?? null,
    linkId: t.linkId, src: t.linkId ? undefined : t.src, dst: t.linkId ? undefined : t.dst,
  });
  if (!r.ok) return witness(`no change: ${r.reason.replace(/^not_present: /, "")}`, false);
  if (!r.changed) return witness("no change (no live link of yours between those two)", false);
  return witness(`unlinked (link ${r.link!.id}); the ledger keeps that it existed and when it ended`, true);
}

export async function execGraphLinksRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const writer = writerOf(ctx);
  if (!writer) return { error: "graph_links_read_failed", reason: "unknown companion" };
  const links = await listLinks(ctx.env, writer);
  return {
    response_key: "data",
    witness: links.length
      ? `your links (${links.length}): ${links.map((l) => `"${l.src_label}" to "${l.dst_label}"${l.why ? ` -- ${l.why}` : ""} [${l.id}]`).join(" | ")}`
      : `no links yet. Make one: "link conclusion: <a few words> to journal: <a few words>: why" (why up to ${WHY_CHARS} characters)`,
    data: { links },
  };
}
