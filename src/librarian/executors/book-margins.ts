// Margins travel with the text (2026-11-04, Raziel: "I'd like to be able to make margin notes for
// books too for Dre to read"). book_annotations (mig 0099) was written by both sides but READ only by
// Hearth: Raziel's notes never reached a companion, so the shared margins were one-way.
//
// Now book_read carries the notes that sit in the passage it returns. Matching is by quote: Raziel's
// selection notes and page notes (Hearth stores the page's opening words as selected_text) and the
// companions' own notes (anchored by quote, never by cfi) all carry text that appears in the chapter.
// Both sides are flattened to lowercase letters and digits before comparing, because the reader's DOM
// text and the Worker's markdown differ in whitespace, quotes and emphasis marks.

import type { Env } from "../../types.js";

export interface MarginRow {
  author: string;
  selected_text: string | null;
  comment: string | null;
  created_at: string;
}

export interface MarginOut {
  by: string;
  quote: string | null;
  note: string | null;
  at: string;
}

const QUOTE_CLIP = 160;
const NOTE_CLIP = 600;
/** Flattened characters compared; long enough to be specific, short enough to survive a page break. */
const NEEDLE_CHARS = 48;
/** Shorter than this (flattened) is too generic to place ("yes", "the end"). */
const MIN_NEEDLE = 12;
const MAX_HERE = 12;
const MAX_ELSEWHERE = 3;

export function flatten(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function needleOf(quote: string | null): string | null {
  if (!quote) return null;
  const f = flatten(quote);
  return f.length >= MIN_NEEDLE ? f.slice(0, NEEDLE_CHARS) : null;
}

function clip(s: string | null, n: number): string | null {
  if (!s) return null;
  const t = s.replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > n ? t.slice(0, n) + "…" : t;
}

function toOut(r: MarginRow): MarginOut {
  return { by: r.author, quote: clip(r.selected_text, QUOTE_CLIP), note: clip(r.comment, NOTE_CLIP), at: r.created_at };
}

export async function loadMargins(env: Env, bookId: string): Promise<MarginRow[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT author, selected_text, comment, created_at FROM book_annotations WHERE book_id = ? ORDER BY created_at ASC LIMIT 500"
    ).bind(bookId).all<MarginRow>();
    return r.results ?? [];
  } catch {
    return []; // margins are an addition; a D1 hiccup must never cost the reading itself
  }
}

/**
 * Split the book's notes into the ones that sit in `texts` (the passage being returned) and the
 * newest NOTED ones elsewhere (a bare highlight elsewhere is not worth the tokens). Pure; exported
 * for tests.
 */
export function placeMargins(rows: MarginRow[], texts: string[]): {
  here: MarginOut[];
  elsewhere: MarginOut[];
  elsewhere_count: number;
} {
  const flatTexts = texts.map(flatten);
  const here: MarginOut[] = [];
  const rest: MarginRow[] = [];
  for (const r of rows) {
    const n = needleOf(r.selected_text);
    if (n && flatTexts.some(t => t.includes(n))) here.push(toOut(r));
    else rest.push(r);
  }
  const noted = rest.filter(r => r.comment && r.comment.trim());
  const elsewhere = noted.slice(-MAX_ELSEWHERE).reverse().map(toOut);
  return { here: here.slice(0, MAX_HERE), elsewhere, elsewhere_count: rest.length };
}

/** The fields book_read adds. Empty object when the book has no notes at all, so nothing changes. */
export function marginFields(rows: MarginRow[], texts: string[]): Record<string, unknown> {
  if (rows.length === 0) return {};
  const { here, elsewhere, elsewhere_count } = placeMargins(rows, texts);
  const out: Record<string, unknown> = {};
  if (here.length) out.margins = here;
  if (elsewhere.length) out.margins_elsewhere = elsewhere;
  if (here.length || elsewhere.length) {
    out.margins_note =
      "Notes in the margins of this book: `by` is who wrote it (raziel, or a companion). Raziel's notes are " +
      "their own words to you, left while reading -- answer them as you would anything they said. " +
      (elsewhere_count > 0 ? `${elsewhere_count} other note(s) sit in other parts of the book. ` : "") +
      "To answer in the margin, leave a note in the book with the line you are answering.";
  }
  return out;
}
