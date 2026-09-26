// One supply stream for the Conversation Director (spec 2026-09-03). Each source is a SELECT that
// projects a row onto the same six aliases (id, owner, title, body, created_at, heat) so the
// handler can run them in one D1 batch and map with one function. Every source is bound to a
// since-cursor so the poll is incremental. READS ONLY: nothing here warms heat.
//
// care_fact projects the FACT of a gesture only (companion + rule). gesture_note and detail are
// the care layer's private payload and never enter the room.
//
// TIMESTAMP NORMALIZATION (2026-09-03 fix). Seven sources store `created_at` via SQLite
// `datetime('now')` ("2026-09-03 09:00:00"), three store JS ISO
// ("2026-09-03T05:00:00.000Z"). A scalar `> ?` cursor across mixed formats silently drops rows
// (string comparison of the two formats does not track real chronological order -- see the unit
// test in director-supply-query.test.ts that demonstrates
// "2026-09-03 09:00:00" > "2026-09-03T05:00:00.000Z" is false in JS, i.e. the SQLite-format row
// reads as "less than" the ISO row even when it happened later). Every source therefore projects
// AND filters through the same `strftime('%Y-%m-%dT%H:%M:%SZ', <col>)` expression, and the cursor
// becomes a compound "<iso>|<id>" pair so two rows landing in the same second still page
// correctly (tiebreak on id). Each source binds FOUR params: (sinceIso, sinceIso, sinceId,
// perSource).

export type SupplyKind = "forage"|"listen"|"question"|"tension"|"project"|"club"|"council"|"inter_note"|"sibling_note"|"care_fact";
export interface SupplySource { kind: SupplyKind; table: string; sql: string; }
export interface SupplyRow { id: string; owner: string | null; title: string | null; body: string | null; created_at: string; heat: number | null; }
export interface DirectorSupplyItem { kind: SupplyKind; id: string; table: string; owner: string; title: string; body: string; created_at: string; heat: number | null; consumed_by: string[]; }

const BODY_MAX = 700;

/** The single normalization expression every source's projection and predicate must share. */
const NORM = (col: string) => `strftime('%Y-%m-%dT%H:%M:%SZ', ${col})`;

/** Compound cursor predicate: `(norm(col) > ? OR (norm(col) = ? AND idCol > ?))`. Binds 3 params. */
const CURSOR_PREDICATE = (col: string, idCol: string) =>
  `(${NORM(col)} > ? OR (${NORM(col)} = ? AND ${idCol} > ?))`;

