// Library-first book_read: epubs in R2 are read directly, the vault is the fallback.
// Real zip bytes are built by hand (same technique as epub.test.ts); D1, R2 and the
// Second Brain backend are faked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { deflateRawSync } from "node:zlib";

const sbList = vi.fn();
const sbRead = vi.fn();
vi.mock("../librarian/backends/second-brain.js", async (orig) => ({
  ...(await orig<object>()),
  sbList: (...a: unknown[]) => sbList(...a),
  sbRead: (...a: unknown[]) => sbRead(...a),
}));

import { execBookRead } from "../librarian/executors/memory.js";
import { openEpubText, windowText, chapterAtPercent, pickChapter } from "../lib/epub-text.js";

function u16(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff]; }
function u32(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }

function buildZip(entries: { name: string; data: Uint8Array; method: 0 | 8 }[]): ArrayBuffer {
  const enc = new TextEncoder();
  const chunks: number[] = [];
  const central: number[] = [];
  for (const e of entries) {
    const nameBytes = [...enc.encode(e.name)];
    const stored = e.method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const localOffset = chunks.length;
    chunks.push(
      ...u32(0x04034b50), ...u16(20), ...u16(0), ...u16(e.method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(stored.length), ...u32(e.data.length), ...u16(nameBytes.length), ...u16(0),
      ...nameBytes, ...stored,
    );
    central.push(
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0), ...u16(e.method), ...u16(0), ...u16(0),
      ...u32(0), ...u32(stored.length), ...u32(e.data.length), ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(localOffset), ...nameBytes,
    );
  }
  const cdOffset = chunks.length;
  chunks.push(...central);
  chunks.push(
    ...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(entries.length), ...u16(entries.length),
    ...u32(central.length), ...u32(cdOffset), ...u16(0),
  );
  return new Uint8Array(chunks).buffer;
}

