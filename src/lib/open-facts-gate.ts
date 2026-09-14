// src/lib/open-facts-gate.ts
//
// ONE rule for how many `status='open'` architect facts reach a prompt, shared by the Claude.ai
// orient block (librarian/response/orient-blocks.ts) and the /identity/architect-facts/render
// endpoint the VPS sync pulls into the bots' prompt files. Two renderers, one gate -- if they
// disagreed, the same companion would carry different questions on different surfaces.
//
// WHY (2026-09-14). The Hermes memory-queue drain (2026-08-12) posted every "user"-target proposal
// as `open` "so it surfaces for confirmation". Nothing confirms them: no Hearth surface, no verb a
// companion reaches for. Measured today: 107 open rows, 105 of them drain output, oldest 33 days,
// 21,847 chars -- rendered in FULL at every Claude.ai orient as "[About Raziel -- OPEN, ask rather
// than assume]", against 7,907 chars of confirmed facts. A block that tells a companion to hold 107
// stale questions about the person in front of them is a load, not a memory; Raziel named the
// symptom the same day: "you're carrying things that you shouldn't and dropping other things."
//
// The rule: an open fact is a QUESTION, and a question nobody asked in two weeks is not a live
// question. Render the newest few, hold the rest, and SAY how many are held so the pile is
// visible without being carried. The store is untouched (mig 0116 covenant: bound the render,
// never the store); Hearth /facts is where the held ones get confirmed or retired.

export interface OpenFactLike {
  id: string;
  fact: string;
  status: string;
  created_at?: string | null;
}

export interface OpenFactsGateOptions {
  /** Open facts older than this are held, not rendered. */
  maxAgeDays?: number;
  /** At most this many open facts render, newest first. */
  max?: number;
  /** Injected clock for tests. */
  now?: Date;
}

export interface OpenFactsGateResult<T extends OpenFactLike> {
  shown: T[];
  held: T[];
  /** Age in whole days of the oldest held fact, or null when nothing is held / undated. */
  oldestHeldDays: number | null;
}

export const OPEN_FACTS_MAX_AGE_DAYS = 14;
export const OPEN_FACTS_MAX = 8;

function parseStamp(s: string | null | undefined): number {
  if (!s) return NaN;
  // D1 writes `datetime('now')` as "YYYY-MM-DD HH:MM:SS" (UTC, no zone); ISO strings pass through.
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  return Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(iso) ? iso : iso + "Z");
}

/**
 * Split `status='open'` rows into the few that render and the many that are held. Rows that are
 * not `open` are ignored (callers filter active facts themselves). Undated rows count as old:
 * a question with no birth date has no claim to freshness.
 */
export function gateOpenFacts<T extends OpenFactLike>(
  rows: readonly T[],
  opts: OpenFactsGateOptions = {},
): OpenFactsGateResult<T> {
  const maxAgeDays = opts.maxAgeDays ?? OPEN_FACTS_MAX_AGE_DAYS;
  const max = opts.max ?? OPEN_FACTS_MAX;
  const nowMs = (opts.now ?? new Date()).getTime();
  const cutoff = nowMs - maxAgeDays * 86_400_000;

  const open = rows.filter(r => r.status === "open");
  const dated = open.map(r => ({ r, t: parseStamp(r.created_at) }));
  // Newest first; undated (NaN) sort to the end so they are the first to be held.
  dated.sort((a, b) => (Number.isFinite(b.t) ? b.t : -Infinity) - (Number.isFinite(a.t) ? a.t : -Infinity));

  const shown: T[] = [];
  const held: T[] = [];
  for (const { r, t } of dated) {
    if (Number.isFinite(t) && t >= cutoff && shown.length < max) shown.push(r);
    else held.push(r);
  }

  let oldestHeldDays: number | null = null;
  for (const r of held) {
    const t = parseStamp(r.created_at);
    if (!Number.isFinite(t)) continue;
    const d = Math.floor((nowMs - t) / 86_400_000);
    if (oldestHeldDays === null || d > oldestHeldDays) oldestHeldDays = d;
  }
  return { shown, held, oldestHeldDays };
}

/** The one-line footer both renderers print when facts are held. */
export function heldOpenFactsLine(heldCount: number, oldestHeldDays: number | null): string {
  if (heldCount <= 0) return "";
  const age = oldestHeldDays === null ? "" : `, oldest ${oldestHeldDays}d`;
  return `(${heldCount} older open question${heldCount === 1 ? "" : "s"} held back${age} -- ` +
    `not for this session; Raziel confirms or retires them on Hearth /facts.)`;
}