export const SUPPLY_SOURCES: SupplySource[] = [
  { kind: "forage", table: "forage_finds", sql:
    `SELECT id, companion_id AS owner, title, summary AS body, ${NORM("gathered_at")} AS created_at, NULL AS heat
       FROM forage_finds WHERE consumed_at IS NULL AND ${CURSOR_PREDICATE("gathered_at", "id")}
       ORDER BY ${NORM("gathered_at")} ASC, id ASC LIMIT ?` },
  { kind: "listen", table: "media_experiences", sql:
    `SELECT id, shared_by AS owner, title, coalesce(artist,'') AS body, ${NORM("created_at")} AS created_at, NULL AS heat
       FROM media_experiences WHERE created_at > datetime('now','-7 days') AND ${CURSOR_PREDICATE("created_at", "id")}
       ORDER BY ${NORM("created_at")} ASC, id ASC LIMIT ?` },
  { kind: "question", table: "companion_questions", sql:
    `SELECT id, companion_id AS owner, question AS title, coalesce(context,'') AS body, ${NORM("created_at")} AS created_at, NULL AS heat
       FROM companion_questions WHERE status = 'open' AND delivered_at IS NULL AND ${CURSOR_PREDICATE("created_at", "id")}
       ORDER BY ${NORM("created_at")} ASC, id ASC LIMIT ?` },
  { kind: "tension", table: "companion_tensions", sql:
    `SELECT id, companion_id AS owner, tension_text AS title, coalesce(notes,'') AS body, ${NORM("first_noted_at")} AS created_at, charge AS heat
       FROM companion_tensions WHERE status IN ('simmering','crystallized')
        AND (last_surfaced_at IS NULL OR ${NORM("last_surfaced_at")} < ${NORM("datetime('now','-1 day')")})
        AND ${CURSOR_PREDICATE("first_noted_at", "id")}
       ORDER BY ${NORM("first_noted_at")} ASC, id ASC LIMIT ?` },
  { kind: "project", table: "companion_projects", sql:
    `SELECT id, companion_id AS owner, title, intention AS body, ${NORM("created_at")} AS created_at, NULL AS heat
       FROM companion_projects WHERE status = 'open'
        AND (last_worked_at IS NULL OR ${NORM("last_worked_at")} < ${NORM("datetime('now','-2 days')")})
        AND ${CURSOR_PREDICATE("created_at", "id")}
       ORDER BY ${NORM("created_at")} ASC, id ASC LIMIT ?` },
  { kind: "club", table: "club_rounds", sql:
    `SELECT id, 'system' AS owner, 'club round: ' || status AS title, coalesce(winning_recommendation_id,'') AS body,
            ${NORM("coalesce(closed_at, discussing_at, activated_at, opened_at)")} AS created_at, NULL AS heat
       FROM club_rounds WHERE ${CURSOR_PREDICATE("coalesce(closed_at, discussing_at, activated_at, opened_at)", "id")}
       ORDER BY ${NORM("coalesce(closed_at, discussing_at, activated_at, opened_at)")} ASC, id ASC LIMIT ?` },
  { kind: "council", table: "council_questions", sql:
    `SELECT id, asked_by AS owner, question AS title, '' AS body, ${NORM("created_at")} AS created_at, NULL AS heat
       FROM council_questions WHERE status = 'open' AND ${CURSOR_PREDICATE("created_at", "id")}
       ORDER BY ${NORM("created_at")} ASC, id ASC LIMIT ?` },
  { kind: "inter_note", table: "inter_companion_notes", sql:
    `SELECT n.id, n.from_id AS owner, coalesce(n.to_id,'all') AS title, n.content AS body, ${NORM("n.created_at")} AS created_at, NULL AS heat
       FROM inter_companion_notes n
      WHERE ${CURSOR_PREDICATE("n.created_at", "n.id")}
      ORDER BY ${NORM("n.created_at")} ASC, n.id ASC LIMIT ?` },
  { kind: "sibling_note", table: "wm_continuity_notes", sql:
    `SELECT note_id AS id, agent_id AS owner, note_type AS title, content AS body, ${NORM("created_at")} AS created_at, NULL AS heat
       FROM wm_continuity_notes WHERE note_type IN ('day_distillation','discord_session') AND archived = 0
        AND review_state = 'kept'
        AND content NOT LIKE '[%' AND ${CURSOR_PREDICATE("created_at", "note_id")}
       ORDER BY ${NORM("created_at")} ASC, note_id ASC LIMIT ?` },
  { kind: "care_fact", table: "care_actions", sql:
    `SELECT id, companion_id AS owner, rule AS title, NULL AS body, ${NORM("acted_at")} AS created_at, NULL AS heat
       FROM care_actions WHERE acted_at IS NOT NULL AND ${CURSOR_PREDICATE("acted_at", "id")}
       ORDER BY ${NORM("acted_at")} ASC, id ASC LIMIT ?` },
];

export function mapRow(src: SupplySource, r: SupplyRow): DirectorSupplyItem {
  const owner = r.owner && r.owner.length > 0 ? r.owner : "system";
  const body = src.kind === "care_fact" ? `${owner} made a ${r.title ?? "care"} gesture` : (r.body ?? "");
  return {
    kind: src.kind, id: r.id, table: src.table, owner,
    title: (r.title ?? "").slice(0, 200), body: body.slice(0, BODY_MAX),
    created_at: r.created_at, heat: typeof r.heat === "number" && Number.isFinite(r.heat) ? r.heat : null,
    consumed_by: [],
  };
}

/** Per-reader receipt lookups for the two kinds that have them. Returns id -> readers. */
export const RECEIPT_SQL: Partial<Record<SupplyKind, (n: number) => string>> = {
  inter_note: (n) => `SELECT note_id AS id, companion_id AS reader FROM inter_companion_note_reads WHERE note_id IN (${Array(n).fill("?").join(",")})`,
  sibling_note: (n) => `SELECT note_id AS id, reader_id AS reader FROM commons_note_reads WHERE note_id IN (${Array(n).fill("?").join(",")})`,
};
