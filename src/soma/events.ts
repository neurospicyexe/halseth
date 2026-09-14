// src/soma/events.ts
//
// The append-only float history (mig 0130 `companion_soma_events`), Phase 2 tranche 1 of graph
// memory (docs/PLAN-graph-memory-phase-2-soma-provenance-2026-09-12.md).
//
// Every writer that moves soma_float_1/2/3 appends here: the two authored paths (session close,
// state update), the two machine paths (ferment tick, stimulus) and emergent drift shifts. This
// module is the ONLY place that knows the table's column order, so a writer cannot drift from the
// schema by hand-rolling its own INSERT.
//
// Two shapes, deliberately separate:
//   * somaEventStatements() returns prepared statements for a BATCH -- so a writer that already
//     writes its floats in a batch appends its events in the SAME batch (atomic: no float move
//     without its history row, no history row for a move that did not land).
//   * diffFloats() is pure: before/after maps in, one event per float that ACTUALLY moved out.
//     |delta| <= 1e-9 is not a move. A write that lands the same number is not history.
//
// loadSomaProvenance() is the read side: newest 3 events per float plus the human label for what
// caused each one. Pure D1, best-effort -- it feeds orient (agent B) and Hearth (agent C), and
// neither may break because a label join failed, so any throw returns [].

import type { Env } from "../types.js";
import { FLOAT_LABELS } from "../webmind/fermentation.js";
import type { CompanionId } from "../webmind/fermentation.js";

export type SomaFloatKey = "soma_float_1" | "soma_float_2" | "soma_float_3";
export type SomaEventKind = "authored_close" | "authored_update" | "tick" | "stimulus" | "drift_shift";

export interface SomaEventInput {
  companion_id: string;
  float_key: SomaFloatKey;
  before_value: number | null;
  after_value: number | null;
  kind: SomaEventKind;
  writer: string;
  cause_table?: string | null;
  cause_id?: string | null;
  session_id?: string | null;
  version_after?: number | null;
  detail?: string | null;
  created_at?: string;
  /**
   * Writer-asserted delta, used ONLY when before/after are not both known (the backfill's ferment
   * rows: companion_ferment_events records the move but not the absolutes). When both absolutes
   * are present, `after - before` always wins -- the numbers in the row must agree with each other.
   */
  delta?: number | null;
  /**
   * Optional explicit row id. Omit it and one is generated. The machine writers and the backfill
   * BOTH pass a deterministic id derived from their detail row (`fe_<ferment_event_id>_<f1|f2|f3>`,
   * `ss_<soma_shift_id>`) so re-running the backfill after instrumentation shipped cannot double
   * a move that the live writer already recorded -- INSERT OR IGNORE collapses them.
   */
  id?: string;
}

export const SOMA_FLOAT_KEYS: readonly SomaFloatKey[] = ["soma_float_1", "soma_float_2", "soma_float_3"];
export const SOMA_EVENT_KINDS: readonly SomaEventKind[] = [
  "authored_close",
  "authored_update",
  "tick",
  "stimulus",
  "drift_shift",
];

/** Column order for companion_soma_events. One definition; somaEventStatements binds in this order. */
const EVENT_COLUMNS = [
  "id",
  "companion_id",
  "float_key",
  "before_value",
  "after_value",
  "delta",
  "kind",
  "writer",
  "cause_table",
  "cause_id",
  "session_id",
  "version_after",
  "detail",
  "created_at",
] as const;

const INSERT_EVENT_SQL =
  `INSERT OR IGNORE INTO companion_soma_events (${EVENT_COLUMNS.join(", ")}) ` +
  `VALUES (${EVENT_COLUMNS.map(() => "?").join(", ")})`;

/** `soma_float_2` -> `f2`. The suffix the deterministic ids use, shared by writers and backfill. */
export function floatShort(key: SomaFloatKey): "f1" | "f2" | "f3" {
  return key === "soma_float_1" ? "f1" : key === "soma_float_2" ? "f2" : "f3";
}

/** `f2` -> `soma_float_2`. Inverse of floatShort, for parsing ferment float_deltas JSON. */
export function floatKeyFromShort(short: string): SomaFloatKey | null {
  if (short === "f1") return "soma_float_1";
  if (short === "f2") return "soma_float_2";
  if (short === "f3") return "soma_float_3";
  return null;
}

/**
 * Authored-event id: a dashless UUID minted client-side. The machine writers keep their
 * deterministic `fe_*`/`ss_*` ids; the authored paths have no detail row to derive one from, so
 * they take a random one -- but they take it BEFORE the batch (assignSomaEventIds), because the
 * live graph edges (src/graph/live.ts::edgesForSomaEvent) ride the same batch and must name the
 * event row they hang off. An id minted inside SQL would be unknowable until after the write.
 */
