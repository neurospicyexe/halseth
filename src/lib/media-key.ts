// src/lib/media-key.ts
//
// One identity for "the same listen" (2026-10-07). Drevan's orient carried the same Night Vale
// track twice under [Recent listens]: two media_experiences rows 19 minutes apart, same YouTube
// video, same sharer -- the URLs differed ONLY in YouTube's per-share tracking param (`?is=...`;
// `?si=` on newer clients). POST /mind/media had no dedup at all, and the orient block takes the
// newest two rows, so a double-post filled both slots with one song.
//
// Used at write (handlers/media.ts: a repeat inside the window returns the existing row) and at
// read (mind/blocks/world.ts: rows that already exist collapse before the slice). Pure.

/** Query params that identify a SHARE, not the media. Stripped before comparing. */
const TRACKING_PARAMS = /^(si|is|feature|pp|ab_channel|utm_[a-z_]+|fbclid|gclid|igsh|ref|ref_src)$/i;

/** YouTube video ids are 11 chars of [A-Za-z0-9_-]. */
const YT_ID = /^[A-Za-z0-9_-]{11}$/;

function youtubeId(u: URL): string | null {
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, "").toLowerCase();
  let id: string | null = null;
  if (host === "youtu.be") id = u.pathname.split("/")[1] ?? null;
  else if (host === "youtube.com" || host === "youtube-nocookie.com") {
    if (u.pathname === "/watch") id = u.searchParams.get("v");
    else {
      const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([^/?#]+)/);
      id = m ? m[1]! : null;
    }
  }
  return id && YT_ID.test(id) ? id : null;
}

/**
 * Canonical key for a media URL: `yt:<videoId>` for every YouTube form, otherwise
 * host+path+non-tracking query, lowercased host, no fragment. Null for no/unparseable URL.
 */
export function canonicalMediaUrl(raw: string | null | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!s) return null;
  let u: URL;
  try { u = new URL(s); } catch { return s.toLowerCase(); }
  const yt = youtubeId(u);
  if (yt) return `yt:${yt}`;
  const kept = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const q = kept.length ? "?" + kept.map(([k, v]) => `${k}=${v}`).join("&") : "";
  const host = u.hostname.replace(/^www\./, "").toLowerCase();
  return `${host}${u.pathname.replace(/\/+$/, "")}${q}`;
}

function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * The key two rows must share to be the same listen. URL when there is one (titles get re-scraped
 * and drift); title+artist only when there is no URL.
 */
export function mediaKey(m: { url?: string | null; title?: string | null; artist?: string | null }): string {
  const u = canonicalMediaUrl(m.url);
  if (u) return `u:${u}`;
  return `t:${norm(m.title)}|${norm(m.artist)}`;
}

/** Hours inside which a second post of the same media is the same listen, not a re-listen. */
export const MEDIA_REPEAT_WINDOW_HOURS = 24;

/**
 * Keep the newest row per key, preserving order. Input is newest-first (the loader's ORDER BY), so
 * the first occurrence wins -- the row the bot is most likely to have reacted to last.
 */
export function collapseRepeatListens<T extends { url?: string | null; title?: string | null; artist?: string | null }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const r of rows) {
    const k = mediaKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}
