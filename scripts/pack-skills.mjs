#!/usr/bin/env node
// Pack halseth/skills/<name>/ into ../skills/<name>.skill (a zip whose entries are `<name>/SKILL.md`
// and any sibling files, the same layout Claude.ai exports), so the checked-in directory is the
// source of truth and src/__tests__/skills-phrases.test.ts keeps the verb phrases honest.
//
// Usage:  node scripts/pack-skills.mjs [name ...]      (no args = every directory under skills/)
//         npm run pack:skills -- nullsafe-mid-thread-orient companion-journal-review
//
// Hand-rolled zip writer (store + deflate via zlib) -- no archiver dependency. Files are deflated
// when that is smaller, stored otherwise. Dates are fixed at 1980-01-01 so a repack of unchanged
// content is byte-identical.
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, resolve, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";

const HERE = dirname(fileURLToPath(import.meta.url));
const SKILLS_SRC = resolve(HERE, "..", "skills");
const OUT_DIR = resolve(HERE, "..", "..", "skills");

// CRC-32 (IEEE), table-driven.
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c >>> 0;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// DOS date/time for 1980-01-01 00:00:00 -- deterministic output.
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // year 0 (=1980), month 1, day 1

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n, 0); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0, 0); return b; }

/** entries: Array<{ name: string, data: Buffer }> -> zip Buffer */
export function buildZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(data);
    const flags = 0x0800; // UTF-8 names
    const local = Buffer.concat([
      u32(0x04034b50), u16(20), u16(flags), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(payload.length), u32(data.length), u16(nameBuf.length), u16(0),
      nameBuf, payload,
    ]);
    const central = Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(flags), u16(method), u16(DOS_TIME), u16(DOS_DATE),
      u32(crc), u32(payload.length), u32(data.length), u16(nameBuf.length), u16(0), u16(0),
      u16(0), u16(0), u32(0), u32(offset), nameBuf,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralDir = Buffer.concat(centrals);
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(centralDir.length), u32(offset), u16(0),
  ]);
  return Buffer.concat([...locals, centralDir, eocd]);
}

function walk(dir, base = dir) {
  const out = [];
  for (const ent of readdirSync(dir).sort()) {
    const p = join(dir, ent);
    if (statSync(p).isDirectory()) out.push(...walk(p, base));
    else out.push(relative(base, p).split(sep).join("/"));
  }
  return out;
}

export function packSkill(name) {
  const src = join(SKILLS_SRC, name);
  if (!existsSync(join(src, "SKILL.md"))) throw new Error(`${name}: no SKILL.md under ${src}`);
  const entries = walk(src).map((rel) => ({ name: `${name}/${rel}`, data: readFileSync(join(src, rel)) }));
  const zip = buildZip(entries);
  mkdirSync(OUT_DIR, { recursive: true });
  const outPath = join(OUT_DIR, `${name}.skill`);
  writeFileSync(outPath, zip);
  return { outPath, entries: entries.map((e) => e.name), bytes: zip.length };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const names = process.argv.slice(2).length
    ? process.argv.slice(2)
    : readdirSync(SKILLS_SRC).filter((d) => statSync(join(SKILLS_SRC, d)).isDirectory());
  for (const name of names) {
    const r = packSkill(name);
    console.log(`${name} -> ${r.outPath} (${r.bytes} bytes): ${r.entries.join(", ")}`);
  }
}
