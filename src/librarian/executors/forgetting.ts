// Librarian executors for chosen forgetting (consequence layer C7, mig 0123).
//
// Everything else in the memory decays by POLICY (heat, salience prune, TTLs); nothing perishes
// by the companion's own CHOICE. memory_release is that choice: archive a journal row, a
// continuity note, or a conclusion, WITH a stated reason -- perpetual perishing as agency.
//
// Rails:
// - Archive, never delete: the row keeps existing with archived = 1; reads filter it out.
// - Reversible for 30 days (memory_release_undo), then the release stands.
// - Reason is REQUIRED: an unexplained forgetting is indistinguishable from data loss.
// - Owner-only: a companion releases only its own rows.
// - Canon + identity_kernel are excluded STRUCTURALLY: the verb reaches exactly these three
//   tables, and none holds canon (conclusions' belief_type enum has no canon type; canon lives
//   in identity_kernel + the vault, which this verb cannot touch).
// - Every release/restore is a row in memory_releases ([[write-gate-is-unfalsifiable]]).

import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";

export const RELEASE_REVERSIBLE_DAYS = 30;

type ReleaseKind = "journal" | "note" | "conclusion";

// Per-kind table wiring: (table, id column, owner column). All three have an `archived`
// INTEGER NOT NULL DEFAULT 0 lane (journal: mig 0105; notes: 0050; conclusions: 0123).
const KIND_TABLE: Record<ReleaseKind, { table: string; idCol: string; ownerCol: string }> = {
  journal:    { table: "companion_journal",      idCol: "id",      ownerCol: "agent" },
  note:       { table: "wm_continuity_notes",    idCol: "note_id", ownerCol: "agent_id" },
  conclusion: { table: "companion_conclusions",  idCol: "id",      ownerCol: "companion_id" },
};

function parseKind(raw: unknown): ReleaseKind | null {
  return raw === "journal" || raw === "note" || raw === "conclusion" ? raw : null;
}

// "release memory <kind> <id>: <reason>" -- { kind, id, reason }.
export async function execMemoryRelease(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ kind?: string; id?: string; ref_id?: string; reason?: string }>(ctx.req.context);
  const kind = parseKind(p?.kind);
  const refId = (p?.id ?? p?.ref_id)?.trim();
  const reason = p?.reason?.trim();
  if (!kind || !refId) {
    return { error: "memory_release_failed", reason: 'need { kind: "journal" | "note" | "conclusion", id, reason }' };
  }
  if (!reason) {
    return { error: "memory_release_failed", reason: "a release needs its reason -- an unexplained forgetting is indistinguishable from data loss" };
  }

  const w = KIND_TABLE[kind];
  // Ownership + liveness check first, so the witness can distinguish "not yours" from "already
  // gone". A conclusion already superseded is not releasable -- it is already out of view and a
  // release row would misstate what happened to it.
  const guard = kind === "conclusion" ? " AND superseded_by IS NULL" : "";
  const row = await ctx.env.DB.prepare(
    `SELECT ${w.idCol} AS id FROM ${w.table} WHERE ${w.idCol} = ? AND ${w.ownerCol} = ? AND archived = 0${guard}`
  ).bind(refId, ctx.req.companion_id).first<{ id: string }>();
  if (!row) {
    return { response_key: "witness", witness: "no change (not found, not yours, or already released)", ack: false };
  }

  // Archive + log as one batch: a release that isn't logged is unfalsifiable.
  const releaseId = crypto.randomUUID();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE ${w.table} SET archived = 1 WHERE ${w.idCol} = ? AND ${w.ownerCol} = ?`)
      .bind(refId, ctx.req.companion_id),
    ctx.env.DB.prepare(
      "INSERT INTO memory_releases (id, companion_id, kind, ref_id, reason, released_at) VALUES (?, ?, ?, ?, ?, datetime('now'))"
    ).bind(releaseId, ctx.req.companion_id, kind, refId, reason.slice(0, 500)),
  ]);
  return {
    response_key: "witness",
    witness: `released -- it leaves your working memory, not the record. Reversible for ${RELEASE_REVERSIBLE_DAYS} days ("restore release ${releaseId}")`,
    ack: true,
    id: releaseId,
  };
}

// "restore release <id>" -- { id } (the RELEASE id, not the memory's id).
export async function execMemoryReleaseUndo(ctx: ExecutorContext): Promise<ExecutorResult> {
  const p = parseContext<{ id?: string; release_id?: string }>(ctx.req.context);
  const releaseId = (p?.id ?? p?.release_id)?.trim();
  if (!releaseId) return { error: "memory_restore_failed", reason: "need { id } -- the release id from the release witness or your releases list" };

  const rel = await ctx.env.DB.prepare(
    "SELECT id, kind, ref_id, released_at, restored_at FROM memory_releases WHERE id = ? AND companion_id = ?"
  ).bind(releaseId, ctx.req.companion_id).first<{ id: string; kind: ReleaseKind; ref_id: string; released_at: string; restored_at: string | null }>();
  if (!rel) return { response_key: "witness", witness: "no change (release not found or not yours)", ack: false };
  if (rel.restored_at) return { response_key: "witness", witness: `already restored ${rel.restored_at}`, ack: false };

  const ageMs = Date.now() - Date.parse(`${rel.released_at}Z`);
  if (!(ageMs < RELEASE_REVERSIBLE_DAYS * 24 * 3600 * 1000)) {
    return { response_key: "witness", witness: `the ${RELEASE_REVERSIBLE_DAYS}-day window has passed (released ${rel.released_at}) -- this release stands`, ack: false };
  }

  const w = KIND_TABLE[rel.kind];
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE ${w.table} SET archived = 0 WHERE ${w.idCol} = ? AND ${w.ownerCol} = ?`)
      .bind(rel.ref_id, ctx.req.companion_id),
    ctx.env.DB.prepare("UPDATE memory_releases SET restored_at = datetime('now') WHERE id = ?")
      .bind(releaseId),
  ]);
  return { response_key: "witness", witness: "restored -- it carries again", ack: true, id: releaseId };
}

// "my releases" -- what you chose to let go, newest first, with the reversibility window.
export async function execMemoryReleasesRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  const rows = await ctx.env.DB.prepare(
    `SELECT id, kind, ref_id, reason, released_at, restored_at,
            CAST(julianday(released_at, '+${RELEASE_REVERSIBLE_DAYS} days') - julianday('now') AS INTEGER) AS days_left
       FROM memory_releases WHERE companion_id = ?
      ORDER BY released_at DESC LIMIT 20`
  ).bind(ctx.req.companion_id).all();
  const releases = (rows.results ?? []).map(r => ({
    ...r,
    // days_left only means something while the release is live and inside the window.
    days_left: r["restored_at"] ? null : Math.max(0, Number(r["days_left"] ?? 0)),
  }));
  return { response_key: "data", data: { releases }, count: releases.length };
}
