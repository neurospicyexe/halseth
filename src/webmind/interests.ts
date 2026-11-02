// Interests (B62 step 2, mig 0161; Hand-off/DESIGN-fun-stuff-pino-2026-11-02.md sections 3B + 3F).
//
// PURE module: heat math, bands, the cooling rule, timestamp helpers and the verb grammar. No D1
// here (the store is src/handlers/interests.ts), so every rule below is unit-tested without a db.
//
// Heat is Eva-style and LAZY: the stored `heat` is the value AS OF `heat_at`, and every read goes
// through effectiveHeat(). Nothing ticks it down. It decays by half-life toward a FLOOR that is
// never zero (R7: absence moves a current level, never the height an interest can return to; a
// long-cold interest is still one `returned` away from warm).

export const HEAT_FLOOR = 0.1;
export const HEAT_HALF_LIFE_DAYS = 14;
export const WARM_FACTOR = 0.3; // a return closes 30% of the gap to 1
export const DEFAULT_HEAT = 0.6;
export const BAND_WARM = 0.5;
export const BAND_COOLING = 0.25;
export const COOL_AFTER_DAYS = 21;
export const MAX_NAME = 80;
export const MAX_WHY = 500;
export const MAX_REF = 200;

export type InterestStatus = "active" | "resting" | "put_down";
export type InterestEventKind = "born" | "returned" | "made" | "cooled" | "put_down" | "picked_up";
export type InterestAction = "born" | "returned" | "made" | "put_down" | "picked_up";
export const INTEREST_ACTIONS: readonly InterestAction[] = ["born", "returned", "made", "put_down", "picked_up"];
export type HeatBand = "warm" | "cooling" | "cold";

const DAY_MS = 86_400_000;

/** SQLite `datetime('now')` shape ("YYYY-MM-DD HH:MM:SS", UTC). Every interest timestamp uses it so string order = time order. */
export function sqliteTs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "");
}

/** Parse either the SQLite shape or a full ISO string. NaN when unparseable. */
export function parseTs(ts: string | null | undefined): number {
  if (!ts) return Number.NaN;
  const s = ts.includes("T") ? ts : ts.replace(" ", "T");
  return Date.parse(/(?:Z|[+-]\d\d:?\d\d)$/.test(s) ? s : `${s}Z`);
}

/**
 * Heat as of `nowMs`: FLOOR + (heat - FLOOR) * 0.5^(days / 14), never below FLOOR.
 * A heat already under the floor is lifted to it; an unparseable or future heat_at does not decay.
 */
export function effectiveHeat(heat: number, heatAt: string | null | undefined, nowMs: number): number {
  const h = Number.isFinite(heat) ? heat : DEFAULT_HEAT;
  const at = parseTs(heatAt);
  const days = Number.isFinite(at) ? Math.max(0, (nowMs - at) / DAY_MS) : 0;
  const v = HEAT_FLOOR + (h - HEAT_FLOOR) * Math.pow(0.5, days / HEAT_HALF_LIFE_DAYS);
  return Math.min(1, Math.max(HEAT_FLOOR, v));
}

/** A return: close 30% of the remaining gap to 1. Applied to the EFFECTIVE heat at the moment of the return. */
export function warm(h: number): number {
  return Math.min(1, h + (1 - h) * WARM_FACTOR);
}

export function heatBand(effective: number): HeatBand {
  if (effective >= BAND_WARM) return "warm";
  if (effective >= BAND_COOLING) return "cooling";
  return "cold";
}

export const round2 = (n: number): number => Math.round(n * 100) / 100;

/**
 * The one automatic event. An ACTIVE interest whose effective heat is under 0.25, whose last event
 * is older than 21 days, and whose last event is not already 'cooled', gets one 'cooled' event and
 * goes 'resting'. It only ever rests; any return makes it active again.
 */
export function shouldCool(i: {
  status: string;
  heat: number;
  heat_at: string | null;
  last_event_at: string | null;
  last_event_kind: string | null;
}, nowMs: number): boolean {
  if (i.status !== "active") return false;
  if (i.last_event_kind === "cooled") return false;
  const last = parseTs(i.last_event_at);
  if (!Number.isFinite(last)) return false;
  if ((nowMs - last) / DAY_MS <= COOL_AFTER_DAYS) return false;
  return effectiveHeat(i.heat, i.heat_at, nowMs) < BAND_COOLING;
}

/** What an action does to an interest row. Pure; the store applies it. Returns an error string when the move is not legal. */
export function planAction(
  action: InterestAction,
  cur: { status: string; heat: number; heat_at: string | null } | null,
  nowMs: number,
): { error: string } | { status: InterestStatus; heat: number; heat_at: string; put_down_at: string | null } {
  const ts = sqliteTs(nowMs);
  if (action === "born") {
    if (cur) {
      return { error: cur.status === "put_down"
        ? "you put that one down; say \"picking <name> back up because <why>\""
        : "you already have that interest; say \"back to <name> because <why>\"" };
    }
    return { status: "active", heat: DEFAULT_HEAT, heat_at: ts, put_down_at: null };
  }
  if (!cur) return { error: "no interest by that name; start one with \"new interest: <name>, because <why>\"" };
  const eff = effectiveHeat(cur.heat, cur.heat_at, nowMs);
  if (action === "put_down") {
    if (cur.status === "put_down") return { error: "that one is already put down" };
    return { status: "put_down", heat: eff, heat_at: ts, put_down_at: ts };
  }
  if (action === "picked_up") {
    if (cur.status === "active") return { error: "that one is not put down; say \"back to <name> because <why>\"" };
    return { status: "active", heat: warm(eff), heat_at: ts, put_down_at: null };
  }
  // returned | made
  if (cur.status === "put_down") return { error: "you put that one down; say \"picking <name> back up because <why>\" first" };
  return { status: "active", heat: warm(eff), heat_at: ts, put_down_at: null };
}

