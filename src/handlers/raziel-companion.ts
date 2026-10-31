import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { COMPANION_ID_SET } from "../companions.js";
import { LETTER_WHERE } from "./raziel-inbox.js";
import { SUBSTANTIVE_JOURNAL_CLAUSE, NOT_CLERK_JOURNAL_CLAUSE } from "../webmind/journal-lanes.js";

// A companion's page in Hearth: what changed since Raziel last looked at it, how much sits behind each
// door, and a 7-day trace of the three SOMA floats. "Last looked" lives in raziel_reads
// (item_kind = 'companion_page', item_id = companion id) and advances on every visit via POST .../looked.
//
// The cutoff C is the stored read_at, or now - 7 days on a first visit (so all-time totals never read
// as "new"). Every comparison is julianday(col) > julianday(C): rows mix ISO and SQLite timestamps.

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export type CompanionId = "drevan" | "cypher" | "gaia";
export type FloatKey = "soma_float_1" | "soma_float_2" | "soma_float_3";
const FLOAT_KEYS: readonly FloatKey[] = ["soma_float_1", "soma_float_2", "soma_float_3"];

export interface CompanionRundown {
  companion_id: CompanionId;
  last_real_thing: { text: string; at: string } | null;
  last_looked_at: string | null;
  since_basis: "last_looked" | "week";
  since: { journal: number; letters: number; book_notes: number; sol: number; autonomy: number };
  doors: { journal: number; letters_unread: number; growth: number; feelings: number; upto: number; made: number };
  trace: Record<FloatKey, (number | null)[]>;
}

export interface SomaEventRow {
  float_key: string;
  delta: number | null;
  before_value: number | null;
  after_value: number | null;
  created_at: string;
}

// ── Trace ─────────────────────────────────────────────────────────────────────────────────────────

// Same parse as latestInstant (soma.ts): ISO with a zone as-is, SQLite "YYYY-MM-DD HH:MM:SS" as UTC.
function instantMs(v: string): number {
  const s = /[zZ]|[+-]\d\d:?\d\d$/.test(v) ? v : v.replace(" ", "T") + "Z";
  return Date.parse(s);
}

function effectiveDelta(e: SomaEventRow): number {
  if (e.delta != null && Number.isFinite(e.delta)) return e.delta;
  if (e.before_value != null && e.after_value != null) {
    const d = e.after_value - e.before_value;
    return Number.isFinite(d) ? d : 0;
  }
  return 0;
}

const clampRound = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;

// Seven points, oldest -> newest. Point 6 is the current value; point d (0..5) is the current value
// with every event at or after (today 00:00Z - (5 - d) days) undone. Anchoring on the current float and
// walking deltas back survives events that carry only a delta (backfilled ferment rows).
export function buildTrace(
  current: Record<FloatKey, number | null>,
  events: SomaEventRow[],
  nowMs: number,
): Record<FloatKey, (number | null)[]> {
  const dayStart = Math.floor(nowMs / 86_400_000) * 86_400_000;
  const out = {} as Record<FloatKey, (number | null)[]>;
  for (const key of FLOAT_KEYS) {
    const cur = current[key];
    if (cur == null || !Number.isFinite(cur)) {
      out[key] = Array(7).fill(null);
      continue;
    }
    const mine = events
      .filter((e) => e.float_key === key)
      .map((e) => ({ at: instantMs(e.created_at), d: effectiveDelta(e) }))
      .filter((e) => Number.isFinite(e.at));
    const points: number[] = [];
    for (let d = 0; d <= 5; d++) {
      const boundary = dayStart - (5 - d) * 86_400_000;
      const undone = mine.reduce((sum, e) => (e.at >= boundary ? sum + e.d : sum), 0);
      points.push(clampRound(cur - undone));
    }
    points.push(clampRound(cur));
    out[key] = points;
  }
  return out;
}

// ── Queries ───────────────────────────────────────────────────────────────────────────────────────

const AFTER_C = (col: string) => `julianday(${col}) > julianday(?2)`;

