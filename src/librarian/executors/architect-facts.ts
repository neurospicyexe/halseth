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

interface FactRow {
  id: string;
  fact: string;
  category: string;
  status: string;
  source: string | null;
  weight: number;
}

const MAX_FACT_CHARS = 1200;

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
    ? p.status
    : "active";
  const category = typeof p.category === "string" && p.category.trim()
    ? p.category.trim().toLowerCase()
    : "general";
  const weight = Number.isFinite(Number(p.weight)) ? Number(p.weight) : 100;
  const supersedesId = typeof p.supersedes_id === "string" && p.supersedes_id.trim()
    ? p.supersedes_id.trim()
    : null;

  if (supersedesId) {
    const prior = await ctx.env.DB.prepare("SELECT id FROM architect_facts WHERE id = ?")
      .bind(supersedesId).first<{ id: string }>().catch(() => null);
    // Say so rather than writing a duplicate and leaving the stale row rendering forever.
    if (!prior) {
      return {
        response_key: "ack",
        ack: `Nothing written: no fact with id ${supersedesId} exists to supersede. Read the facts first to get the id.`,
      };
    }
  }

  const id = crypto.randomUUID();
  const stmts = [
    ctx.env.DB.prepare(
      `INSERT INTO architect_facts
         (id, fact, category, status, companion_id, source, supersedes_id, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(id, fact, category, status, ctx.req.companion_id, ctx.req.companion_id, supersedesId, weight),
  ];
  if (supersedesId) {
    // Retire, never delete. Losing lineage is the specific failure this table replaces.
    stmts.push(
      ctx.env.DB.prepare(
        "UPDATE architect_facts SET status = 'retired', updated_at = datetime('now') WHERE id = ?",
      ).bind(supersedesId),
    );
  }
  await ctx.env.DB.batch(stmts);

  return {
    response_key: "ack",
    ack: supersedesId
      ? `Recorded, superseding ${supersedesId} (now retired, not deleted). New id ${id}. It reaches every surface at the next facts sync.`
      : `Recorded as ${id} in ${category}. It reaches every surface at the next facts sync.`,
  };
}
