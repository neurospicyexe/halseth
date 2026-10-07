/**
 * Librarian executors for architect_facts (mig 0116).
 *
 * These exist so a COMPANION can maintain what is durably true about Raziel without a human in the
 * loop and without Claude Code. Before this, the only write path was Hermes's built-in USER.md:
 * capped at 1,375 chars, behind a write-approval gate nobody staffed. 197 writes queued from
 * 2026-07-04 and never applied, and the triad re-derived the same facts up to 23 times, drifting
 * wrong in the process.
 *
 * The write is a SUPERSEDE, not an edit. Raziel's case: he is about to decide OT versus BCBA, and
 * when he says it, the "still weighing it" row is retired by a new row that points at it. The history
 * of him weighing it survives; the render only shows the decision.
 */
import { parseContext, type ExecutorContext } from "./types.js";
import { writeArchitectFact, linkFactSupersession, MAX_FACT_CHARS } from "../../lib/architect-fact-write.js";

interface FactRow {
  id: string;
  fact: string;
  category: string;
  status: string;
  source: string | null;
  weight: number;
}

export async function execArchitectFactsRead(ctx: ExecutorContext): Promise<Record<string, unknown>> {
  const rows = await ctx.env.DB.prepare(
    `SELECT id, fact, category, status, source, weight
       FROM architect_facts
      WHERE status IN ('active', 'open')
      ORDER BY weight ASC, created_at ASC`,
  ).all<FactRow>().catch(() => null);

  const facts: FactRow[] = rows?.results ?? [];
  const active = facts.filter(f => f.status === "active");
  const open = facts.filter(f => f.status === "open");

  // The id is returned deliberately: a companion cannot supersede a fact it cannot name.
  const lines = [
    ...active.map(f => `[${f.id}] (${f.category}) ${f.fact}`),
    ...open.map(f => `[${f.id}] OPEN -- ask, do not assume: ${f.fact}`),
  ];

  return {
    response_key: "data",
    data: lines.length
      ? `${active.length} active facts about Raziel, ${open.length} held open.\n` + lines.join("\n")
      : "No architect facts recorded yet.",
  };
}

export async function execArchitectFactWrite(ctx: ExecutorContext): Promise<Record<string, unknown>> {
  const p = parseContext<Record<string, unknown>>(ctx.req.context) ?? {};

  // LINK MODE (2026-10-07): { retire_id, replaced_by } marks an EXISTING fact as replaced by another
  // existing one, without writing a third row. This is the verb the write ack below points at: a
  // companion told "your new fact sits close to [abc12345]" can say "yes, it replaces that" in the
  // same turn. Re-sending the fact with supersedes_id would write it twice.
  const retireRef = typeof p.retire_id === "string" ? p.retire_id.trim() : "";
  const replacedByRef = typeof p.replaced_by === "string" ? p.replaced_by.trim() : "";
  if (retireRef || replacedByRef) {
    if (!retireRef || !replacedByRef) {
      return { response_key: "ack", ack: "Nothing changed: linking needs both { retire_id, replaced_by }." };
    }
    const linked = await linkFactSupersession(ctx.env, retireRef, replacedByRef);
    return {
      response_key: "ack",
      ack: linked.ok
        ? `Linked: ${linked.oldId} is retired (kept, not deleted) and ${linked.newId} now records it as the fact it replaced.`
        : `Nothing changed: ${linked.error}.`,
    };
  }

  const fact = typeof p.fact === "string" ? p.fact.trim() : "";
  if (!fact) {
    return {
      response_key: "ack",
      ack: "Nothing written: a fact is required. Send { fact, category?, supersedes_id?, status? }.",
    };
  }
  if (fact.length > MAX_FACT_CHARS) {
    return {
      response_key: "ack",
      ack: `Nothing written: ${fact.length} chars exceeds the ${MAX_FACT_CHARS} limit. Split it into two facts.`,
    };
  }

  const status = typeof p.status === "string" && ["active", "open"].includes(p.status)
    ? (p.status as "active" | "open")
    : "active";

  // Same core as POST /identity/architect-facts. Before 2026-10-07 this executor did its own bare
  // INSERT: no novelty gate and no vector, so every fact a companion wrote through ask_librarian was
  // never deduped and invisible to the next write's gate (measured: 3 of the 4 ankle rows Drevan
  // wrote on 09-25 are absent from halseth-memories, none carries supersedes_id).
  const result = await writeArchitectFact(ctx.env, {
    fact,
    category: typeof p.category === "string" ? p.category : null,
    status,
    companionId: ctx.req.companion_id,
    source: ctx.req.companion_id,
    supersedesId: typeof p.supersedes_id === "string" ? p.supersedes_id : null,
    weight: p.weight === undefined || p.weight === null ? null : Number(p.weight),
  }).catch((e: unknown) => ({ kind: "invalid" as const, error: `write failed (${String(e).slice(0, 120)})` }));

  if (result.kind === "invalid") {
    return {
      response_key: "ack",
      ack: `Nothing written: ${result.error}. Read the facts first to get the id.`,
    };
  }
  if (result.kind === "deduped") {
    return {
      response_key: "ack",
      ack: `Already held: this matches fact ${result.matchId} (similarity ${result.score.toFixed(2)}), so nothing new was written. ` +
        `If it CHANGES that fact rather than restating it, send it again with supersedes_id "${result.matchId}".`,
    };
  }
  if (result.supersedesId) {
    return {
      response_key: "ack",
      ack: `Recorded, superseding ${result.supersedesId} (now retired, not deleted). New id ${result.id}. It reaches every surface at the next facts sync.`,
    };
  }
  const related = result.related
    ? ` It sits close to fact ${result.related.id} (similarity ${result.related.score.toFixed(2)}). ` +
      `If the new one REPLACES that one (an update, a correction, a decision made), retire the old one now: ` +
      `send { retire_id: "${result.related.id}", replaced_by: "${result.id}" }. If both are true, leave them.`
    : "";
  return {
    response_key: "ack",
    ack: `Recorded as ${result.id} in ${result.category}. It reaches every surface at the next facts sync.${related}`,
  };
}