// Counts bind ?1 = companion id, ?2 = cutoff C (letters_unread binds ?1 only).
const COUNTS = {
  // Substantive, non-clerk lane only (as orient's recent_journal): every bot reply lands here as
  // discord_speech, and a count of chat Raziel already saw in Discord would bury the real entries.
  // The Journal page asks GET /companion-journal with substantive=1, so pill and page agree.
  journal:
    "SELECT COUNT(*) AS n FROM companion_journal j WHERE j.agent = ?1 AND j.archived = 0 " +
    `AND COALESCE(j.review_state,'') <> 'dropped' AND NOT (${LETTER_WHERE}) ` +
    `AND ${SUBSTANTIVE_JOURNAL_CLAUSE} AND ${NOT_CLERK_JOURNAL_CLAUSE} AND ${AFTER_C("j.created_at")}`,
  letters:
    `SELECT COUNT(*) AS n FROM companion_journal j WHERE j.agent = ?1 AND ${LETTER_WHERE} AND ${AFTER_C("j.created_at")}`,
  // All time, not since C: the same unread rule as /raziel/inbox. Binds ?1 only.
  letters_unread:
    `SELECT COUNT(*) AS n FROM companion_journal j WHERE j.agent = ?1 AND ${LETTER_WHERE} ` +
    "AND NOT EXISTS (SELECT 1 FROM raziel_reads r WHERE r.item_kind = 'letter' AND r.item_id = j.id)",
  book_notes:
    `SELECT COUNT(*) AS n FROM book_annotations WHERE author = ?1 AND ${AFTER_C("created_at")}`,
  sol:
    "SELECT COUNT(*) AS n FROM creature_interactions ci JOIN creatures c ON ci.creature_id = c.id " +
    `WHERE ci.actor = ?1 AND lower(c.name) = 'sol' AND ${AFTER_C("ci.created_at")}`,
  autonomy:
    `SELECT COUNT(*) AS n FROM autonomy_runs WHERE companion_id = ?1 AND ${AFTER_C("created_at")}`,
  growth:
    "SELECT " +
    `(SELECT COUNT(*) FROM growth_journal WHERE companion_id = ?1 AND ${AFTER_C("created_at")}) + ` +
    `(SELECT COUNT(*) FROM growth_patterns WHERE companion_id = ?1 AND ${AFTER_C("created_at")}) + ` +
    `(SELECT COUNT(*) FROM growth_markers WHERE companion_id = ?1 AND ${AFTER_C("created_at")}) AS n`,
  // relational_deltas has two row shapes (halseth CLAUDE.md covenant): legacy companion_id, and
  // MCP-logged companion_id = '' with agent + delta_text.
  feelings:
    "SELECT " +
    `(SELECT COUNT(*) FROM feelings WHERE companion_id = ?1 AND ${AFTER_C("created_at")}) + ` +
    `(SELECT COUNT(*) FROM companion_relational_state WHERE companion_id = ?1 AND ${AFTER_C("noted_at")}) + ` +
    "(SELECT COUNT(*) FROM relational_deltas WHERE (companion_id = ?1 OR (agent = ?1 AND delta_text IS NOT NULL)) " +
    `AND ${AFTER_C("created_at")}) AS n`,
  upto:
    "SELECT " +
    `(SELECT COUNT(*) FROM autonomy_runs WHERE companion_id = ?1 AND ${AFTER_C("created_at")}) + ` +
    `(SELECT COUNT(*) FROM companion_projects WHERE companion_id = ?1 AND ${AFTER_C("COALESCE(last_worked_at, created_at)")}) AS n`,
  made:
    "SELECT COUNT(*) AS n FROM companion_tool_calls WHERE companion_id = ?1 AND tool = 'generate_image' " +
    `AND status = 'success' AND result_ref IS NOT NULL AND ${AFTER_C("created_at")}`,
} as const;

type CountKey = keyof typeof COUNTS;
const COUNT_KEYS = Object.keys(COUNTS) as CountKey[];

const LAST_REAL_THING_SQL =
  "SELECT hp.last_real_thing AS text, hp.created_at AS at FROM handover_packets hp " +
  "JOIN sessions s ON hp.session_id = s.id " +
  "WHERE s.companion_id = ? AND hp.close_kind IS NULL AND hp.last_real_thing IS NOT NULL " +
  "AND trim(hp.last_real_thing) <> '' ORDER BY julianday(hp.created_at) DESC LIMIT 1";

