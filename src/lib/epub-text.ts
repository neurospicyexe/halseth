// src/lib/epub-text.ts
//
// Read an epub as TEXT inside a Worker: spine-ordered chapters, labels from the
// nav/NCX, prose-grade XHTML -> markdown, and chapter / window / in-book search
// helpers. Port of scripts/epub-to-vault.mjs (same near-empty rule and the same
// markdown pass) on top of the zip walk in src/lib/epub.ts, so the Library epub
// itself is readable without the Obsidian vault copy.
//
// Cost model: opening an epub reads only container.xml, the OPF and the nav/NCX.
// Chapter XHTML is inflated one chapter at a time, on demand. Only a query
// (search within the book) inflates every chapter.

import {
  parseEntries, readEntry, readTextEntry, resolveHref, parseManifest, decodeXmlEntities,
  type ZipEntry,
} from "./epub.js";

export interface EpubChapter {
  /** 1-based position among the kept (non-near-empty) spine items. */
  number: number;
  label: string;
  /** True when the label came from the nav/NCX or a heading, false for "Chapter N". */
  titled: boolean;
  path: string;
  /** Uncompressed XHTML bytes; a cheap proxy for how much of the book this chapter is. */
  size: number;
}

export interface EpubText {
  buf: ArrayBuffer;
  entries: ZipEntry[];
  chapters: EpubChapter[];
}

/** Spine items smaller than this (uncompressed XHTML bytes) are covers, separators, nav pages. */
const NEAR_EMPTY_BYTES = 600;
/** Same floor epub-to-vault.mjs applies to converted markdown. */
export const NEAR_EMPTY_CHARS = 200;

// ── xhtml -> markdown (prose-grade; same pass as scripts/epub-to-vault.mjs) ─────
function decodeEntities(s: string): string {
  return decodeXmlEntities(
    s.replace(/&nbsp;/gi, " ").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
      .replace(/&hellip;/gi, "…").replace(/&rsquo;/gi, "’").replace(/&lsquo;/gi, "‘")
      .replace(/&rdquo;/gi, "”").replace(/&ldquo;/gi, "“"),
  );
}

