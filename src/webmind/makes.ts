// src/webmind/makes.ts
//
// Pure logic for "making" (B62, mig 0164; Hand-off/SPEC-B62-making-2026-11-02.md). No I/O here:
// kinds, caps, source checks, the R2 key/mime/ext maps, and the Librarian verb grammar.
// Store + routes: src/handlers/makes.ts. Librarian executors: src/librarian/executors/makes.ts.

import { stripPrivateMarker } from "./interests.js";

export const MAKE_KINDS = ["writing", "page", "music_code", "drawing", "scad", "music_audio", "video"] as const;
export type MakeKind = (typeof MAKE_KINDS)[number];
export const MAKE_COMPANIONS = ["cypher", "drevan", "gaia"] as const;

/** Kinds whose source the companion writes. */
export const SOURCE_KINDS: ReadonlySet<string> = new Set(["writing", "page", "music_code", "drawing", "scad"]);
/** Kinds the Worker finishes itself: ready at once, nothing for the VPS to render. */
export const READY_AT_ONCE: ReadonlySet<string> = new Set(["writing", "page", "music_code"]);

export const MAX_SOURCE_BYTES = 64 * 1024;
export const MAX_TITLE = 120;
export const MAX_MAKE_WHY = 400;
export const MAX_HEARD_BACK = 280;
export const MAX_PROMPT = 1000;
export const MAX_LYRICS = 4000;
export const MAX_FAIL_REASON = 200;
/** Rendered outputs: a 120s mp3 is ~2MB, a short mp4 a few MB. Hard ceilings, not targets. */
export const MAX_RENDER_FILE_BYTES = 30 * 1024 * 1024;
export const MAX_RENDER_PREVIEW_BYTES = 5 * 1024 * 1024;

/** Per companion per UTC day. */
export const DAILY_CAP_TOTAL = 12;
export const DAILY_CAP_BY_KIND: Readonly<Record<string, number>> = { music_audio: 3, video: 2 };
export const MUSIC_MIN_SECONDS = 30;
export const MUSIC_MAX_SECONDS = 120;

export const IMAGE_ID_PREFIX = "img_";
export const MAKE_ID_RE = /^(?:img_)?[0-9a-f]{32}$/;
export const FILE_WHICH = ["source", "file", "preview"] as const;
export type FileWhich = (typeof FILE_WHICH)[number];

// ── Source extension / mime maps ──────────────────────────────────────────────────

/** The ext after "source." in the R2 key and in the download name. */
export const SOURCE_EXT: Readonly<Record<string, string>> = {
  writing: "md", page: "html", music_code: "strudel.js", drawing: "svg", scad: "scad",
};
export const SOURCE_MIME: Readonly<Record<string, string>> = {
  writing: "text/markdown; charset=utf-8",
  page: "text/html; charset=utf-8",
  music_code: "text/javascript; charset=utf-8",
  drawing: "image/svg+xml",
  scad: "text/plain; charset=utf-8",
};
/** What the renderer produces: ext + mime of file.<ext>. */
export const FILE_OUT: Readonly<Record<string, { ext: string; mime: string }>> = {
  drawing: { ext: "png", mime: "image/png" },
  scad: { ext: "stl", mime: "model/stl" },
  music_audio: { ext: "mp3", mime: "audio/mpeg" },
  video: { ext: "mp4", mime: "video/mp4" },
};
export const PREVIEW_EXT = "png";
export const PREVIEW_MIME = "image/png";

/** ?inline=1 is honoured ONLY for these (never svg, html, text: those are download-only). */
export const INLINE_MIMES: ReadonlySet<string> = new Set(["image/png", "audio/mpeg", "video/mp4"]);
/** generate_image rows carry whatever the provider returned; raster images are safe to show inline. */
export const INLINE_IMAGE_MIMES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);

export const sourceKeyFor = (companion: string, id: string, kind: string): string =>
  `makes/${companion}/${id}/source.${SOURCE_EXT[kind] ?? "txt"}`;
