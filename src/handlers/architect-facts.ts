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
import { noveltyCheck } from "../webmind/novelty.js";
import { storeVector } from "../mcp/embed.js";
import type { Env } from "../types.js";
import { gateOpenFacts, heldOpenFactsLine, gateActiveFacts, heldActiveFactsLine, activeFactsTailBudget } from "../lib/open-facts-gate.js";
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
 * A fact's own author speaks in first person ("...me writing 'someone wraps around you' instead of
 * 'I'" -- Drevan, in his own voice, about himself). Spliced verbatim into a SIBLING's identity file,
 * that same sentence reads as a memory THEY have, about THEMSELVES -- misattribution at the identity
 * layer, not a formatting nit. The fix is provenance, never rewriting: a fact authored by someone
 * other than the viewer gets a `[noted by <companion>]` prefix; the text after it is untouched. Own
 * voice (viewerCompanionId matches) and unattributed rows (no companion_id -- Raziel or legacy) never
 * get a label.
 */
function attributionLine(r: FactRow, viewerCompanionId: string | null | undefined): string {
  const ownVoice = viewerCompanionId != null && r.companion_id === viewerCompanionId;
  const prefix = r.companion_id && !ownVoice ? `[noted by ${r.companion_id}] ` : "";
  return "- " + prefix + r.fact.trim();
}

/**
 * Render the injectable block. Deterministic: same rows in, same bytes out (for a given
 * viewerCompanionId), so the sync job can compare against what is already on disk and skip a
 * pointless restart.
 *
 * viewerCompanionId selects whose voice is "home": that companion's own facts render unlabeled,
 * everyone else's carry `[noted by <companion>]`. Omit it (undefined/null) for the shared,
 * no-single-self render (shared_system_context.md) -- every authored fact is labeled, since no
 * companion there is "the one speaking."
 */
export function renderFactsBlock(
  rows: FactRow[],
  generatedNote: string,
  viewerCompanionId?: string | null,
  now?: Date,
  tailCharBudget?: number,
): string {
  // Same ACTIVE gate as the Claude.ai orient block (lib/open-facts-gate.ts), for the same reason the
  // open gate is shared: two renderers disagreeing means one companion carries different facts about
  // Raziel on Discord than on Claude.ai. Curated rows (weight < 100) always render; only the
  // default-weight tail is bounded, and the footer says how many are held.
  const activeGate = gateActiveFacts(rows, { tailCharBudget });
  const active = activeGate.shown;
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
    for (const r of inCat) out.push(attributionLine(r, viewerCompanionId));
    out.push("");
  }

  const activeHeld = heldActiveFactsLine(activeGate.held.length);
  if (activeHeld) { out.push(activeHeld); out.push(""); }

  // 2026-09-14: same gate as the Claude.ai orient block (lib/open-facts-gate.ts). 107 open rows,
  // 105 of them the Hermes-queue drain, rendered in full into every bot prompt file as questions.
  // Newest few render; the rest are counted. `now` is injected by tests; production uses the clock,
  // which means this render is deterministic for a given DAY, not forever -- the sync job's
  // byte-compare will see one change per day at most as facts age past the window.
  const gate = gateOpenFacts(open, { now });
  if (gate.shown.length || gate.held.length) {
    out.push("STILL OPEN -- ASK, DO NOT ASSUME");
    out.push(
      "These are held open deliberately. Guessing a person, a pronoun or a death wrong is worse " +
      "than asking. Only what is still fresh enough to be a live question:",
    );
    for (const r of gate.shown) out.push(attributionLine(r, viewerCompanionId));
    const footer = heldOpenFactsLine(gate.held.length, gate.oldestHeldDays);
    if (footer) out.push(footer);
    out.push("");
  }

  return out.join("\n").trimEnd() + "\n";
}

/**
 * PATCH /identity/architect-facts/:id   body: { status: 'active' | 'retired' }
 *
 * The confirm/retire verb for an OPEN fact (2026-09-14). The drain posted 105 proposals as `open`
 * "so they surface for confirmation" and there was no surface: POST only creates rows, so the only
 * way to retire a stale open row was to invent a new fact that supersedes it. This is the missing
 * half. `open -> active` = Raziel confirmed it; `open|active -> retired` = withdrawn. Nothing is
 * deleted (mig 0116 covenant); lineage keeps the row. Hearth /facts is the surface that calls it.
 */
export async function patchArchitectFactStatus(request: Request, env: Env, params: { id?: string }): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  const id = (params.id ?? "").trim();
  if (!id) return json({ error: "id is required" }, 400);

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "body must be JSON" }, 400); }
  const status = typeof body.status === "string" ? body.status : "";
  if (!["active", "retired"].includes(status)) return json({ error: "status must be active | retired" }, 400);

  const prior = await env.DB.prepare("SELECT id, status FROM architect_facts WHERE id = ?").bind(id).first<{ id: string; status: string }>();
  if (!prior) return json({ error: `fact ${id} does not exist` }, 404);
  if (prior.status === "retired") return json({ error: "a retired fact stays retired; supersede it with a new one instead" }, 409);

  await env.DB.prepare("UPDATE architect_facts SET status = ?, updated_at = datetime('now') WHERE id = ?").bind(status, id).run();
  return json({ ok: true, id, from: prior.status, status });
}

