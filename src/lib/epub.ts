// src/lib/epub.ts
//
// Minimal EPUB metadata extraction inside a Worker -- no zip library. An epub is
// a zip; we parse the central directory by hand and inflate single entries with
// DecompressionStream("deflate-raw") (a Web platform primitive, available in
// workerd). Technique adapted from Catalouge (amarisaster), hardened: we walk
// the central directory instead of scanning local headers, so data descriptors
// and nested signatures can't fool entry boundaries.
//
// Extraction is best-effort by design: a malformed epub yields empty metadata,
// never a throw at the upload path.

interface ZipEntry {
  name: string;
  method: number;      // 0 = stored, 8 = deflate
  compressedSize: number;
  localHeaderOffset: number;
}

export interface EpubMetadata {
  title: string | null;
  author: string | null;
  description: string | null;
  language: string | null;
  cover: { data: Uint8Array; mediaType: string } | null;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function readU16(view: DataView, off: number): number { return view.getUint16(off, true); }
function readU32(view: DataView, off: number): number { return view.getUint32(off, true); }

/** Locate the End Of Central Directory record (scan backward past any zip comment). */
function findEocd(view: DataView): number | null {
  const min = Math.max(0, view.byteLength - 22 - 65535);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (readU32(view, i) === EOCD_SIG) return i;
  }
  return null;
}