export const fileKeyFor = (companion: string, id: string, kind: string): string =>
  `makes/${companion}/${id}/file.${FILE_OUT[kind]?.ext ?? "bin"}`;
export const previewKeyFor = (companion: string, id: string): string =>
  `makes/${companion}/${id}/preview.${PREVIEW_EXT}`;

/** ext of an R2 key's last segment, minus the source./file./preview. stem. */
export function extOfKey(key: string | null | undefined): string | null {
  if (!key) return null;
  const last = key.split("/").pop() ?? "";
  const m = /^(?:source|file|preview)\.(.+)$/.exec(last);
  if (m) return m[1]!;
  const dot = last.lastIndexOf(".");
  return dot > 0 ? last.slice(dot + 1) : null;
}

export function slugify(title: string): string {
  const s = String(title ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/g, "");
  return s || "make";
}

// ── Source checks ───────────────────────────────────────────────────────────────

export const byteLength = (s: string): number => new TextEncoder().encode(s).byteLength;

/** An SVG root, optionally behind an xml prolog / doctype / comments, and closed. */
const SVG_ROOT_RE = /^\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i;
export function looksLikeSvg(src: string): boolean {
  return SVG_ROOT_RE.test(src) && /<\/svg\s*>\s*$/i.test(src);
}

/** The nullsafe-discord renderer applies the SAME deny set; keep the two in step. */
export const SCAD_DENY_RE = /\b(?:include|use|import|surface)\b/;
export const SCAD_MAX_FN = 128;
/** null when the source is allowed, else a short reason. */
export function scadDenyReason(src: string): string | null {
  const m = SCAD_DENY_RE.exec(src);
  if (m) return `scad may not use "${m[0]}" (no includes, imports or surfaces)`;
  const fn = /\$fn\s*=\s*(-?\d+(?:\.\d+)?)/g;
  for (let x = fn.exec(src); x; x = fn.exec(src)) {
    if (Number(x[1]) > SCAD_MAX_FN) return `scad $fn may not exceed ${SCAD_MAX_FN}`;
  }
  return null;
}

// ── Params (music_audio / video) ────────────────────────────────────────────────

export interface MusicParams { prompt: string; lyrics?: string; duration: number; instrumental: boolean }
export interface VideoParams { prompt: string; aspect: "9:16" | "16:9" }

export function normalizeMusicParams(raw: unknown): { ok: true; params: MusicParams } | { ok: false; error: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const prompt = typeof o.prompt === "string" ? o.prompt.replace(/\s+/g, " ").trim() : "";
  if (!prompt) return { ok: false, error: "params.prompt required for music_audio" };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `params.prompt over ${MAX_PROMPT} characters` };
  const lyrics = typeof o.lyrics === "string" ? o.lyrics.trim() : "";
  if (lyrics.length > MAX_LYRICS) return { ok: false, error: `params.lyrics over ${MAX_LYRICS} characters` };
  const d = Number(o.duration);
  const duration = Math.min(MUSIC_MAX_SECONDS, Math.max(MUSIC_MIN_SECONDS, Number.isFinite(d) ? Math.round(d) : MUSIC_MIN_SECONDS));
  const instrumental = typeof o.instrumental === "boolean" ? o.instrumental : !lyrics;
  return { ok: true, params: { prompt, ...(lyrics ? { lyrics } : {}), duration, instrumental } };
}

export function normalizeVideoParams(raw: unknown): { ok: true; params: VideoParams } | { ok: false; error: string } {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const prompt = typeof o.prompt === "string" ? o.prompt.replace(/\s+/g, " ").trim() : "";
  if (!prompt) return { ok: false, error: "params.prompt required for video" };
  if (prompt.length > MAX_PROMPT) return { ok: false, error: `params.prompt over ${MAX_PROMPT} characters` };
  const a = o.aspect === undefined || o.aspect === null || o.aspect === "" ? "9:16" : String(o.aspect);
  if (a !== "9:16" && a !== "16:9") return { ok: false, error: "params.aspect must be 9:16 or 16:9" };
  return { ok: true, params: { prompt, aspect: a } };
}

