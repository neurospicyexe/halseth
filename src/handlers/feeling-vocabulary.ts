// src/handlers/feeling-vocabulary.ts
//
// The feeling-line write path, HTTP side (STATUS B5; logic and the seven gates in
// src/webmind/vocabulary-write.ts).
//   POST /mind/feeling-vocabulary   {companion_id?, row_kind, word?, conditions, cause_kind?, renders_number?,
//                                    authored_on, authored_at?, capture_id?, note?, supersedes?, dry_run?}
//   GET  /mind/feeling-vocabulary?companion_id=<id>[&status=active|superseded|rejected|all]
//
// Who is who: a per-companion token IS that companion, and a body naming another is 403 (one companion,
// one vocabulary, gate E). The admin secret (Raziel, or a bot relaying a companion's own words) must name
// the companion. A refusal is 422 with EVERY gate's reason and evidence; nothing is renamed or fixed.
// FEELING_LINE_MODE is not read or changed here.

import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import { COMPANIONS, proposeVocabularyRow, type ProposeInput } from "../webmind/vocabulary-write.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

export async function postFeelingVocabulary(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "invalid JSON body" }, 400);

  const caller = identifyCallerCompanion(request, env);
  const named = typeof body.companion_id === "string" ? body.companion_id : typeof body.companion === "string" ? body.companion : "";
  if (caller && named && caller !== named) return json({ error: "forbidden: token does not match companion" }, 403);
  const companion = named || caller || "";
  if (!companion) return json({ error: "companion_id required" }, 400);

  const input: ProposeInput = {
    companion_id: companion,
    row_kind: String(body.row_kind ?? ""),
    word: typeof body.word === "string" ? body.word : null,
    conditions: body.conditions,
    cause_kind: typeof body.cause_kind === "string" ? body.cause_kind : null,
    renders_number: body.renders_number === true || body.renders_number === 1,
    specificity: typeof body.specificity === "number" ? body.specificity : undefined,
    authored_on: String(body.authored_on ?? ""),
    authored_at: typeof body.authored_at === "string" ? body.authored_at : undefined,
    capture_id: typeof body.capture_id === "string" ? body.capture_id : null,
    note: typeof body.note === "string" ? body.note : null,
    supersedes: typeof body.supersedes === "string" ? body.supersedes : null,
    dry_run: body.dry_run === true,
  };
  try {
    const r = await proposeVocabularyRow(env.DB as never, input);
    if (r.ok) return json(r, r.dry_run ? 200 : 201);
    if (r.code === "refused") return json(r, 422);
    return json({ ok: false, code: r.code, error: r.message }, 503);
  } catch (err) {
    console.error("[mind/feeling-vocabulary] write error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getFeelingVocabulary(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const companion = url.searchParams.get("companion_id") ?? identifyCallerCompanion(request, env) ?? "";
  if (!(COMPANIONS as readonly string[]).includes(companion)) return json({ error: "companion_id must be cypher, drevan or gaia" }, 400);
  const status = url.searchParams.get("status") ?? "active";
  if (!["active", "superseded", "rejected", "all"].includes(status)) return json({ error: "bad status" }, 400);
  try {
    const sql = `SELECT id, companion_id, row_kind, word, conditions, cause_kind, specificity, renders_number, status,
                        authored_on, authored_at, capture_id, supersedes, note
                   FROM companion_feeling_vocabulary
                  WHERE companion_id = ?1 ${status === "all" ? "" : "AND status = ?2"}
                  ORDER BY specificity DESC, authored_at ASC`;
    const stmt = status === "all" ? env.DB.prepare(sql).bind(companion) : env.DB.prepare(sql).bind(companion, status);
    const res = await stmt.all();
    return json({ companion_id: companion, status, rows: res.results ?? [] });
  } catch (err) {
    if (/no such table/i.test(String(err))) return json({ error: "not available" }, 404);
    console.error("[mind/feeling-vocabulary] read error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
