#!/usr/bin/env node
// epub-to-vault.mjs -- convert an epub into per-chapter markdown for the Obsidian vault
// (the companion copy; the epub itself goes to the Library via upload-books.ps1).
//
//   node scripts/epub-to-vault.mjs "D:\books\Interview with the Vampire.epub" "C:\path\to\vault"
//   node scripts/epub-to-vault.mjs "D:\books" "C:\path\to\vault"        # whole folder
//
// Writes <vault>/Books/<Title>/NN - <Chapter>.md in spine order. One file per
// chapter (clean chunk boundaries for the Second Brain ingester). Zero deps:
// same central-directory zip walk as src/lib/epub.ts, plus a prose-grade
// XHTML -> markdown pass (book markup is simple; headings, emphasis, quotes,
// lists survive; layout soup is flattened to paragraphs).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import { inflateRawSync } from "node:zlib";

// ── zip ──────────────────────────────────────────────────────────────────────
function parseEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return [];
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    if (off + 46 > buf.length || buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compressedSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOffset = buf.readUInt32LE(off + 42);
    entries.push({ name: buf.toString("utf8", off + 46, off + 46 + nameLen), method, compressedSize, localOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function readEntry(buf, e) {
  if (buf.readUInt32LE(e.localOffset) !== 0x04034b50) return null;
  const nameLen = buf.readUInt16LE(e.localOffset + 26);
  const extraLen = buf.readUInt16LE(e.localOffset + 28);
  const start = e.localOffset + 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + e.compressedSize);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) { try { return inflateRawSync(data); } catch { return null; } }
  return null;
}
const textEntry = (buf, entries, name) => {
  const e = entries.find(x => x.name === name) ?? entries.find(x => x.name.toLowerCase() === name.toLowerCase());
  const b = e ? readEntry(buf, e) : null;
  return b ? b.toString("utf8") : null;
};

// ── xhtml -> markdown (prose-grade) ─────────────────────────────────────────
function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&apos;/gi, "'").replace(/&mdash;/gi, "—").replace(/&ndash;/gi, "–")
    .replace(/&hellip;/gi, "…").replace(/&rsquo;/gi, "’").replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”").replace(/&ldquo;/gi, "“")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)));
}
function htmlToMarkdown(xhtml) {
  let s = xhtml
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(?:script|style|head)\b[\s\S]*?<\/(?:script|style|head)>/gi, "")
    .replace(/\r\n?/g, "\n");
  // block-level structure first
  s = s
    .replace(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi, (_, t) => `\n\n# ${t}\n\n`)
    .replace(/<h2\b[^>]*>([\s\S]*?)<\/h2>/gi, (_, t) => `\n\n## ${t}\n\n`)
    .replace(/<h([3-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi, (_, n, t) => `\n\n${"#".repeat(Number(n))} ${t}\n\n`)
    .replace(/<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi, (_, t) => `\n\n> ${t.trim().replace(/\n+/g, "\n> ")}\n\n`)
    .replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, t) => `\n- ${t.trim()}`)
    .replace(/<hr\b[^>]*\/?>/gi, "\n\n---\n\n")
    .replace(/<br\b[^>]*\/?>/gi, "\n")
    .replace(/<\/(?:p|div|section|article)>/gi, "\n\n");
  // inline emphasis
  s = s
    .replace(/<(?:em|i)\b[^>]*>([\s\S]*?)<\/(?:em|i)>/gi, (_, t) => `*${t}*`)
    .replace(/<(?:strong|b)\b[^>]*>([\s\S]*?)<\/(?:strong|b)>/gi, (_, t) => `**${t}**`);
  // everything else: flatten
  s = s.replace(/<[^>]+>/g, "");
  s = decodeEntities(s);
  // tidy: collapse >2 blank lines, trim trailing space per line
  return s.split("\n").map(l => l.replace(/\s+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ── opf: metadata + spine order ─────────────────────────────────────────────
const attr = (tag, name) =>
  tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1] ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"))?.[1] ?? null;
function resolveHref(opfPath, href) {
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const out = [];
  for (const p of (dir + decodeURIComponent(href.split("#")[0])).split("/")) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop(); else out.push(p);
  }
  return out.join("/");
}
const sanitize = (s) => s.replace(/[<>:"/\\|?*]/g, "").replace(/\s+/g, " ").trim().slice(0, 120);

function convertEpub(epubPath, vaultPath) {
  const buf = readFileSync(epubPath);
  const entries = parseEntries(buf);
  const container = textEntry(buf, entries, "META-INF/container.xml");
  const opfPath = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
  if (!opfPath) { console.error(`  x ${basename(epubPath)}: not a valid epub (no container.xml)`); return false; }
  const opf = textEntry(buf, entries, opfPath);
  if (!opf) { console.error(`  x ${basename(epubPath)}: OPF missing`); return false; }

  const title = opf.match(/<dc:title[^>]*>([\s\S]*?)<\/dc:title>/i)?.[1]?.replace(/<[^>]+>/g, "").trim()
    || basename(epubPath).replace(/\.epub$/i, "");
  const author = opf.match(/<dc:creator[^>]*>([\s\S]*?)<\/dc:creator>/i)?.[1]?.replace(/<[^>]+>/g, "").trim() || null;

  const manifest = new Map();
  for (const tag of opf.match(/<(?:opf:)?item\s[^>]*>/gi) ?? []) {
    const id = attr(tag, "id"), href = attr(tag, "href");
    if (id && href) manifest.set(id, { href, mediaType: attr(tag, "media-type") ?? "" });
  }
  const spine = [];
  for (const tag of opf.match(/<(?:opf:)?itemref\s[^>]*>/gi) ?? []) {
    const idref = attr(tag, "idref");
    const item = idref ? manifest.get(idref) : null;
    if (item && /html|xml/i.test(item.mediaType)) spine.push(item.href);
  }
  if (spine.length === 0) { console.error(`  x ${basename(epubPath)}: empty spine`); return false; }

  const bookDir = join(vaultPath, "Books", sanitize(decodeEntities(title)));
  mkdirSync(bookDir, { recursive: true });

  let written = 0, skippedTiny = 0;
  for (const href of spine) {
    const xhtml = textEntry(buf, entries, resolveHref(opfPath, href));
    if (!xhtml) continue;
    const md = htmlToMarkdown(xhtml);
    // front matter, blank separators, nav pages: skip near-empty chapters
    if (md.replace(/[#>\-\s*]/g, "").length < 200) { skippedTiny++; continue; }
    written++;
    const chapTitle = md.match(/^#{1,6}\s+(.+)$/m)?.[1]?.trim() || `Chapter ${written}`;
    const nn = String(written).padStart(2, "0");
    const header = `---\nbook: "${decodeEntities(title).replace(/"/g, "'")}"\n${author ? `author: "${author.replace(/"/g, "'")}"\n` : ""}chapter: ${written}\nsource: epub\n---\n\n`;
    writeFileSync(join(bookDir, `${nn} - ${sanitize(chapTitle)}.md`), header + md + "\n", "utf8");
  }
  console.log(`  + ${decodeEntities(title)}${author ? ` -- ${author}` : ""}: ${written} chapters -> ${bookDir}${skippedTiny ? ` (${skippedTiny} near-empty spine items skipped)` : ""}`);
  return written > 0;
}

// ── main ─────────────────────────────────────────────────────────────────────
const [input, vault] = process.argv.slice(2);
if (!input || !vault) {
  console.error('usage: node scripts/epub-to-vault.mjs "<book.epub | folder>" "<obsidian vault path>"');
  process.exit(1);
}
if (!existsSync(vault)) { console.error(`vault path not found: ${vault}`); process.exit(1); }
const targets = statSync(input).isDirectory()
  ? readdirSync(input).filter(f => f.toLowerCase().endsWith(".epub")).map(f => join(input, f))
  : [input];
if (targets.length === 0) { console.error("no .epub files found"); process.exit(1); }
console.log(`Converting ${targets.length} book(s) into ${join(vault, "Books")} ...`);
let ok = 0;
for (const t of targets) { try { if (convertEpub(t, vault)) ok++; } catch (e) { console.error(`  x ${basename(t)}: ${e.message}`); } }
console.log(`Done. ${ok}/${targets.length} converted. LiveSync + the 20-min ingestion cron take it from here.`);