const STATE_SQL =
  "SELECT soma_float_1, soma_float_2, soma_float_3 FROM companion_state WHERE companion_id = ?";

// 8 days back, a superset of the 7-point window (point 0 reaches back to today 00:00Z - 5 days).
const EVENTS_SQL =
  "SELECT float_key, delta, before_value, after_value, created_at FROM companion_soma_events " +
  "WHERE companion_id = ? AND julianday(created_at) > julianday('now','-8 days')";

const CUTOFF_SQL =
  "SELECT COALESCE((SELECT read_at FROM raziel_reads WHERE item_kind = 'companion_page' AND item_id = ?1), " +
  "datetime('now','-7 days')) AS c, " +
  "(SELECT read_at FROM raziel_reads WHERE item_kind = 'companion_page' AND item_id = ?1) AS looked";

// ── Handlers ──────────────────────────────────────────────────────────────────────────────────────

export async function getRazielCompanion(
  request: Request,
  env: Env,
  params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const id = params.id ?? "";
  if (!COMPANION_ID_SET.has(id)) return jsonRes({ error: "unknown companion" }, 400);

  const cut = await env.DB.prepare(CUTOFF_SQL).bind(id).first<{ c: string; looked: string | null }>();
  const c = cut?.c ?? "";
  const looked = cut?.looked ?? null;

  const results = await env.DB.batch([
    ...COUNT_KEYS.map((k) => (k === "letters_unread" ? env.DB.prepare(COUNTS[k]).bind(id) : env.DB.prepare(COUNTS[k]).bind(id, c))),
    env.DB.prepare(LAST_REAL_THING_SQL).bind(id),
    env.DB.prepare(STATE_SQL).bind(id),
    env.DB.prepare(EVENTS_SQL).bind(id),
  ]);

  const count = {} as Record<CountKey, number>;
  COUNT_KEYS.forEach((k, i) => {
    const row = (results[i]?.results?.[0] ?? null) as { n?: number } | null;
    count[k] = Number(row?.n ?? 0);
  });
  const lrt = (results[COUNT_KEYS.length]?.results?.[0] ?? null) as { text: string; at: string } | null;
  const state = (results[COUNT_KEYS.length + 1]?.results?.[0] ?? null) as Record<FloatKey, number | null> | null;
  const events = (results[COUNT_KEYS.length + 2]?.results ?? []) as SomaEventRow[];

  const rundown: CompanionRundown = {
    companion_id: id as CompanionId,
    last_real_thing: lrt ? { text: lrt.text, at: lrt.at } : null,
    last_looked_at: looked,
    since_basis: looked === null ? "week" : "last_looked",
    since: {
      journal: count.journal,
      letters: count.letters,
      book_notes: count.book_notes,
      sol: count.sol,
      autonomy: count.autonomy,
    },
    doors: {
      journal: count.journal,
      letters_unread: count.letters_unread,
      growth: count.growth,
      feelings: count.feelings,
      upto: count.upto,
      made: count.made,
    },
    trace: buildTrace(
      {
        soma_float_1: state?.soma_float_1 ?? null,
        soma_float_2: state?.soma_float_2 ?? null,
        soma_float_3: state?.soma_float_3 ?? null,
      },
      events,
      Date.now(),
    ),
  };
  return jsonRes(rundown);
}

export async function postRazielCompanionLooked(
  request: Request,
  env: Env,
  params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const id = params.id ?? "";
  if (!COMPANION_ID_SET.has(id)) return jsonRes({ error: "unknown companion" }, 400);
  const row = await env.DB.prepare(
    "INSERT INTO raziel_reads (item_kind, item_id, read_at) VALUES ('companion_page', ?, datetime('now')) " +
    "ON CONFLICT(item_kind, item_id) DO UPDATE SET read_at = excluded.read_at RETURNING read_at",
  ).bind(id).first<{ read_at: string }>();
  return jsonRes({ ok: true, looked_at: row?.read_at ?? null });
}