const enc = new TextEncoder();
const CONTAINER = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`;
const OPF = `<?xml version="1.0"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0">
<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Interview with the Vampire</dc:title><dc:creator>Anne Rice</dc:creator></metadata>
<manifest>
<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="blank" href="blank.xhtml" media-type="application/xhtml+xml"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="c3" href="ch3.xhtml" media-type="application/xhtml+xml"/>
</manifest>
<spine><itemref idref="nav"/><itemref idref="blank"/><itemref idref="c1"/><itemref idref="c2"/><itemref idref="c3"/></spine></package>`;
const NAV = `<html><body><nav epub:type="toc"><ol>
<li><a href="ch1.xhtml">The Boy in the Hotel</a></li>
<li><a href="ch2.xhtml">New Orleans</a></li>
<li><a href="ch3.xhtml">Part Two: Claudia</a></li></ol></nav></body></html>`;

const para = (s: string, n = 1) => `<p>${(s + " ").repeat(n).trim()}</p>`;
function chapterHtml(title: string, body: string): string {
  return `<html><head><title>x</title></head><body><h1>${title}</h1>${body}</body></html>`;
}
const CH1 = chapterHtml("The Boy in the Hotel",
  para("The vampire spoke softly of the night he was made, in the old house above the river.", 4) +
  para("The boy listened with the tape recorder running and said nothing for a long while.", 4));
const CH2 = chapterHtml("New Orleans",
  para("Lestat lived in the city among the gaslights and the iron balconies of the French Quarter.", 5) +
  para("A cat slept on the sill; the plantation indigo had failed that year and the debts grew.", 5));
const CH3 = chapterHtml("Part Two: Claudia",
  para("Claudia learned to read before she learned to be afraid of what she was becoming.", 12));

function epub(): ArrayBuffer {
  return buildZip([
    { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
    { name: "OEBPS/content.opf", data: enc.encode(OPF), method: 8 },
    { name: "OEBPS/nav.xhtml", data: enc.encode(NAV), method: 0 },
    { name: "OEBPS/blank.xhtml", data: enc.encode("<html><body><p>.</p></body></html>"), method: 0 },
    { name: "OEBPS/ch1.xhtml", data: enc.encode(CH1), method: 8 },
    { name: "OEBPS/ch2.xhtml", data: enc.encode(CH2), method: 8 },
    { name: "OEBPS/ch3.xhtml", data: enc.encode(CH3), method: 8 },
  ]);
}

interface Row { id: string; title: string; author: string | null; file_key: string; file_type: "epub" | "pdf" }
interface Ann { author: string; selected_text: string | null; comment: string | null; created_at: string }
function makeEnv(books: Row[], progress: Record<string, { progress_percent: number; current_chapter: string | null }> = {}, annotations: Ann[] = []) {
  const r2 = { get: vi.fn(async (key: string) => (key === "books/vamp.epub" ? { arrayBuffer: async () => epub() } : null)) };
  const DB = {
    prepare(sql: string) {
      let args: unknown[] = [];
      const stmt = {
        bind(...a: unknown[]) { args = a; return stmt; },
        async all() {
          if (/FROM book_annotations/.test(sql)) return { results: annotations };
          return { results: /FROM books/.test(sql) ? books : [] };
        },
        async first() {
          if (/FROM book_progress/.test(sql)) return progress[args[0] as string] ?? null;
          return null;
        },
      };
      return stmt;
    },
  };
  return { env: { DB, BUCKET: r2 } as never, r2 };
}

const VAMP: Row = { id: "b1", title: "Interview with the Vampire", author: "Anne Rice", file_key: "books/vamp.epub", file_type: "epub" };

function ctx(env: never, request: string, context?: object) {
  return { env, req: { companion_id: "drevan", request, context: context ? JSON.stringify(context) : undefined }, entry: {}, frontState: null, pluralAvailable: false } as never;
}
type R = Record<string, any>;

beforeEach(() => {
  sbList.mockReset().mockResolvedValue(null);
  sbRead.mockReset().mockResolvedValue(null);
});

describe("epub-text", () => {
  it("drops near-empty and nav spine items, labels from the nav", async () => {
    const book = await openEpubText(epub());
    expect(book!.chapters.map(c => c.label)).toEqual(["The Boy in the Hotel", "New Orleans", "Part Two: Claudia"]);
  });
  it("windowText breaks on paragraphs within the limit", () => {
    const w = windowText(["a".repeat(60), "b".repeat(60), "c".repeat(60)].join("\n\n"), 100);
    expect(w).toHaveLength(3);
    expect(w.every(x => x.length <= 100)).toBe(true);
  });
  it("percent maps to the chapter containing it; part-words pick by label then number", async () => {
    const { chapters } = (await openEpubText(epub()))!;
    expect(chapterAtPercent(chapters, 0).number).toBe(1);
    expect(chapterAtPercent(chapters, 100).number).toBe(3);
    expect(pickChapter(chapters, "part two")!.number).toBe(3);
    expect(pickChapter(chapters, "chapter two")!.number).toBe(2);
  });
});

describe("execBookRead, Library first", () => {
  it("hits the Library by title fragment without touching the vault", async () => {
    const { env } = makeEnv([VAMP]);
    const r = await execBookRead(ctx(env, "read", { title: "vampire" })) as R;
    expect(r.loaded).toBe(true);
    expect(r.meta).toMatchObject({ operation: "book_read", loaded: true, source: "library" });
    expect(r.response_key).toBe("summary");
    expect(r.book).toBe("Interview with the Vampire");
    expect(r.chapters).toHaveLength(3);
    expect(r.reading.chapter).toBe(1);
    expect(r.reading.why).toMatch(/no reading position/);
    expect(r.reading.text).toContain("tape recorder");
    expect(r.reading.text.length).toBeLessThanOrEqual(3100);
    expect(sbList).not.toHaveBeenCalled();
  });

  it("lists candidates when a fragment is ambiguous, never guessing", async () => {
    const { env } = makeEnv([VAMP, { ...VAMP, id: "b2", title: "The Vampire Lestat", file_key: "x" }]);
    const r = await execBookRead(ctx(env, "read", { title: "vampire" })) as R;
    expect(r.loaded).toBe(false);
    expect(r.ambiguous).toHaveLength(2);
    expect(r.meta.ambiguous).toBe(true);
  });

  it("reads a chapter by number and by 'chapter N' phrasing", async () => {
    const { env } = makeEnv([VAMP]);
    const a = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", chapter: "2" })) as R;
    expect(a.reading.chapter).toBe(2);
    expect(a.reading.text).toContain("gaslights");
    const b = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", chapter: "chapter 3" })) as R;
    expect(b.reading.chapter).toBe(3);
    const c = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", chapter: "claudia" })) as R;
    expect(c.reading.chapter).toBe(3);
  });

  it("scopes a query to this book only", async () => {
    const { env } = makeEnv([VAMP]);
    const r = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", query: "plantation indigo debts" })) as R;
    expect(r.meta.scoped).toBe(true);
    expect(r.excerpts[0].text).toContain("plantation indigo");
    expect(r.excerpts[0].chapter).toMatch(/^2\./);
    const none = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", query: "spaceship" })) as R;
    expect(none.excerpts).toEqual([]);
    expect(none.message).toMatch(/invent/);
    expect(sbRead).not.toHaveBeenCalled();
  });

  it("defaults to Raziel's position (percent, then saved chapter label)", async () => {
    const pct = makeEnv([VAMP], { b1: { progress_percent: 99, current_chapter: null } });
    const r = await execBookRead(ctx(pct.env, "read", { title: "Interview with the Vampire" })) as R;
    expect(r.reading.chapter).toBe(3);
    expect(r.reading.why).toMatch(/99%/);
    const lbl = makeEnv([VAMP], { b1: { progress_percent: 0, current_chapter: "New Orleans" } });
    const r2 = await execBookRead(ctx(lbl.env, "read", { title: "Interview with the Vampire" })) as R;
    expect(r2.reading.chapter).toBe(2);
    expect(r2.reading.why).toMatch(/saved position/);
  });

  it("windows a long chapter and continues via part", async () => {
    const { env } = makeEnv([VAMP]);
    const r = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", chapter: 2 })) as R;
    expect(r.reading.parts).toBeGreaterThanOrEqual(1);
    if (r.reading.parts > 1) {
      expect(r.more).toMatch(/part: 2/);
      const r2 = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire", chapter: 2, part: 2 })) as R;
      expect(r2.reading.part).toBe(2);
    }
  });

  it("falls back to the vault for a pdf", async () => {
    const { env, r2 } = makeEnv([{ ...VAMP, file_type: "pdf" }]);
    sbList.mockImplementation(async (_e: unknown, path: string) =>
      path === "Books" ? JSON.stringify({ entries: ["Books/Interview with the Vampire/01 - One.md"] })
        : JSON.stringify({ entries: ["Books/Interview with the Vampire/01 - One.md"] }));
    sbRead.mockResolvedValue("vault text");
    const r = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire" })) as R;
    expect(r.loaded).toBe(true);
    expect(r.reading.text).toBe("vault text");
    expect(r2.get).not.toHaveBeenCalled();
  });

  it("falls back to the vault when the R2 object is missing", async () => {
    const { env } = makeEnv([{ ...VAMP, file_key: "gone" }]);
    sbList.mockResolvedValue(JSON.stringify({ entries: ["Books/Interview with the Vampire/01 - One.md"] }));
    sbRead.mockResolvedValue("vault copy");
    const r = await execBookRead(ctx(env, "read", { title: "Interview with the Vampire" })) as R;
    expect(r.reading.text).toBe("vault copy");
  });

  it("honest not-loaded lists Library and vault books", async () => {
    const { env } = makeEnv([VAMP]);
    sbList.mockResolvedValue(JSON.stringify({ entries: ["Books/The Overstory/01.md"] }));
    const r = await execBookRead(ctx(env, "read", { title: "Dune" })) as R;
    expect(r.loaded).toBe(false);
    expect(r.library_books).toEqual(["Interview with the Vampire"]);
    expect(r.available_books).toEqual(["The Overstory"]);
    expect(r.message).toMatch(/NOT read/);
  });
});

describe("margins travel with the text (2026-11-04)", () => {
  const raz = (selected_text: string | null, comment: string | null, at = "2026-11-04 10:00:00"): Ann =>
    ({ author: "raziel", selected_text, comment, created_at: at });

  it("a note on the passage being read comes back with it, by Raziel, in their words", async () => {
    const { env } = makeEnv([VAMP], {}, [
      // DOM text differs from the markdown in spacing and punctuation; flattening still places it
      raz("Lestat  lived in the city among the gaslights -- and the iron balconies", "this is where it turns for me"),
    ]);
    const r: R = await execBookRead(ctx(env, "read from Interview with the Vampire", { chapter: "New Orleans" }));
    expect(r.reading.chapter).toBe(2);
    expect(r.margins).toHaveLength(1);
    expect(r.margins[0]).toMatchObject({ by: "raziel", note: "this is where it turns for me" });
    expect(r.margins_note).toMatch(/Raziel's notes are their own words/);
    expect(r.margins_elsewhere).toBeUndefined();
  });

  it("a note elsewhere in the book is offered as elsewhere (newest first), never as here", async () => {
    const { env } = makeEnv([VAMP], {}, [
      raz("Claudia learned to read before she learned to be afraid", "older", "2026-11-01 10:00:00"),
      raz("Claudia learned to read before she learned to be afraid", "newer", "2026-11-03 10:00:00"),
      raz("Claudia learned to read before she learned", null), // bare highlight elsewhere: not worth tokens
    ]);
    const r: R = await execBookRead(ctx(env, "read from Interview with the Vampire", { chapter: "1" }));
    expect(r.margins).toBeUndefined();
    expect(r.margins_elsewhere.map((m: R) => m.note)).toEqual(["newer", "older"]);
    expect(r.margins_note).toMatch(/3 other note\(s\)/);
  });

  it("search results carry the notes that sit in the excerpts", async () => {
    const { env } = makeEnv([VAMP], {}, [
      { author: "drevan", selected_text: "A cat slept on the sill; the plantation indigo had failed", comment: "the cat stays", created_at: "2026-11-04 09:00:00" },
    ]);
    const r: R = await execBookRead(ctx(env, "read from Interview with the Vampire", { query: "plantation indigo" }));
    expect(r.excerpts.length).toBeGreaterThan(0);
    expect(r.margins[0]).toMatchObject({ by: "drevan", note: "the cat stays" });
  });

  it("a book with no notes reads exactly as before (no margin fields)", async () => {
    const { env } = makeEnv([VAMP]);
    const r: R = await execBookRead(ctx(env, "read from Interview with the Vampire", { chapter: "1" }));
    expect("margins" in r || "margins_elsewhere" in r || "margins_note" in r).toBe(false);
  });

  it("too-short quotes are never placed (a generic line would match anywhere)", async () => {
    const { env } = makeEnv([VAMP], {}, [raz("the boy", "hm")]);
    const r: R = await execBookRead(ctx(env, "read from Interview with the Vampire", { chapter: "1" }));
    expect(r.margins).toBeUndefined();
    expect(r.margins_elsewhere[0].note).toBe("hm");
  });
});
