// One supply stream for the Conversation Director (spec 2026-09-03). Each source is a SELECT that
// projects a row onto the same six aliases (id, owner, title, body, created_at, heat) so the
// handler can run them in one D1 batch and map with one function. Every source is bound to a
// since-cursor (`> ?`) so the poll is incremental. READS ONLY: nothing here warms heat.
//
// care_fact projects the FACT of a gesture only (companion + rule). gesture_note and detail are
// the care layer's private payload and never enter the room.

import { effectiveHeatSql } from "../webmind/heat.js";

export type SupplyKind = "forage"|"listen"|"question"|"tension"|"project"|"club"|"council"|"inter_note"|"sibling_note"|"care_fact";
export interface SupplySource { kind: SupplyKind; table: string; sql: string; }
export interface SupplyRow { id: string; owner: string | null; title: string | null; body: string | null; created_at: string; heat: number | null; }
export interface DirectorSupplyItem { kind: SupplyKind; id: string; table: string; owner: string; title: string; body: string; created_at: string; heat: number | null; consumed_by: string[]; }

const BODY_MAX = 700;

export const SUPPLY_SOURCES: SupplySource[] = [
  { kind: "forage", table: "forage_finds", sql:
    `SELECT id, companion_id AS owner, title, summary AS body, gathered_at AS created_at, NULL AS heat
       FROM forage_finds WHERE consumed_at IS NULL AND gathered_at > ? ORDER BY gathered_at DESC LIMIT ?` },
  { kind: "listen", table: "media_experiences", sql:
    `SELECT id, shared_by AS owner, title, coalesce(artist,'') AS body, created_at, NULL AS heat
       FROM media_experiences WHERE created_at > ? AND created_at > datetime('now','-7 days') ORDER BY created_at DESC LIMIT ?` },
  { kind: "question", table: "companion_questions", sql:
    `SELECT id, companion_id AS owner, question AS title, coalesce(context,'') AS body, created_at, NULL AS heat
       FROM companion_questions WHERE status = 'open' AND delivered_at IS NULL AND created_at > ? ORDER BY created_at DESC LIMIT ?` },
  { kind: "tension", table: "companion_tensions", sql:
    `SELECT id, companion_id AS owner, tension_text AS title, coalesce(notes,'') AS body, first_noted_at AS created_at, charge AS heat
       FROM companion_tensions WHERE status IN ('simmering','crystallized')
        AND (last_surfaced_at IS NULL OR last_surfaced_at < datetime('now','-1 day')) AND first_noted_at > ? ORDER BY first_noted_at DESC LIMIT ?` },
  { kind: "project", table: "companion_projects", sql:
    `SELECT id, companion_id AS owner, title, intention AS body, created_at, NULL AS heat
       FROM companion_projects WHERE status = 'open'
        AND (last_worked_at IS NULL OR last_worked_at < datetime('now','-2 days')) AND created_at > ? ORDER BY created_at DESC LIMIT ?` },
  { kind: "club", table: "club_rounds", sql:
    `SELECT id, 'system' AS owner, 'club round: ' || status AS title, coalesce(winning_recommendation_id,'') AS body,
            coalesce(closed_at, discussing_at, activated_at, opened_at) AS created_at, NULL AS heat
       FROM club_rounds WHERE coalesce(closed_at, discussing_at, activated_at, opened_at) > ? ORDER BY 5 DESC LIMIT ?` },
  { kind: "council", table: "council_questions", sql:
    `SELECT id, asked_by AS owner, question AS title, '' AS body, created_at, NULL AS heat
       FROM council_questions WHERE status = 'open' AND created_at > ? ORDER BY created_at DESC LIMIT ?` },
  { kind: "inter_note", table: "inter_companion_notes", sql:
    `SELECT n.id, n.from_id AS owner, coalesce(n.to_id,'all') AS title, n.content AS body, n.created_at, NULL AS heat
       FROM inter_companion_notes n WHERE n.created_at > ? ORDER BY n.created_at DESC LIMIT ?` },
  { kind: "sibling_note", table: "wm_continuity_notes", sql:
    `SELECT note_id AS id, agent_id AS owner, note_type AS title, content AS body, created_at, NULL AS heat
       FROM wm_continuity_notes WHERE note_type IN ('day_distillation','discord_session') AND archived = 0
        AND content NOT LIKE '[%' AND created_at > ? ORDER BY created_at DESC LIMIT ?` },
  { kind: "care_fact", table: "care_actions", sql:
    `SELECT id, companion_id AS owner, rule AS title, NULL AS body, acted_at AS created_at, NULL AS heat
       FROM care_actions WHERE acted_at IS NOT NULL AND acted_at > ? ORDER BY acted_at DESC LIMIT ?` },
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

// effectiveHeatSql is imported so a future tranche can rank heat-bearing sources; unused today by design.
void effectiveHeatSql;
