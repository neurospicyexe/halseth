// Tests for the zero-dependency epub metadata extractor (src/lib/epub.ts).
// We build real zip bytes by hand (local headers + central directory + EOCD)
// so the parser is exercised against the actual format, not a mock -- including
// one deflate-raw entry to cover the DecompressionStream path.

import { describe, it, expect } from "vitest";
import { deflateRawSync } from "node:zlib";
import { extractEpubMetadata } from "../lib/epub.js";

interface BuiltEntry { name: string; data: Uint8Array; method: 0 | 8 }

function u16(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff]; }
function u32(n: number): number[] { return [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff]; }

/** Minimal valid zip: local file headers, central directory, EOCD. CRCs zeroed (parser ignores them). */
function buildZip(entries: BuiltEntry[]): ArrayBuffer {
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

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;

function opf(extraMeta = "", manifestExtra = ""): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>The Overstory</dc:title>
    <dc:creator>Richard Powers</dc:creator>
    <dc:description>Trees &amp; the people who hear them.</dc:description>
    <dc:language>en</dc:language>
    ${extraMeta}
  </metadata>
  <manifest>
    <item id="chap1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    ${manifestExtra}
  </manifest>
</package>`;
}

const enc = new TextEncoder();
// >1KB so it survives the junk-cover floor.
const coverBytes = new Uint8Array(2048).fill(0x42);

describe("extractEpubMetadata", () => {
  it("extracts dc fields from a stored-entry epub", async () => {
    const zip = buildZip([
      { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
      { name: "OEBPS/content.opf", data: enc.encode(opf()), method: 0 },
    ]);
    const meta = await extractEpubMetadata(zip);
    expect(meta.title).toBe("The Overstory");
    expect(meta.author).toBe("Richard Powers");
    expect(meta.description).toBe("Trees & the people who hear them.");
    expect(meta.language).toBe("en");
  });

  it("inflates deflate-raw entries (the common real-world case)", async () => {
    const zip = buildZip([
      { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 8 },
      { name: "OEBPS/content.opf", data: enc.encode(opf()), method: 8 },
    ]);
    const meta = await extractEpubMetadata(zip);
    expect(meta.title).toBe("The Overstory");
    expect(meta.author).toBe("Richard Powers");
  });

  it("finds the cover via <meta name=cover> and resolves the OPF-relative href", async () => {
    const zip = buildZip([
      { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
      {
        name: "OEBPS/content.opf",
        data: enc.encode(opf(
          `<meta name="cover" content="cov"/>`,
          `<item id="cov" href="images/cover.jpg" media-type="image/jpeg"/>`,
        )),
        method: 0,
      },
      { name: "OEBPS/images/cover.jpg", data: coverBytes, method: 0 },
    ]);
    const meta = await extractEpubMetadata(zip);
    expect(meta.cover).not.toBeNull();
    expect(meta.cover!.mediaType).toBe("image/jpeg");
    expect(meta.cover!.data.byteLength).toBe(2048);
  });

  it("finds an EPUB 3 properties=cover-image cover with ../ href resolution", async () => {
    const zip = buildZip([
      { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
      {
        name: "OEBPS/content.opf",
        data: enc.encode(opf("", `<item id="ci" href="../art/c.png" properties="cover-image" media-type="image/png"/>`)),
        method: 0,
      },
      { name: "art/c.png", data: coverBytes, method: 0 },
    ]);
    const meta = await extractEpubMetadata(zip);
    expect(meta.cover).not.toBeNull();
    expect(meta.cover!.mediaType).toBe("image/png");
  });

  it("discards a sub-1KB junk cover", async () => {
    const zip = buildZip([
      { name: "META-INF/container.xml", data: enc.encode(CONTAINER), method: 0 },
      {
        name: "OEBPS/content.opf",
        data: enc.encode(opf(`<meta name="cover" content="cov"/>`, `<item id="cov" href="tiny.jpg" media-type="image/jpeg"/>`)),
        method: 0,
      },
      { name: "OEBPS/tiny.jpg", data: new Uint8Array(64), method: 0 },
    ]);
    const meta = await extractEpubMetadata(zip);
    expect(meta.cover).toBeNull();
    expect(meta.title).toBe("The Overstory"); // metadata still lands
  });

  it("returns empty metadata (never throws) on garbage bytes", async () => {
    const meta = await extractEpubMetadata(new Uint8Array([1, 2, 3, 4, 5]).buffer);
    expect(meta).toEqual({ title: null, author: null, description: null, language: null, cover: null });
  });

  it("returns empty metadata when container.xml is missing", async () => {
    const zip = buildZip([{ name: "mimetype", data: enc.encode("application/epub+zip"), method: 0 }]);
    const meta = await extractEpubMetadata(zip);
    expect(meta.title).toBeNull();
  });
});