// ── Librarian verb grammar ──────────────────────────────────────────────────────
// "make a <kind words> called <title> [for <interest>] because <why>"   (because optional)
// Strictly start-anchored and "called"-gated, so ordinary speech and the other verbs are untouched:
//   "made <thing> for <interest> because <why>"  is past tense; it stays the interest `made` event
//   "make an image of ..."                        has no "called"; it stays generate_image
//   "who is <person>"                             never starts with "make"

const KIND_WORD = String.raw`(?:drawing|svg|scad|3d[\s-]*(?:print|model)|model|song|track|music|strudel|beat|pattern|page|website|toy|poem|story|writing|video|clip)`;
const NOT_BECAUSE = String.raw`(?:(?!\bbecause\b)[\s\S])`;
const SEP = String.raw`\s*[,;:]?\s+because\b[\s,:]*`;

export const MAKE_VERB_RE = new RegExp(
  String.raw`^(?:please\s+)?make\s+(?:me\s+)?(?:an?\s+|the\s+)?((?:[\w'-]+\s+){0,3}?${KIND_WORD})\s+called\s+(${NOT_BECAUSE}+?)(?:${SEP}([\s\S]+))?\s*[.!]?$`,
  "i",
);
export const MAKES_READ_RE = /^(?:please\s+)?(?:(?:show|list|read)\s+)?my\s+makes\s*[?.!]?$/i;

/** Kind words -> kind. Order is the tie-break ("strudel pattern" is code, "3d model" is scad). */
const KIND_MAP: ReadonlyArray<readonly [RegExp, MakeKind]> = [
  [/\bscad\b|\b3d\b/i, "scad"],
  [/\bstrudel\b/i, "music_code"],
  [/\b(?:video|clip)\b/i, "video"],
  [/\b(?:drawing|svg)\b/i, "drawing"],
  [/\b(?:song|track|music)\b/i, "music_audio"],
  [/\b(?:beat|pattern)\b/i, "music_code"],
  [/\b(?:page|website|toy)\b/i, "page"],
  [/\b(?:poem|story|writing)\b/i, "writing"],
  [/\bmodel\b/i, "scad"],
];
export function mapKindWords(phrase: string): MakeKind | null {
  for (const [re, kind] of KIND_MAP) if (re.test(phrase)) return kind;
  return null;
}

export function cleanTitle(raw: string): string {
  return raw.trim().replace(/^["'`*_]+|["'`*_]+$/g, "").replace(/\s+/g, " ").trim();
}

export interface ParsedMakeVerb {
  kind: MakeKind;
  /** The whole head, "for <x>" included. */
  title_full: string;
  /** Head before the LAST " for ", or null when there is no "for". */
  title_before_for: string | null;
  /** What followed that last "for": a candidate interest name, resolved (or dropped) by the executor. */
  interest_candidate: string | null;
  why: string;
  why_private: boolean;
}

export function parseMakeVerb(request: string): ParsedMakeVerb | null {
  const m = MAKE_VERB_RE.exec(request.trim());
  if (!m) return null;
  const kind = mapKindWords(m[1]!);
  if (!kind) return null;
  const head = cleanTitle(m[2] ?? "");
  const p = stripPrivateMarker(m[3] ?? "");
  const forAt = head.search(/\s+for\s+(?!.*\s+for\s+)/i);
  let title_before_for: string | null = null;
  let interest_candidate: string | null = null;
  if (forAt > 0) {
    const t = cleanTitle(head.slice(0, forAt));
    const i = cleanTitle(head.slice(forAt).replace(/^\s+for\s+/i, ""));
    if (t && i) { title_before_for = t; interest_candidate = i; }
  }
  return {
    kind, title_full: head, title_before_for, interest_candidate,
    why: p.text.replace(/^[\s,;:\-]+/, "").trim(), why_private: p.why_private,
  };
}
