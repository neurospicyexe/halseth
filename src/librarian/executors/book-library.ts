// Library-first book_read (2026-11-03). The Library already holds every epub in R2
// (table `books`, mig 0099), so co-reading must not depend on the Obsidian vault copy
// that LiveSync feeds. execBookRead (memory.ts) tries this first and falls back to the
// vault for non-epub books or when the Library has nothing.

import type { Env } from "../../types.js";
import { RAW_DATA_CHARS, truncateRaw } from "../response/budget.js";
import {
  openEpubText, readChapterText, pickChapter, chapterAtPercent, windowText, searchPassages,
  normalizeLabel, NEAR_EMPTY_CHARS, type EpubText, type EpubChapter,
} from "../../lib/epub-text.js";
import { loadMargins, marginFields } from "./book-margins.js";

export interface LibraryBook {
  id: string;
  title: string;
  author: string | null;
  file_key: string;
  file_type: "epub" | "pdf";
}

export interface LibraryReadArgs { query?: string; chapter?: string; part?: number }

export async function listLibraryBooks(env: Env): Promise<LibraryBook[]> {
  try {
    const r = await env.DB.prepare(
      "SELECT id, title, author, file_key, file_type FROM books ORDER BY title COLLATE NOCASE"
    ).all<LibraryBook>();
    return r.results ?? [];
  } catch {
    return []; // pre-0099 or D1 hiccup: behave as an empty Library, vault path still runs
  }
}

/** Normalized exact match first, then substring either direction. Several = ambiguous (caller lists them). */
export function matchLibraryBooks(title: string, books: LibraryBook[]): LibraryBook[] {
  const norm = normalizeLabel(title);
  if (norm.length < 2) return [];
  const exact = books.filter(b => normalizeLabel(b.title) === norm);
  if (exact.length) return exact;
  return books.filter(b => {
    const nb = normalizeLabel(b.title);
    return nb.length >= 3 && (nb.includes(norm) || norm.includes(nb));
  });
}

const chapterList = (book: EpubText) =>
  book.chapters.slice(0, 300).map(c => `${c.number}. ${c.label}`);

async function resolveDefaultChapter(
  env: Env, bookId: string, book: EpubText,
): Promise<{ chapter: EpubChapter; why: string }> {
  const chapters = book.chapters;
  const row = await env.DB.prepare(
    "SELECT progress_percent, current_chapter FROM book_progress WHERE book_id = ?"
  ).bind(bookId).first<{ progress_percent: number | null; current_chapter: string | null }>().catch(() => null);

  const label = row?.current_chapter?.trim();
  if (label) {
    const norm = normalizeLabel(label);
    if (norm.length >= 3) {
      const hit = chapters.find(c => c.titled && normalizeLabel(c.label) === norm)
        ?? chapters.find(c => c.titled && normalizeLabel(c.label).includes(norm));
      if (hit) return { chapter: hit, why: `Raziel's saved position is "${label}"` };
    }
  }
  const pct = row?.progress_percent;
  if (typeof pct === "number" && Number.isFinite(pct) && pct > 0) {
    const chapter = chapterAtPercent(chapters, pct);
    return { chapter, why: `Raziel is about ${Math.round(pct)}% through the book, which falls in this chapter` };
  }
  return { chapter: chapters[0]!, why: "no reading position is recorded for Raziel, so starting at the beginning" };
}

/**
 * Read from the Library epub. Returns null when the object cannot be fetched or parsed,
 * so the caller can fall back to the vault instead of reporting a false "not loaded".
 */
export async function readLibraryBook(
  env: Env, book: LibraryBook, a: LibraryReadArgs,
): Promise<Record<string, unknown> | null> {
  const obj = await env.BUCKET.get(book.file_key).catch(() => null);
  if (!obj) return null;
  const parsed = await openEpubText(await obj.arrayBuffer());
  if (!parsed) return null;
  const chapters = parsed.chapters;
  const base = {
    response_key: "summary" as const,
    loaded: true,
    book: book.title,
    author: book.author,
    chapters: chapterList(parsed),
  };
  const meta = { operation: "book_read", loaded: true, source: "library", chapter_count: chapters.length };

  let scoped: EpubChapter | null = null;
  if (a.chapter) {
    scoped = pickChapter(chapters, a.chapter);
    if (!scoped) {
      return {
        ...base,
        message: `No chapter matching "${a.chapter}" in "${book.title}". Pick one from the chapters list (number or title). You have NOT read it.`,
        meta,
      };
    }
  }

  // Search WITHIN this book only (never the global index).
  if (a.query) {
    const pool = scoped ? [scoped] : chapters;
    const texts: { chapter: EpubChapter; text: string }[] = [];
    for (const chapter of pool) texts.push({ chapter, text: await readChapterText(parsed, chapter) });
    const hits = searchPassages(texts, a.query, 8);
    const excerpts: { chapter: string; text: string }[] = [];
    let used = 0;
    for (const h of hits) {
      if (excerpts.length && used + h.text.length > RAW_DATA_CHARS) break;
      excerpts.push({ chapter: `${h.chapter.number}. ${h.chapter.label}`, text: h.text });
      used += h.text.length;
    }
    const margins = marginFields(await loadMargins(env, book.id), excerpts.map(e => e.text));
    return {
      ...base, query: a.query, excerpts, ...margins,
      ...(excerpts.length ? {} : { message: `Nothing in "${book.title}"${scoped ? ` (${scoped.label})` : ""} matches "${a.query}". Do not invent a passage.` }),
      meta: { ...meta, scoped: true },
    };
  }

  // A chapter: asked for, or where Raziel is.
  let chapter: EpubChapter;
  let why: string;
  if (scoped) {
    chapter = scoped;
    why = "chapter requested";
  } else {
    const d = await resolveDefaultChapter(env, book.id, parsed);
    chapter = d.chapter;
    why = d.why;
  }
  let text = await readChapterText(parsed, chapter);
  if (!scoped && text.replace(/[#>\-\s*]/g, "").length < NEAR_EMPTY_CHARS) {
    // default landed on front matter: step to the first chapter with real text
    for (const c of chapters.slice(chapter.number)) {
      const t = await readChapterText(parsed, c);
      if (t.replace(/[#>\-\s*]/g, "").length >= NEAR_EMPTY_CHARS) { chapter = c; text = t; break; }
    }
  }
  const windows = windowText(text, RAW_DATA_CHARS);
  const part = Math.min(Math.max(Math.floor(a.part ?? 1) || 1, 1), windows.length);
  // Notes in the part being returned; a note later in this chapter waits for that part.
  const margins = marginFields(await loadMargins(env, book.id), [windows[part - 1] ?? ""]);
  return {
    ...base,
    ...margins,
    reading: {
      path: `${chapter.number}. ${chapter.label}`,
      chapter: chapter.number,
      why,
      part,
      parts: windows.length,
      text: truncateRaw(windows[part - 1] ?? ""),
    },
    ...(part < windows.length
      ? { more: `Part ${part} of ${windows.length} of this chapter. Ask again with { chapter: "${chapter.number}", part: ${part + 1} } to continue.` }
      : chapter.number < chapters.length
        ? { more: `End of chapter ${chapter.number}. Next: ${chapter.number + 1}. ${chapters[chapter.number]!.label}.` }
        : {}),
    meta: { ...meta, chapter: chapter.number },
  };
}