function parseEntries(buf: ArrayBuffer): ZipEntry[] {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  if (eocd === null) return [];
  const count = readU16(view, eocd + 10);
  const cdirOffset = readU32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  const decoder = new TextDecoder();
  let off = cdirOffset;
  for (let i = 0; i < count; i++) {
    if (off + 46 > view.byteLength || readU32(view, off) !== CDIR_SIG) break;
    const method = readU16(view, off + 10);
    const compressedSize = readU32(view, off + 20);
    const nameLen = readU16(view, off + 28);
    const extraLen = readU16(view, off + 30);
    const commentLen = readU16(view, off + 32);
    const localHeaderOffset = readU32(view, off + 42);
    const name = decoder.decode(new Uint8Array(buf, off + 46, nameLen));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Read + inflate one entry. The local header carries its own name/extra lengths. */
async function readEntry(buf: ArrayBuffer, entry: ZipEntry): Promise<Uint8Array | null> {
  const view = new DataView(buf);
  const off = entry.localHeaderOffset;
  if (off + 30 > view.byteLength || readU32(view, off) !== LOCAL_SIG) return null;
  const nameLen = readU16(view, off + 26);
  const extraLen = readU16(view, off + 28);
  const dataStart = off + 30 + nameLen + extraLen;
  if (dataStart + entry.compressedSize > view.byteLength) return null;
  const data = new Uint8Array(buf, dataStart, entry.compressedSize);
  if (entry.method === 0) return new Uint8Array(data);
  if (entry.method !== 8) return null;
  try {
    const stream = new Blob([new Uint8Array(data)]).stream()
      .pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

async function readTextEntry(buf: ArrayBuffer, entries: ZipEntry[], name: string): Promise<string | null> {
  const entry = entries.find(e => e.name === name)
    ?? entries.find(e => e.name.toLowerCase() === name.toLowerCase());
  if (!entry) return null;
  const bytes = await readEntry(buf, entry);
  return bytes ? new TextDecoder().decode(bytes) : null;
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(parseInt(d, 10)));
}

/** First match of a dc: element's text content, tags stripped. */
function dcField(opf: string, field: string): string | null {
  const m = opf.match(new RegExp(`<dc:${field}[^>]*>([\\s\\S]*?)</dc:${field}>`, "i"));
  if (!m?.[1]) return null;
  const text = decodeXmlEntities(m[1].replace(/<[^>]+>/g, "").trim());
  return text || null;
}

const IMAGE_TYPES: Record<string, string> = {
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
};

function mediaTypeFor(href: string, declared: string | null): string {
  if (declared?.startsWith("image/")) return declared;
  const ext = href.slice(href.lastIndexOf(".")).toLowerCase();
  return IMAGE_TYPES[ext] ?? "image/jpeg";
}

/** Resolve an OPF-relative href against the OPF's directory, collapsing ../ segments. */
function resolveHref(opfPath: string, href: string): string {
  const dir = opfPath.includes("/") ? opfPath.slice(0, opfPath.lastIndexOf("/") + 1) : "";
  const parts = (dir + decodeURIComponent(href)).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

interface ManifestItem { id: string; href: string; mediaType: string | null; properties: string | null }

function parseManifest(opf: string): ManifestItem[] {
  const items: ManifestItem[] = [];
  for (const tag of opf.match(/<(?:opf:)?item\s[^>]*>/gi) ?? []) {
    const attr = (name: string) => tag.match(new RegExp(`${name}\\s*=\\s*"([^"]*)"`, "i"))?.[1]
      ?? tag.match(new RegExp(`${name}\\s*=\\s*'([^']*)'`, "i"))?.[1] ?? null;
    const id = attr("id");
    const href = attr("href");
    if (!id || !href) continue;
    items.push({ id, href, mediaType: attr("media-type"), properties: attr("properties") });
  }
  return items;
}

/**
 * Cover discovery, four strategies in confidence order (mirrors what real-world
 * epubs actually do):
 *   1. <meta name="cover" content="<item-id>"> in the OPF metadata
 *   2. manifest item with properties~="cover-image" (EPUB 3)
 *   3. manifest image item whose id contains "cover"
 *   4. first image item in the manifest
 */
function findCoverHref(opf: string, items: ManifestItem[]): ManifestItem | null {
  const isImage = (i: ManifestItem) =>
    (i.mediaType?.startsWith("image/") ?? false) || /\.(jpe?g|png|gif|webp|svg)$/i.test(i.href);
  const metaCoverId = opf.match(/<meta\s[^>]*name\s*=\s*["']cover["'][^>]*content\s*=\s*["']([^"']+)["']/i)?.[1]
    ?? opf.match(/<meta\s[^>]*content\s*=\s*["']([^"']+)["'][^>]*name\s*=\s*["']cover["']/i)?.[1];
  if (metaCoverId) {
    const item = items.find(i => i.id === metaCoverId);
    if (item && isImage(item)) return item;
  }
  return items.find(i => i.properties?.split(/\s+/).includes("cover-image") && isImage(i))
    ?? items.find(i => /cover/i.test(i.id) && isImage(i))
    ?? items.find(isImage)
    ?? null;
}

export async function extractEpubMetadata(buf: ArrayBuffer): Promise<EpubMetadata> {
  const empty: EpubMetadata = { title: null, author: null, description: null, language: null, cover: null };
  try {
    const entries = parseEntries(buf);
    if (entries.length === 0) return empty;

    const container = await readTextEntry(buf, entries, "META-INF/container.xml");
    const opfPath = container?.match(/full-path\s*=\s*["']([^"']+)["']/i)?.[1];
    if (!opfPath) return empty;

    const opf = await readTextEntry(buf, entries, opfPath);
    if (!opf) return empty;

    const meta: EpubMetadata = {
      title: dcField(opf, "title"),
      author: dcField(opf, "creator"),
      description: dcField(opf, "description"),
      language: dcField(opf, "language"),
      cover: null,
    };

    const items = parseManifest(opf);
    const coverItem = findCoverHref(opf, items);
    if (coverItem) {
      const coverPath = resolveHref(opfPath, coverItem.href);
      const entry = entries.find(e => e.name === coverPath);
      const bytes = entry ? await readEntry(buf, entry) : null;
      // Anything under ~1KB is a placeholder or junk, not a cover.
      if (bytes && bytes.byteLength > 1000) {
        meta.cover = { data: bytes, mediaType: mediaTypeFor(coverItem.href, coverItem.mediaType) };
      }
    }
    return meta;
  } catch {
    return empty;
  }
}