export function newSomaEventId(): string {
  return crypto.randomUUID().replace(/-/g, "");
}

/** A SomaEventInput whose id and created_at are settled -- the shape a live edge can reference. */
export type SomaEventStamped = SomaEventInput & { id: string; created_at: string };

/**
 * Settle id + created_at on every event before it reaches somaEventStatements. Idempotent: an
 * event that already carries an id (machine writers, backfill) or a created_at keeps it. Every
 * event in one call shares one `now` when none was given, so the edges derived from them agree
 * with rebuild's per-event created_at byte for byte.
 */
export function assignSomaEventIds(events: SomaEventInput[], now = new Date().toISOString()): SomaEventStamped[] {
  return events.map((e) => ({ ...e, id: e.id ?? newSomaEventId(), created_at: e.created_at ?? now }));
}

/**
 * The minimal event shape src/graph/rebuild.ts::buildSomaEventEdges consumes (SomaEventGraphRow),
 * projected from a stamped input so a live writer hands the edge helper exactly what the nightly
 * rebuild would read back from the row it is about to insert.
 */
export function toSomaEventGraphRow(e: SomaEventStamped): {
  id: string;
  companion_id: string;
  float_key: string;
  kind: string;
  writer: string;
  cause_table: string | null;
  cause_id: string | null;
  session_id: string | null;
  created_at: string;
} {
  return {
    id: e.id,
    companion_id: e.companion_id,
    float_key: e.float_key,
    kind: e.kind,
    writer: e.writer,
    cause_table: e.cause_table ?? null,
    cause_id: e.cause_id ?? null,
    session_id: e.session_id ?? null,
    created_at: e.created_at,
  };
}

