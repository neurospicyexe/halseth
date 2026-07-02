// Human-readable relative time for companion-facing context blocks.
//
// Companions surface time-bound items (recent listens, forage finds) in their boot/orient
// context and in autonomous seeds. Without an explicit "how long ago" anchor, the model
// guesses -- and guesses wrong (2026-06-17: Drevan called a 2-days-ago listen "yesterday").
// Stamping each item with a relative label gives them the exact phrasing to echo, so their
// sense of time tracks reality instead of drifting.
//
// Pure and dependency-free. `now` is injectable for tests. Past timestamps only (these are
// all "things that already happened"); a future/invalid input degrades to "recently".

// SQLite's datetime('now') emits "YYYY-MM-DD HH:MM:SS" -- UTC, but with no timezone
// suffix. Date.parse reads that bare form as LOCAL time off-Worker (vitest, Node tooling),
// skewing ages by the host offset. Normalize bare SQLite stamps to explicit UTC first;
// proper ISO strings (with T/Z or offset) pass through untouched.
const SQLITE_UTC = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/;

export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "recently";
  const m = SQLITE_UTC.exec(iso);
  const then = Date.parse(m ? `${m[1]}T${m[2]}Z` : iso);
  if (!Number.isFinite(then)) return "recently";

  const sec = Math.round((now - then) / 1000);
  if (sec < 90) return "just now"; // covers clock-skew / future stamps too (sec <= 0)

  const min = Math.round(sec / 60);
  if (min < 90) return min <= 1 ? "a minute ago" : `${min} minutes ago`;

  // Hours cap at 24 so a ~1-day-old item tips into "yesterday" rather than "24 hours ago".
  const hr = Math.round(min / 60);
  if (hr < 24) return hr <= 1 ? "an hour ago" : `${hr} hours ago`;

  const day = Math.round(hr / 24);
  if (day === 1) return "yesterday";
  if (day < 14) return `${day} days ago`;

  // Coarse buckets floor (don't round up): 75 days reads "2 months ago", not "3".
  const wk = Math.floor(day / 7);
  if (wk < 8) return `${wk} weeks ago`;

  const mo = Math.floor(day / 30);
  if (mo < 12) return mo <= 1 ? "a month ago" : `${mo} months ago`;

  const yr = Math.floor(day / 365);
  return yr <= 1 ? "a year ago" : `${yr} years ago`;
}