export function htmlToMarkdown(xhtml: string): string {
  let s = xhtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style|head)\b[\s\S]*?<\/(?:script|style|head)>/gi, "")
    .replace(/\r\n?/g, "\n");
  s = s
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, t: string) => `\n\n# ${t}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, t: string) => `\n\n## ${t}\n\n`)
    .replace(/<h([3-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n: string, t: string) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t: string) => `\n\n> ${t.trim().replace(/\n+/g, "\n> ")}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t: string) => `\n- ${t.trim()}`)
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article)>/gi, "\n\n");
  s = s
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, t: string) => `*${t}*`)
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, t: string) => `**${t}**`);
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  return s.split("\n").map(l => l.replace(/\s+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── labels from nav.xhtml / toc.ncx ──────────────────────────────────────────
function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
}

/** href (resolved, no fragment) -> first label that points at it. */
function parseLabels(docPath: string, doc: string): Map<string, string> {
  const out = new Map<string, string>();
  const put = (href: string, label: string) => {
    const clean = href.split("#")[0] ?? "";
    if (!clean || !label) return;
    const key = resolveHref(docPath, clean);
    if (!out.has(key)) out.set(key, label);
  };
  // EPUB 3 nav: <a href="ch1.xhtml">Label</a>
  for (const m of doc.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    put(m[1]!, stripTags(m[2]!));
  }
  // EPUB 2 NCX: <navLabel><text>Label</text></navLabel><content src="ch1.xhtml"/>
  for (const m of doc.matchAll(/<navLabel>\s*<text>([\s\S]*?)<\/text>\s*<\/navLabel>\s*<content\s[^>]*src\s*=\s*["']([^"']+)["']/gi)) {
    put(m[2]!, stripTags(m[1]!));
  }
  return out;
}

export async function openEpubText(buf: ArrayBuffer): Promise<EpubText | null> {
  try {
    const entries = parseEntries(buf);
    if (entries.length === 0) return null;
    const container = await readTextEntry(buf, entries, "META-INF/container.xml");
    const opfPath = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!opfPath) return null;
    const opf = await readTextEntry(buf, entries, opfPath);
    if (!opf) return null;

    const items = parseManifest(opf);
    const byId = new Map(items.map(i => [i.id, i]));
    const spine: { path: string }[] = [];
    for (const tag of opf.match(/<(?:opf:)?itemref\s[^>]*>/gi) ?? []) {
      const idref = tag.match(/idref\s*=\s*["']([^"']+)["']/i)?.[1];
      const item = idref ? byId.get(idref) : null;
      if (!item || !/html|xml/i.test(item.mediaType ?? "")) continue;
      if (item.properties?.split(/\s+/).includes("nav")) continue;
      spine.push({ path: resolveHref(opfPath, item.href.split("#")[0] ?? item.href) });
    }
    if (spine.length === 0) return null;

    // Labels: EPUB 3 nav document, else the NCX the spine points at.
    const labels = new Map<string, string>();
    const navItem = items.find(i => i.properties?.split(/\s+/).includes("nav"));
    const ncxItem = items.find(i => /dtbncx/i.test(i.mediaType ?? "") || /\.ncx$/i.test(i.href));
    for (const doc of [navItem, ncxItem]) {
      if (!doc) continue;
      const docPath = resolveHref(opfPath, doc.href);
      const text = await readTextEntry(buf, entries, docPath);
      if (text) for (const [k, v] of parseLabels(docPath, text)) if (!labels.has(k)) labels.set(k, v);
    }

    const chapters: EpubChapter[] = [];
    for (const { path } of spine) {
      const entry = entries.find(e => e.name === path) ?? entries.find(e => e.name.toLowerCase() === path.toLowerCase());
      if (!entry || entry.uncompressedSize < NEAR_EMPTY_BYTES) continue;
      const number = chapters.length + 1;
      const label = labels.get(path);
      chapters.push({
        number, path: entry.name, size: entry.uncompressedSize,
        label: label ?? `Chapter ${number}`, titled: !!label,
      });
    }
    if (chapters.length === 0) return null;
    return { buf, entries, chapters };
  } catch {
    return null;
  }
}

/** Markdown text of one chapter ("" if it cannot be read). */
export async function readChapterText(book: EpubText, ch: EpubChapter): Promise<string> {
  const entry = book.entries.find(e => e.name === ch.path);
  if (!entry) return "";
  const bytes = await readEntry(book.buf, entry);
  return bytes ? htmlToMarkdown(new TextDecoder().decode(bytes)) : "";
}

// ── selection ────────────────────────────────────────────────────────────────
export function normalizeLabel(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17,
  eighteen: 18, nineteen: 19, twenty: 20,
};

/** Pick a chapter by "3" / "chapter 3" / "part two" (label first, then number) or a title fragment. */
export function pickChapter(chapters: EpubChapter[], spec: string): EpubChapter | null {
  const raw = spec.trim();
  if (!raw) return null;
  const norm = normalizeLabel(raw);
  const bareNumber = /^\d+$/.test(raw);
  // Titles that carry the words ("Part Two", "Chapter 3") win over positional counting.
  if (!bareNumber && norm.length >= 3) {
    const byLabel = chapters.find(c => normalizeLabel(c.label) === norm)
      ?? chapters.find(c => c.titled && normalizeLabel(c.label).includes(norm));
    if (byLabel) return byLabel;
  }
  const m = raw.match(/^(?:chapter|ch\.?|part|section)?\s*(\d+|[a-z]+)$/i);
  if (m) {
    const n = /^\d+$/.test(m[1]!) ? Number(m[1]) : WORD_NUMBERS[m[1]!.toLowerCase()];
    if (n && n >= 1 && n <= chapters.length) return chapters[n - 1]!;
  }
  if (norm.length >= 3) return chapters.find(c => normalizeLabel(c.label).includes(norm)) ?? null;
  return null;
}

/** Chapter containing `percent` (0-100) of the book, weighting chapters by XHTML size. */
export function chapterAtPercent(chapters: EpubChapter[], percent: number): EpubChapter {
  const total = chapters.reduce((n, c) => n + c.size, 0);
  const target = (Math.min(Math.max(percent, 0), 100) / 100) * total;
  let acc = 0;
  for (const c of chapters) {
    acc += c.size;
    if (target < acc) return c;
  }
  return chapters[chapters.length - 1]!;
}

// ── windows ──────────────────────────────────────────────────────────────────
/** Split text into windows of at most `max` chars, breaking on paragraph boundaries. */
export function windowText(text: string, max: number): string[] {
  const windows: string[] = [];
  let cur = "";
  const flush = () => { if (cur) { windows.push(cur); cur = ""; } };
  for (const para of text.split(/\n{2,}/)) {
    const piece = para.trim();
    if (!piece) continue;
    if (piece.length > max) {
      flush();
      for (let i = 0; i < piece.length; i += max) windows.push(piece.slice(i, i + max));
      continue;
    }
    if (cur && cur.length + 2 + piece.length > max) flush();
    cur = cur ? `${cur}\n\n${piece}` : piece;
  }
  flush();
  return windows.length ? windows : [""];
}

// ── in-book lexical search ───────────────────────────────────────────────────
const STOP = new Set(("the and for are but not you all any can had her was one our out has his how its may " +
  "new now see two way who did get him let put say she too use with that this from have they what when " +
  "where which will your about into than them then there these were been would could should").split(" "));

export function queryTerms(q: string): string[] {
  const terms = q.toLowerCase().match(/[a-z0-9']+/g) ?? [];
  return [...new Set(terms.filter(t => t.length > 2 && !STOP.has(t)))];
}

export interface Passage { chapter: EpubChapter; text: string; score: number }

/** Paragraph-level term overlap across the given chapters' texts; top `limit` passages. */
export function searchPassages(
  texts: { chapter: EpubChapter; text: string }[], query: string, limit = 5, maxChars = 900,
): Passage[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];
  const scored: Passage[] = [];
  for (const { chapter, text } of texts) {
    for (const para of text.split(/\n{2,}/)) {
      const body = para.trim();
      if (body.length < 40 || /^#{1,6}\s/.test(body) && body.length < 80) continue;
      const lower = body.toLowerCase();
      let hits = 0;
      let freq = 0;
      for (const t of terms) {
        const n = lower.split(t).length - 1;
        if (n > 0) { hits++; freq += Math.min(n, 3); }
      }
      if (hits === 0) continue;
      // distinct-term coverage dominates; frequency and brevity break ties
      const score = hits * 10 + freq - Math.min(body.length / 2000, 2);
      scored.push({ chapter, text: body.length > maxChars ? body.slice(0, maxChars) + "…" : body, score });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}
