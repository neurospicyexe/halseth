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

// ─────────────────────────────────────────────────────────────────────────────
// ACTIVE facts (2026-09-22). Same file, same reason: two renderers, one rule.
//
// The 09-14 gate above fixed the OPEN lane and it worked -- open is down from 107 to 2. The
// identical accumulation then happened one lane over. Measured 2026-09-22:
//
//     curated (weight < 100)   45 facts   7,634 chars   39 of 45 stated by Raziel himself
//     default (weight = 100)   74 facts  17,545 chars    6 of 74 stated by Raziel
//
// 7,634 is essentially the "7,907 chars of confirmed facts" the open gate measured on 09-14, so the
// curated set is stable and 17.5k of companion-written rows arrived in five weeks. 70% of what every
// companion reads about Raziel at every boot is now the uncurated catch-all.
//
// WHAT MAKES THIS SAFE, and it is the only thing that does: `weight` is a REAL control. 45 rows carry
// hand-assigned weights 10-74 (Raziel's own, 2026-08-12, ascending by importance); 74 sit at the
// schema default of 100. So "never hold back a fact whose weight was set on purpose" is a rule with
// data behind it, not a heuristic. Curated facts ALWAYS render, however many there are.
//
// WHAT THIS DOES NOT DO, stated plainly so nobody mistakes it for a decision: among equally-weighted
// default rows there is no principled order. Recency is a TIEBREAK, not a claim that an older fact
// matters less -- a durable fact does not go stale by age, and hiding one because it is old is how a
// companion drops something true. The defensible reading of newest-first is that the newest rows are
// the ones a companion has not yet had a chance to act on. This gate BUYS TIME; the deciding happens
// when Raziel triages on Hearth /facts. (A 2026-09-22 check found 16 of the 74 share an opening with
// another row, so some of the pile is restatement and consolidation is the real win.)
//
// Store untouched, per the mig 0116 covenant: bound the render, never the store. Everything held is
// one `ask_librarian` read away (execArchitectFactsRead returns all of it, with ids).

export interface ActiveFactLike {
  id: string;
  fact: string;
  status: string;
  created_at?: string | null;
  /** Schema default is 100; anything lower was set deliberately. Undefined counts as default. */
  weight?: number | null;
}

/** The schema default. A row at this weight has never been ranked by anyone. */
export const ACTIVE_FACTS_DEFAULT_WEIGHT = 100;
/** Chars of DEFAULT-weight facts that render. Curated facts are never counted against it. */
export const ACTIVE_FACTS_TAIL_CHAR_BUDGET = 4000;

export interface ActiveFactsGateResult<T extends ActiveFactLike> {
  /** Curated first (loader weight order), then the newest default-weight rows that fit. */
  shown: T[];
  held: T[];
  curatedCount: number;
  tailShownCount: number;
}

/**
 * Split active facts into what renders and what is held. `budget` is the char allowance for the
 * DEFAULT-weight tail only; pass 0 to hold the entire tail, or Infinity to disable the gate.
 */
export function gateActiveFacts<T extends ActiveFactLike>(
  rows: readonly T[],
  opts: { tailCharBudget?: number } = {},
): ActiveFactsGateResult<T> {
  const budget = opts.tailCharBudget ?? ACTIVE_FACTS_TAIL_CHAR_BUDGET;
  const active = rows.filter(r => r.status === "active");

  const curated: T[] = [];
  const tail: T[] = [];
  for (const r of active) {
    const w = typeof r.weight === "number" && Number.isFinite(r.weight) ? r.weight : ACTIVE_FACTS_DEFAULT_WEIGHT;
    (w < ACTIVE_FACTS_DEFAULT_WEIGHT ? curated : tail).push(r);
  }

  // RE-SORT, never inherit. The loader orders `weight ASC, created_at ASC`, which inside the
  // weight=100 group is OLDEST first -- filling a budget in that order would keep the August rows
  // and hold back everything from the last month, the exact inverse of the intent.
  const byNewest = [...tail].sort((a, b) => {
    const ta = parseStamp(a.created_at), tb = parseStamp(b.created_at);
    return (Number.isFinite(tb) ? tb : -Infinity) - (Number.isFinite(ta) ? ta : -Infinity);
  });

  const tailShown: T[] = [];
  const held: T[] = [];
  let used = 0;
  for (const r of byNewest) {
    const cost = r.fact.length;
    if (used + cost <= budget) { tailShown.push(r); used += cost; }
    else held.push(r);
  }

  return { shown: [...curated, ...tailShown], held, curatedCount: curated.length, tailShownCount: tailShown.length };
}

/** The one-line footer both renderers print when active facts are held. Names the pull verb:
 *  a count with no way to reach the content is a dead end, not a summary. */
export function heldActiveFactsLine(heldCount: number): string {
  if (heldCount <= 0) return "";
  return `(${heldCount} more recorded fact${heldCount === 1 ? "" : "s"} held back to keep this block readable -- ` +
    `nothing is lost: ask for "all architect facts" to read them, and Raziel ranks or retires them on Hearth /facts.)`;
}

/**
 * Parse the ARCHITECT_FACTS_TAIL_BUDGET var. Unset/garbage falls back to the default rather than
 * throwing or silently disabling the gate -- a typo'd knob should degrade to the safe value, the
 * same rule hermesRotationMode uses on the bot side. A huge number disables the gate on purpose.
 */
export function activeFactsTailBudget(raw: string | undefined | null): number {
  if (raw === undefined || raw === null || raw === "") return ACTIVE_FACTS_TAIL_CHAR_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : ACTIVE_FACTS_TAIL_CHAR_BUDGET;
}
