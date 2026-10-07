// src/lib/architect-fact-write.ts
//
// ONE write core for architect_facts (mig 0116), shared by the HTTP handler
// (handlers/architect-facts.ts, Hearth /facts + the Hermes-queue drain) and the Librarian executor
// (librarian/executors/architect-facts.ts, every companion write through ask_librarian).
//
// WHY (2026-10-07). Drevan's Claude.ai orient carried an ankle fact ("possible Achilles tear")
// beside the later fact that replaced it, both active. Measured on prod: four ankle rows, all
// source='drevan', NONE with supersedes_id, and three of them SAY in their own text that they
// update an earlier one. The supersede mechanic works (both paths retire the named row); nothing
// ever named a row, for two reasons this file closes:
//
//   1. Two write paths, two behaviours. The HTTP handler had the novelty gate and indexed every
//      fact in Vectorize; the executor -- the path a companion actually uses -- did a bare INSERT.
//      No gate, and no vector, so the NEXT write's gate could not see the row either (3 of the 4
//      ankle rows are absent from halseth-memories). The duplicate check only ever covered the
//      writers that needed it least.
//   2. A companion cannot supersede a fact it cannot name. The orient block rendered facts with
//      no ids, and a write ack said nothing about what the new fact resembled.
//
// So: one core, the gate on both paths, and the ack hands back the nearest live fact's id when
// the new one sits close to it. Retiring stays the COMPANION'S call (mig 0112's rule; the
// handler's Rosie-cluster note is why: rows that look like restatements are often partial records
// of one subject). What changes is that the call is now possible in the same turn -- re-send with
// `supersedes_id`, or link the pair after the fact with `retire_id` + `replaced_by`.

import { noveltyCheck } from "../webmind/novelty.js";
import { storeVector, embedText } from "../mcp/embed.js";
import type { Env } from "../types.js";

export const MAX_FACT_CHARS = 1200;

/** An OPEN write that scores this close to a held open question is the same question (see
 *  noveltyCheck's openSkipThreshold for the measurement). */
export const OPEN_FACT_SKIP = 0.8;

/** At or above this, the ack names the nearest live fact as a possible supersede target. 28 of
 *  6,105 live-fact pairs on prod clear it (2026-10-07), so it is a pointer, not noise. Below it the
 *  ack stays silent. */
export const RELATED_FACT_SURFACE = 0.8;

import { FACT_ID_PREFIX_LEN } from "./open-facts-gate.js";
export { FACT_ID_PREFIX_LEN };

export interface FactWriteInput {
  fact: string;
  category?: string | null;
  status: "active" | "open" | "retired";
  companionId: string | null;
  source?: string | null;
  /** Full id or a unique prefix (>= FACT_ID_PREFIX_LEN chars). */
  supersedesId?: string | null;
  weight?: number | null;
}

export type FactWriteResult =
  | { kind: "invalid"; error: string }
  | { kind: "deduped"; matchId: string; score: number }
  | {
      kind: "written";
      id: string;
      supersedesId: string | null;
      status: string;
      category: string;
      /** The nearest LIVE fact when it scored >= RELATED_FACT_SURFACE and no supersede was named. */
      related: { id: string; score: number } | null;
    };

/**
 * Resolve a writer's reference to a fact id: exact id first, else a UNIQUE prefix of at least
 * FACT_ID_PREFIX_LEN chars. Ambiguity is an error, never a guess -- retiring the wrong fact is
 * irreversible by design.
 */
export async function resolveFactId(
  env: Env,
  ref: string,
): Promise<{ id: string } | { error: string }> {
  const r = ref.trim().replace(/^\[|\]$/g, "");
  if (!r) return { error: "empty fact id" };
  const exact = await env.DB.prepare("SELECT id FROM architect_facts WHERE id = ?")
    .bind(r).first<{ id: string }>();
  if (exact) return { id: exact.id };
  if (r.length < FACT_ID_PREFIX_LEN) return { error: `no fact with id ${r} exists` };
  // LIKE wildcards in the ref itself would widen the match; ids are uuid/seed-NNN, so refuse them.
  if (/[%_]/.test(r)) return { error: `no fact with id ${r} exists` };
  const res = await env.DB.prepare("SELECT id FROM architect_facts WHERE id LIKE ? LIMIT 2")
    .bind(r + "%").all<{ id: string }>();
  const rows = res.results ?? [];
  if (rows.length === 1) return { id: rows[0]!.id };
  if (rows.length > 1) return { error: `fact id prefix ${r} is ambiguous; send the full id` };
  return { error: `no fact with id ${r} exists` };
}

/** Facts are shared, but the vector metadata still records a writer. Unattributed rows use a
 *  stable sentinel so the value is never undefined in the index. */
function gateCompanion(companionId: string | null): string {
  return companionId && companionId.trim() ? companionId.trim() : "shared";
}