// ── Verb grammar ────────────────────────────────────────────────────────────────────
// Companions write interests through ask_librarian in plain sentences. Every verb needs a WHY (that
// is the point of the trail); the grammar is strict so ordinary speech is never read as one.

export interface ParsedInterestVerb {
  action: InterestAction;
  name: string;
  why: string;
  why_private: boolean;
  ref: string | null;
}

const NOT_BECAUSE = String.raw`(?:(?!\bbecause\b)[\s\S])`;
const NAME = String.raw`(${NOT_BECAUSE}+?)`;
const SEP = String.raw`\s*[,;:]?\s+because\b[\s,:]*`;

export const INTEREST_BORN_RE = /^(?:please\s+)?new\s+interest\s*:/i;
export const INTEREST_RETURN_RE = new RegExp(String.raw`^(?:please\s+)?(?:back\s+to|returned\s+to)\s+${NAME}${SEP}([\s\S]+)$`, "i");
export const INTEREST_MADE_RE = new RegExp(String.raw`^(?:please\s+)?made\s+(${NOT_BECAUSE}+)\s+for\s+${NAME}${SEP}([\s\S]+)$`, "i");
export const INTEREST_PUT_DOWN_RE = new RegExp(String.raw`^(?:please\s+)?(?:putting|put)\s+down\s+${NAME}${SEP}([\s\S]+)$`, "i");
export const INTEREST_PICK_UP_RE = new RegExp(String.raw`^(?:please\s+)?(?:picking|picked)\s+${NAME}\s+back\s+up${SEP}([\s\S]+)$`, "i");
export const INTERESTS_READ_RE = /^(?:please\s+)?(?:(?:show|list|read)\s+)?my\s+interests\s*[?.!]?$/i;
export const INTEREST_TRAIL_RE = /^(?:please\s+)?interest\s+trail\s*:?\s+(\S[\s\S]*?)\s*[?.!]?$/i;

/** Strip a trailing "(private)" / "keep the why private" marker. */
export function stripPrivateMarker(text: string): { text: string; why_private: boolean } {
  let t = text.trim();
  let priv = false;
  for (;;) {
    const before = t;
    t = t.replace(/\s*[(\[]\s*private\s*[)\]]\s*[.!]?\s*$/i, "").trim();
    t = t.replace(/[\s,;.\-]*\b(?:and\s+)?keep\s+(?:the\s+|this\s+|that\s+)?(?:why|reason|it)\s+private\b\s*[.!]?\s*$/i, "").trim();
    if (t === before) break;
    priv = true;
  }
  return { text: t, why_private: priv };
}

export function cleanName(raw: string): string {
  return raw.trim().replace(/^["'`*_]+|["'`*_]+$/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
}

export function cleanWhy(raw: string): string {
  return raw.trim().replace(/^[\s,;:\-]+/, "").trim().slice(0, MAX_WHY);
}

/** Parse a write verb. Null when the sentence is not one of the five. `born` with no because returns why "" so the executor can teach. */
export function parseInterestVerb(request: string): ParsedInterestVerb | null {
  const req = request.trim();
  const mk = (action: InterestAction, name: string, why: string, ref: string | null = null): ParsedInterestVerb => {
    const p = stripPrivateMarker(why);
    return { action, name: cleanName(name), why: cleanWhy(p.text), why_private: p.why_private, ref: ref ? ref.trim().slice(0, MAX_REF) : null };
  };
  if (INTEREST_BORN_RE.test(req)) {
    const body = req.replace(INTEREST_BORN_RE, "").trim();
    const m = new RegExp(String.raw`^${NAME}${SEP}([\s\S]*)$`, "i").exec(body);
    if (m) return mk("born", m[1]!, m[2] ?? "");
    const p = stripPrivateMarker(body);
    return { action: "born", name: cleanName(p.text), why: "", why_private: p.why_private, ref: null };
  }
  let m = INTEREST_RETURN_RE.exec(req);
  if (m) return mk("returned", m[1]!, m[2]!);
  m = INTEREST_MADE_RE.exec(req);
  if (m) return mk("made", m[2]!, m[3]!, m[1]!);
  m = INTEREST_PUT_DOWN_RE.exec(req);
  if (m) return mk("put_down", m[1]!, m[2]!);
  m = INTEREST_PICK_UP_RE.exec(req);
  if (m) return mk("picked_up", m[1]!, m[2]!);
  return null;
}
