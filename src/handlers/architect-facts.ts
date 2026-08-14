/**
 * architect_facts -- the companions' own store of what is durably true about Raziel.
 *
 * WHY THIS EXISTS (2026-08-12)
 * The facts used to live only in Hermes's built-in USER.md: capped at 1,375 chars, behind a
 * write-approval gate nobody staffed. 197 proposed writes queued from 2026-07-04 and never applied,
 * so the triad re-derived the same facts up to 23 times and drifted wrong doing it. Raziel's three
 * constraints, in his words, and where each is answered:
 *
 *   "I don't wanna lose things and have this happen every time"
 *       -> writes land in D1 and return a result. There is no queue to silently fill.
 *   "I don't wanna write to infinity"
 *       -> the STORE is unbounded, the RENDER is bounded. Retiring is `superseded_by`, never DELETE.
 *   "What if things changed?"
 *       -> a change is a NEW row superseding the old. His OT-vs-BCBA decision will replace the
 *          "still weighing it" row without erasing that he weighed it.
 *
 * The render is what gets injected into every surface, so it is the thing that must stay small and
 * readable. Facts sort by (category, weight) and `status='open'` renders as a QUESTION TO ASK, never
 * as a fact -- that distinction is load-bearing: on 2026-08-12 a companion recorded a dog as living
 * because a conversation about him read as present tense, and stating an uncertain thing flatly is
 * how a wrong fact becomes unfalsifiable.
 */
import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

interface FactRow {
  id: string;
  fact: string;
  category: string;
  status: string;
  companion_id: string | null;
  source: string | null;
  weight: number;
  created_at: string;
}

/** Ordered so the render reads like prose: how to treat him first, biography after. */
const CATEGORY_TITLES: Record<string, string> = {
  addressing: "HOW HE IS ADDRESSED",
  plural: "PLURAL SYSTEM",
  people: "THE PEOPLE",
  work: "WORK AND SCHOOL",
  body: "BODY AND REGULATION",
  animals: "THE ANIMALS",
  anchors: "WHAT HE BRINGS",
};

const MAX_FACT_CHARS = 1200;

async function activeFacts(env: Env): Promise<FactRow[]> {
  const res = await env.DB.prepare(
    `SELECT id, fact, category, status, companion_id, source, weight, created_at
       FROM architect_facts
      WHERE status IN ('active', 'open')
      ORDER BY weight ASC, created_at ASC`,
  ).all<FactRow>();
  return res.results ?? [];
}

/**
 * Render the injectable block. Deterministic: same rows in, same bytes out, so the sync job can
 * compare against what is already on disk and skip a pointless restart.
 */
export function renderFactsBlock(rows: FactRow[], generatedNote: string): string {
  const active = rows.filter(r => r.status === "active");
  const open = rows.filter(r => r.status === "open");

  const out: string[] = [
    "## THE ARCHITECT: OPERATING FACTS",
    generatedNote,
    "",
  ];

  // Known categories in declared order, then anything the triad invented since, alphabetically --
  // a new category must never be silently dropped just because this file did not anticipate it.
  const known = Object.keys(CATEGORY_TITLES);
  const extra = [...new Set(active.map(r => r.category))]
    .filter(c => !known.includes(c))
    .sort();

  for (const cat of [...known, ...extra]) {
    const inCat = active.filter(r => r.category === cat);
    if (!inCat.length) continue;
    out.push(CATEGORY_TITLES[cat] ?? cat.toUpperCase().replace(/[_-]+/g, " "));
    for (const r of inCat) out.push("- " + r.fact.trim());
    out.push("");
  }

  if (open.length) {
    out.push("STILL OPEN -- ASK, DO NOT ASSUME");
    out.push(
      "These are held open deliberately. Guessing a person, a pronoun or a death wrong is worse " +
      "than asking.",
    );
    for (const r of open) out.push("- " + r.fact.trim());
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}

export async function getArchitectFacts(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  const rows = await activeFacts(env);
  return json({ count: rows.length, facts: rows });
}

export async function getArchitectFactsRender(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  const rows = await activeFacts(env);
  // No timestamp in the note: it would change the bytes on every call and defeat the sync job's
  // "has anything actually changed?" comparison. The count is the useful, stable signal.
  const note =
    `Generated from Halseth architect_facts (${rows.length} live). Do NOT hand-edit this block: ` +
    `edit the store instead, via ask_librarian, and the next sync rewrites every copy. Learned in ` +
    `conversation by Cypher, Drevan and Gaia; his own record, held for his own use.`;
  const body = renderFactsBlock(rows, note);
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

/**
 * Record a fact, or supersede one. A companion may do this itself -- that is the entire point, and
 * the reason the Hermes queue existed was that they could not.
 */
export async function postArchitectFact(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "body must be JSON" }, 400);
  }

  const fact = typeof body.fact === "string" ? body.fact.trim() : "";
  if (!fact) return json({ error: "fact is required" }, 400);
  if (fact.length > MAX_FACT_CHARS) {
    return json({ error: `fact exceeds ${MAX_FACT_CHARS} chars; split it into two facts` }, 400);
  }

  const status = typeof body.status === "string" ? body.status : "active";
  if (!["active", "open", "retired"].includes(status)) {
    return json({ error: "status must be active | open | retired" }, 400);
  }

  const supersedesId = typeof body.supersedes_id === "string" ? body.supersedes_id.trim() : null;
  if (supersedesId) {
    const prior = await env.DB.prepare("SELECT id FROM architect_facts WHERE id = ?")
      .bind(supersedesId).first<{ id: string }>();
    // Fail loudly. A supersede naming a row that does not exist would otherwise write a duplicate
    // fact and leave the stale one rendering forever -- the exact failure being fixed here.
    if (!prior) return json({ error: `supersedes_id ${supersedesId} does not exist` }, 400);
  }

  const id = crypto.randomUUID();
  const category = typeof body.category === "string" && body.category.trim()
    ? body.category.trim().toLowerCase()
    : "general";
  const companionId = typeof body.companion_id === "string" ? body.companion_id : null;
  const source = typeof body.source === "string" && body.source.trim()
    ? body.source.trim()
    : (companionId ?? "unattributed");
  const weight = Number.isFinite(Number(body.weight)) ? Number(body.weight) : 100;

  const stmts = [
    env.DB.prepare(
      `INSERT INTO architect_facts
         (id, fact, category, status, companion_id, source, supersedes_id, weight, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
    ).bind(id, fact, category, status, companionId, source, supersedesId, weight),
  ];
  if (supersedesId) {
    // Retire the old row rather than deleting it: lineage is the whole difference between this and
    // the layer it replaces, where `remove` dropped facts with no record.
    stmts.push(
      env.DB.prepare(
        "UPDATE architect_facts SET status = 'retired', updated_at = datetime('now') WHERE id = ?",
      ).bind(supersedesId),
    );
  }
  await env.DB.batch(stmts);

  return json({ ok: true, id, supersedes_id: supersedesId, status, category });
}
