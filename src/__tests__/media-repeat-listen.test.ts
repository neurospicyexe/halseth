// The same listen, posted twice (2026-10-07). Prod: two media_experiences rows for one Night Vale
// track, 19 minutes apart, same sharer, URLs differing only in YouTube's per-share `?is=` param --
// and they filled both [Recent listens] orient slots. These pin the key, the write guard and the
// read-side collapse.

import { describe, it, expect } from "vitest";
import { canonicalMediaUrl, mediaKey, collapseRepeatListens } from "../lib/media-key.js";
import { postMediaExperience } from "../handlers/media.js";
import type { Env } from "../types.js";

describe("canonicalMediaUrl", () => {
  it("collapses every YouTube share form of one video to yt:<id>", () => {
    const forms = [
      "https://youtu.be/a58_DjCZqA8?is=QKsaDixT",
      "https://youtu.be/a58_DjCZqA8?is=PHaApGi5",
      "https://youtu.be/a58_DjCZqA8?si=abc",
      "https://www.youtube.com/watch?v=a58_DjCZqA8&feature=share",
      "https://m.youtube.com/watch?v=a58_DjCZqA8",
      "https://music.youtube.com/watch?v=a58_DjCZqA8",
      "https://youtube.com/shorts/a58_DjCZqA8",
    ];
    for (const f of forms) expect(canonicalMediaUrl(f)).toBe("yt:a58_DjCZqA8");
  });
  it("keeps different videos apart", () => {
    expect(canonicalMediaUrl("https://youtu.be/Dml0JEgRpc0?is=1")).not.toBe(canonicalMediaUrl("https://youtu.be/a58_DjCZqA8?is=1"));
  });
  it("strips tracking params on other hosts but keeps meaningful ones", () => {
    expect(canonicalMediaUrl("https://open.spotify.com/track/xyz?si=123")).toBe("open.spotify.com/track/xyz");
    expect(canonicalMediaUrl("https://example.com/a?id=2&utm_source=x")).toBe("example.com/a?id=2");
  });
  it("is null for no url", () => {
    expect(canonicalMediaUrl(null)).toBeNull();
    expect(canonicalMediaUrl("  ")).toBeNull();
  });
});

describe("mediaKey + collapseRepeatListens", () => {
  it("falls back to title+artist only without a url", () => {
    expect(mediaKey({ title: "Song ", artist: "A" })).toBe(mediaKey({ title: "song", artist: "a" }));
  });
  it("keeps the newest of a repeat and preserves order", () => {
    const rows = [
      { id: "new", url: "https://youtu.be/a58_DjCZqA8?is=QKsaDixT", title: "Night Vale" },
      { id: "old", url: "https://youtu.be/a58_DjCZqA8?is=PHaApGi5", title: "Night Vale" },
      { id: "other", url: "https://youtu.be/Dml0JEgRpc0?is=3TNr3wUB", title: "Other" },
    ];
    expect(collapseRepeatListens(rows).map(r => r.id)).toEqual(["new", "other"]);
  });
});

describe("POST /mind/media repeat guard", () => {
  const SECRET = "s";
  function env(recent: Array<Record<string, unknown>>, inserts: unknown[][], failLookup = false): Env {
    return {
      ADMIN_SECRET: SECRET,
      DB: {
        prepare: (sql: string) => ({
          bind: (...args: unknown[]) => ({
            all: async () => {
              if (failLookup) throw new Error("d1 down");
              return { results: sql.includes("datetime('now', ?)") ? recent : [] };
            },
            run: async () => { if (sql.startsWith("INSERT")) inserts.push(args); return { meta: { changes: 1 } }; },
          }),
        }),
      },
    } as unknown as Env;
  }
  const post = (body: unknown) => new Request("https://x/mind/media", {
    method: "POST", body: JSON.stringify(body), headers: { Authorization: `Bearer ${SECRET}`, "Content-Type": "application/json" },
  });

  it("a second share of the same video inside the window returns the existing row, 200, no insert", async () => {
    const inserts: unknown[][] = [];
    const res = await postMediaExperience(post({ title: "Night Vale", url: "https://youtu.be/a58_DjCZqA8?is=QKsaDixT" }),
      env([{ id: "8830c9e4", url: "https://youtu.be/a58_DjCZqA8?is=PHaApGi5", title: "Night Vale", artist: null }], inserts));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ deduped: true, experience: { id: "8830c9e4" } });
    expect(inserts).toHaveLength(0);
  });

  it("a different track still records (201)", async () => {
    const inserts: unknown[][] = [];
    const res = await postMediaExperience(post({ title: "Other", url: "https://youtu.be/Dml0JEgRpc0" }),
      env([{ id: "8830c9e4", url: "https://youtu.be/a58_DjCZqA8?is=PHaApGi5", title: "Night Vale", artist: null }], inserts));
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
  });

  it("fails open: a lookup error never blocks the write", async () => {
    const inserts: unknown[][] = [];
    const res = await postMediaExperience(post({ title: "Night Vale", url: "https://youtu.be/a58_DjCZqA8" }), env([], inserts, true));
    expect(res.status).toBe(201);
    expect(inserts).toHaveLength(1);
  });
});