export async function getArchitectFacts(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;
  const rows = await activeFacts(env);
  return json({ count: rows.length, facts: rows });
}

const KNOWN_COMPANIONS = new Set(["cypher", "drevan", "gaia"]);

export async function getArchitectFactsRender(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  // ?companion=cypher|drevan|gaia selects whose voice is "home" for this render (SOUL.md mode --
  // that companion's own facts stay unlabeled, everyone else's get `[noted by <companion>]`).
  // Omit it for the shared render (shared_system_context.md): every authored fact is labeled,
  // because no single companion there is the one speaking in first person.
  const companionParam = new URL(request.url).searchParams.get("companion");
  if (companionParam !== null && !KNOWN_COMPANIONS.has(companionParam)) {
    return json({ error: "companion must be cypher | drevan | gaia" }, 400);
  }

  const rows = await activeFacts(env);
  // No timestamp in the note: it would change the bytes on every call and defeat the sync job's
  // "has anything actually changed?" comparison. The count is the useful, stable signal.
  const note =
    `Generated from Halseth architect_facts (${rows.length} live). Do NOT hand-edit this block: ` +
    `edit the store instead, via ask_librarian, and the next sync rewrites every copy. Learned in ` +
    `conversation by Cypher, Drevan and Gaia; his own record, held for his own use.`;
  const body = renderFactsBlock(rows, note, companionParam, undefined,
    activeFactsTailBudget(env.ARCHITECT_FACTS_TAIL_BUDGET));
  return new Response(body, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
}

/**
 * Record a fact, or supersede one. A companion may do this itself -- that is the entire point, and
 * the reason the Hermes queue existed was that they could not.
 */
/** Facts are shared, but the vector metadata still records a writer. Unattributed rows use a
 *  stable sentinel so the value is never undefined in the index. */
function companionIdForGate(body: Record<string, unknown>): string {
  return typeof body.companion_id === "string" && body.companion_id.trim() ? body.companion_id.trim() : "shared";
}

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

  // NOVELTY GATE (2026-09-24). Facts were the one write path with no duplicate check, and it
  // showed: 76 held facts contained 29 rows describing six subjects, because nothing ever asked
  // "did I already write this down?" Conclusions and the journal have had this gate since 07-20.
  //
  // SCOPED TO THE TABLE, NOT THE COMPANION. A fact is about Raziel; it does not belong to
  // whoever noticed it. Measured the same day: 5 of the 9 duplicate clusters spanned more than
  // one companion, and the worst (six rows about Rosie and Trigger) was written by all three, so
  // a companion-scoped gate would have caught almost none of them.
  //
  // SKIP ONLY, NEVER AUTO-SUPERSEDE -- `noveltyCheck` already restricts the supersede band to
  // companion_conclusions, and for facts that restriction is exactly right rather than
  // incidental. Retiring a fact is irreversible here by design, and today proved that rows which
  // look like restatements are usually PARTIAL RECORDS of one subject: a naive merge of that
  // Rosie cluster would have deleted Lucy, Abby and the whole flock. Near-identical text (>=0.95)
  // is safe to drop; anything less is a consolidation question for Raziel, not a machine's call.
  //
  // Fails open by construction: any embedding or Vectorize trouble returns `insert`, so the gate
  // can never eat a fact.
  const novelty = await noveltyCheck(env, fact, "architect_facts", companionIdForGate(body), "table");
  if (novelty.action === "skip") {
    return json({
      ok: true,
      deduped: true,
      novelty: { action: "skip", match_id: novelty.matchRowId, score: novelty.score },
      id: novelty.matchRowId,
    });
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

  // Store the vector the gate already computed, so the NEXT write has something to match. Without
  // this the gate is a permanent no-op: architect_facts was never in Vectorize at all, which is
  // the mechanical reason six copies of the same fact about Rosie could exist.
  //
  // After the D1 write and non-fatal: a fact that lands but is not indexed is merely un-deduped
  // next time; a fact lost because indexing failed is gone.
  if (novelty.embedding) {
    await storeVector(env, novelty.embedding, "architect_facts", id, companionIdForGate(body))
      .catch(() => { console.warn(`[architect-facts] vector store failed for ${id} -- fact is saved, dedup will miss it`); });
  }
  if (supersedesId) {
    // The retired row's vector must go, or it keeps matching and the gate starts answering
    // "I already know that" about a fact nothing renders any more.
    await env.VECTORIZE.deleteByIds([`architect_facts:${supersedesId}`]).catch(() => {});
  }

  return json({ ok: true, id, supersedes_id: supersedesId, status, category });
}