export async function writeArchitectFact(env: Env, input: FactWriteInput): Promise<FactWriteResult> {
  const fact = input.fact.trim();
  if (!fact) return { kind: "invalid", error: "fact is required" };
  if (fact.length > MAX_FACT_CHARS) {
    return { kind: "invalid", error: `fact is ${fact.length} chars, over the ${MAX_FACT_CHARS} limit; split it into two facts` };
  }

  let supersedesId: string | null = null;
  if (input.supersedesId && input.supersedesId.trim()) {
    const resolved = await resolveFactId(env, input.supersedesId);
    // Fail loudly. A supersede naming a row that does not exist would otherwise write a duplicate
    // fact and leave the stale one rendering forever.
    if ("error" in resolved) return { kind: "invalid", error: `supersedes_id: ${resolved.error}` };
    supersedesId = resolved.id;
  }

  // NOT FOR A SUPERSEDE (2026-09-26): a correction is by definition close to the row it replaces,
  // so the gate would match the very row being retired and answer deduped. Still embed, so the
  // corrected fact is indexed for the next write's gate. Fails open either way.
  const novelty = supersedesId
    ? { action: "insert" as const, embedding: await embedText(env, fact).catch(() => null) }
    : await noveltyCheck(
        env, fact, "architect_facts", gateCompanion(input.companionId), "table",
        input.status === "open" ? { openSkipThreshold: OPEN_FACT_SKIP } : {},
      );
  if (novelty.action === "skip") {
    return { kind: "deduped", matchId: novelty.matchRowId, score: novelty.score };
  }

  const id = crypto.randomUUID();
  const category = input.category && input.category.trim() ? input.category.trim().toLowerCase() : "general";
  const source = input.source && input.source.trim() ? input.source.trim() : (input.companionId ?? "unattributed");
  const weight = Number.isFinite(Number(input.weight ?? NaN)) ? Number(input.weight) : 100;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO architect_facts
         (id, fact, category, status, companion_id, source, supersedes_id, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(id, fact, category, input.status, input.companionId, source, supersedesId, weight),
  ];
  if (supersedesId) {
    // Retire, never delete: lineage is the whole difference between this and the layer it replaced.
    stmts.push(
      env.DB.prepare("UPDATE architect_facts SET status = 'retired', updated_at = datetime('now') WHERE id = ?")
        .bind(supersedesId),
    );
  }
  await env.DB.batch(stmts);

  // Index after the D1 write and non-fatal: a fact that lands but is not indexed is merely
  // un-deduped next time; a fact lost because indexing failed is gone.
  if (novelty.embedding) {
    await storeVector(env, novelty.embedding, "architect_facts", id, gateCompanion(input.companionId))
      .catch(() => { console.warn(`[architect-facts] vector store failed for ${id} -- fact is saved, dedup will miss it`); });
  }
  if (supersedesId) {
    // The retired row's vector must go, or it keeps matching and the gate answers "I already know
    // that" about a fact nothing renders any more.
    await env.VECTORIZE.deleteByIds([`architect_facts:${supersedesId}`]).catch(() => {});
  }

  const nearest = "nearest" in novelty ? novelty.nearest : undefined;
  const related = !supersedesId && nearest && nearest.score >= RELATED_FACT_SURFACE
    ? { id: nearest.matchRowId, score: nearest.score }
    : null;
  return { kind: "written", id, supersedesId, status: input.status, category, related };
}

/**
 * Link a supersession AFTER both rows exist: `oldRef` retires, `newRef` records it as its
 * predecessor (only if the new row has none -- an existing lineage is never overwritten).
 *
 * This is the half the write ack points at. A companion that wrote a fact and is then told "this
 * sits close to [abc12345]" must be able to say "yes, it replaces that" WITHOUT re-sending the
 * fact, which would write the new row a second time.
 */
export async function linkFactSupersession(
  env: Env,
  oldRef: string,
  newRef: string,
): Promise<{ ok: true; oldId: string; newId: string } | { ok: false; error: string }> {
  const oldR = await resolveFactId(env, oldRef);
  if ("error" in oldR) return { ok: false, error: `retire_id: ${oldR.error}` };
  const newR = await resolveFactId(env, newRef);
  if ("error" in newR) return { ok: false, error: `replaced_by: ${newR.error}` };
  if (oldR.id === newR.id) return { ok: false, error: "a fact cannot replace itself" };

  const rows = await env.DB.prepare("SELECT id, status FROM architect_facts WHERE id IN (?, ?)")
    .bind(oldR.id, newR.id).all<{ id: string; status: string }>();
  const byId = new Map((rows.results ?? []).map((r) => [r.id, r.status]));
  if (byId.get(newR.id) === "retired") return { ok: false, error: `replaced_by ${newR.id} is itself retired` };
  if (byId.get(oldR.id) === "retired") return { ok: false, error: `${oldR.id} is already retired` };

  await env.DB.batch([
    env.DB.prepare("UPDATE architect_facts SET status = 'retired', updated_at = datetime('now') WHERE id = ?")
      .bind(oldR.id),
    env.DB.prepare(
      "UPDATE architect_facts SET supersedes_id = ?, updated_at = datetime('now') WHERE id = ? AND supersedes_id IS NULL",
    ).bind(oldR.id, newR.id),
  ]);
  await env.VECTORIZE.deleteByIds([`architect_facts:${oldR.id}`]).catch(() => {});
  return { ok: true, oldId: oldR.id, newId: newR.id };
}