function finite(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** after - before when both are known, else null (the caller may override with its own delta). */
function computeDelta(before: number | null, after: number | null): number | null {
  if (before === null || after === null) return null;
  return Number((after - before).toFixed(6));
}

/**
 * Prepared INSERTs for a batch append. INSERT OR IGNORE, so a deterministic id already present
 * (backfill vs live writer) is a no-op rather than a duplicate row.
 */
export function somaEventStatements(db: D1Database, events: SomaEventInput[]): D1PreparedStatement[] {
  const now = new Date().toISOString();
  return events.map((e) => {
    const before = finite(e.before_value);
    const after = finite(e.after_value);
    return db.prepare(INSERT_EVENT_SQL).bind(
      e.id ?? newSomaEventId(),
      e.companion_id,
      e.float_key,
      before,
      after,
      computeDelta(before, after) ?? finite(e.delta ?? null),
      e.kind,
      e.writer,
      e.cause_table ?? null,
      e.cause_id ?? null,
      e.session_id ?? null,
      e.version_after ?? null,
      e.detail ?? null,
      e.created_at ?? now,
    );
  });
}

type FloatMap = Partial<Record<SomaFloatKey, number | null>>;

/**
 * One event per float that ACTUALLY changed.
 *
 * A float is skipped when: it is absent from `after`; its `after` is null or non-finite (a clear,
 * or a value that never should have reached SQL -- sessionClose binds `somaFields[col] ?? null`
 * with no Number() coercion, so a string CAN arrive here); or both values are known and the move
 * is under 1e-9. A null/unreadable `before` still emits -- the move happened, we just cannot say
 * from where, which is exactly what before_value NULL means in the schema.
 */
export function diffFloats(
  before: FloatMap,
  after: FloatMap,
  base: Omit<SomaEventInput, "float_key" | "before_value" | "after_value">,
): SomaEventInput[] {
  const out: SomaEventInput[] = [];
  for (const key of SOMA_FLOAT_KEYS) {
    if (!(key in after)) continue;
    const a = finite(after[key] as number | null | undefined);
    if (a === null) continue;
    const b = finite(before[key] as number | null | undefined);
    if (b !== null && Math.abs(a - b) <= 1e-9) continue;
    out.push({ ...base, float_key: key, before_value: b, after_value: a });
  }
  return out;
}

/** Bind: [companion_id]. The pre-read every authored writer takes before it writes floats. */
export function readFloatsSql(): string {
  return "SELECT soma_float_1, soma_float_2, soma_float_3, version FROM companion_state WHERE companion_id = ?";
}

/**
 * Bind: [companion_id]. The SECOND half of the authored pre-read (2026-09-14): the newest event id
 * per float for this companion, so the live `follows` edge can name its predecessor without a
 * per-float lookup. One windowed query, at most three rows. Same ORDER BY as loadSomaProvenance
 * (see SOMA_EVENT_ORDER_DESC): `created_at` in this table holds TWO shapes. The 13,952 rows the
 * 0130 backfill copied verbatim from their source rows are SQLite datetime('now') form
 * ("YYYY-MM-DD HH:MM:SS"); live rows are JS ISO ("YYYY-MM-DDTHH:MM:SS.sssZ"). 'T' > ' ', so a raw
 * string sort puts every ISO row above every space-form row regardless of when it happened.
 * replace(created_at, ' ', 'T') makes the two shapes share a prefix, so byte order agrees with
 * rebuild.ts's parsed-time chain (byTimeThenId + tsMs): a space-form stamp is a strict prefix of
 * an ISO stamp at the same second and a prefix sorts OLDER, which is what the ms-carrying ISO row
 * being newer requires. The rows themselves are never rewritten -- 0130 is append-only.
 */
export const SOMA_EVENT_ORDER_DESC = "replace(created_at, ' ', 'T') DESC, id DESC";

export function readLatestEventIdsSql(): string {
  return (
    `SELECT float_key, id FROM (` +
    `SELECT float_key, id, ROW_NUMBER() OVER (PARTITION BY float_key ORDER BY ${SOMA_EVENT_ORDER_DESC}) AS rn ` +
    `FROM companion_soma_events WHERE companion_id = ?` +
    `) WHERE rn = 1`
  );
}

/** `{float_key, id}` rows from readLatestEventIdsSql -> Map<float_key, id>. Unknown keys dropped. */
export function latestEventIdsByFloat(rows: readonly { float_key: string; id: string }[] | null | undefined): Map<SomaFloatKey, string> {
  const out = new Map<SomaFloatKey, string>();
  for (const r of rows ?? []) {
    if ((SOMA_FLOAT_KEYS as readonly string[]).includes(r.float_key) && r.id) out.set(r.float_key as SomaFloatKey, String(r.id));
  }
  return out;
}

// ── Read side: provenance for one companion ───────────────────────────────────────

export interface SomaProvenanceEntry {
  float_key: SomaFloatKey;
  label: string;
  kind: SomaEventKind;
  writer: string;
  before_value: number | null;
  after_value: number | null;
  delta: number | null;
  cause_table: string | null;
  cause_id: string | null;
  /** handover: spine head (<=80 chars); ferment: stimulus or 'tick'; shift: reason head;
   *  sessions (2026-09-14, a bare state_update attributed to its open session):
   *  `<session_type> session` -- kept short (review 09-14): the renderer already prints the day and
   *  quotes the companion's words after it, and a 110-char line cannot afford an id + date that
   *  repeat what `session_id` and `created_at` carry structurally. Falls back to `detail` head. */
  cause_label: string | null;
  session_id: string | null;
  /** companion_journal rows sharing this event's session_id (0 when the event has no session). */
  alongside_notes: number;
  /** 2026-09-14: the writer's own words for the move (<=120 chars) -- for authored_update, the
   *  request text ("update my state: acuity 0.78"); for the tick, "silence". Carried separately
   *  from cause_label now that a state_update's cause is its session, so the block can print both
   *  where it happened and what was said. */
  detail: string | null;
  created_at: string;
}

interface EventRow {
  id: string;
  float_key: string;
  before_value: number | null;
  after_value: number | null;
  delta: number | null;
  kind: string;
  writer: string;
  cause_table: string | null;
  cause_id: string | null;
  session_id: string | null;
  detail: string | null;
  created_at: string;
}

/** First line, collapsed whitespace, hard-capped. A spine's opening clause, not its paragraph. */
function head(text: string | null | undefined, max: number): string | null {
  if (!text) return null;
  const line = String(text).split(/[\r\n]/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  if (!line) return null;
  return line.length > max ? line.slice(0, max) : line;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(", ");
}

/**
 * Newest 3 events per float for one companion (<= 9 rows), with the human label for each cause.
 *
 * Query budget matters: this rides the orient path (agent B's felt.soma_provenance) where the
 * loader's pure-D1 0.70s profile is a standing rule. Six queries max -- one windowed read, up to
 * four batched label joins keyed by cause_table (handover, ferment, shift, and since 2026-09-14
 * the session a bare state_update was made in), one grouped journal count. No per-row lookups.
 *
 * Ordering: SOMA_EVENT_ORDER_DESC, not a raw `created_at DESC` -- the table holds both the
 * space-form backfilled stamps and ISO live stamps; see readLatestEventIdsSql for why replace()
 * is what makes SQL order agree with rebuild.ts's parsed-time order.
 *
 * Best-effort by contract: any throw is warned and returns [], because neither orient nor Hearth
 * may fail on a provenance line.
 */
export async function loadSomaProvenance(env: Env, companionId: string): Promise<SomaProvenanceEntry[]> {
  try {
    const rows = (
      await env.DB.prepare(
        `SELECT id, float_key, before_value, after_value, delta, kind, writer,
                cause_table, cause_id, session_id, detail, created_at
           FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY float_key ORDER BY ${SOMA_EVENT_ORDER_DESC}) AS rn
               FROM companion_soma_events
              WHERE companion_id = ?
           )
          WHERE rn <= 3
          ORDER BY ${SOMA_EVENT_ORDER_DESC}`,
      )
        .bind(companionId)
        .all<EventRow>()
    ).results ?? [];
    if (!rows.length) return [];

    // Label joins, one query per distinct cause_table present (at most four: handover_packets,
    // companion_ferment_events, companion_soma_shifts, sessions).
    const byTable = new Map<string, Set<string>>();
    for (const r of rows) {
      if (!r.cause_table || !r.cause_id) continue;
      const set = byTable.get(r.cause_table) ?? new Set<string>();
      set.add(r.cause_id);
      byTable.set(r.cause_table, set);
    }
    const labels = new Map<string, string>(); // `${table}/${id}` -> label
    const LABEL_QUERIES: Record<string, { sql: (n: number) => string; pick: (row: Record<string, unknown>) => string | null }> = {
      handover_packets: {
        sql: (n) => `SELECT id, spine FROM handover_packets WHERE id IN (${placeholders(n)})`,
        pick: (row) => head(row.spine as string | null, 80),
      },
      companion_ferment_events: {
        sql: (n) => `SELECT id, stimulus FROM companion_ferment_events WHERE id IN (${placeholders(n)})`,
        pick: (row) => head(row.stimulus as string | null, 80) ?? "tick",
      },
      companion_soma_shifts: {
        sql: (n) => `SELECT id, reason FROM companion_soma_shifts WHERE id IN (${placeholders(n)})`,
        pick: (row) => head(row.reason as string | null, 80),
      },
      // 2026-09-14: a bare state_update names its open session as the cause (cause_table 'sessions').
      // A session has no spine to quote, so the label says WHERE: the session type only. The id and
      // the day ride on the row itself (`session_id`, `created_at`); repeating them here ate ~40 of the
      // renderer's 110 chars before the companion's own words began.
      sessions: {
        sql: (n) => `SELECT id, session_type FROM sessions WHERE id IN (${placeholders(n)})`,
        pick: (row) => `${String(row.session_type ?? "work")} session`,
      },
    };
    for (const [table, idSet] of byTable) {
      const q = LABEL_QUERIES[table];
      if (!q) continue;
      const ids = [...idSet];
      const found = (await env.DB.prepare(q.sql(ids.length)).bind(...ids).all<Record<string, unknown>>()).results ?? [];
      for (const row of found) {
        const label = q.pick(row);
        if (label) labels.set(`${table}/${String(row.id)}`, label);
      }
    }

    // alongside_notes: one grouped count over every session these events name.
    const sessionIds = [...new Set(rows.map((r) => r.session_id).filter((s): s is string => !!s))];
    const noteCounts = new Map<string, number>();
    if (sessionIds.length) {
      const counted = (
        await env.DB.prepare(
          `SELECT session_id, COUNT(*) AS n FROM companion_journal
            WHERE session_id IN (${placeholders(sessionIds.length)}) GROUP BY session_id`,
        )
          .bind(...sessionIds)
          .all<{ session_id: string; n: number }>()
      ).results ?? [];
      for (const c of counted) noteCounts.set(c.session_id, Number(c.n) || 0);
    }

    const floatLabels = FLOAT_LABELS[companionId as CompanionId];
    return rows.map((r) => {
      const float_key = (SOMA_FLOAT_KEYS.includes(r.float_key as SomaFloatKey)
        ? r.float_key
        : "soma_float_1") as SomaFloatKey;
      const idx = SOMA_FLOAT_KEYS.indexOf(float_key);
      const causeKey = r.cause_table && r.cause_id ? `${r.cause_table}/${r.cause_id}` : null;
      return {
        float_key,
        label: floatLabels?.[idx] ?? float_key,
        kind: r.kind as SomaEventKind,
        writer: r.writer,
        before_value: finite(r.before_value),
        after_value: finite(r.after_value),
        delta: finite(r.delta),
        cause_table: r.cause_table ?? null,
        cause_id: r.cause_id ?? null,
        cause_label: (causeKey ? labels.get(causeKey) ?? null : null) ?? head(r.detail, 80),
        session_id: r.session_id ?? null,
        alongside_notes: r.session_id ? noteCounts.get(r.session_id) ?? 0 : 0,
        detail: head(r.detail, 120),
        created_at: r.created_at,
      };
    });
  } catch (err) {
    console.warn("[soma/events] loadSomaProvenance failed (non-fatal):", String(err));
    return [];
  }
}
