// Raw HTTP for the imp tray (mig 0132, 2026-09-26) -- Hearth and ops. Companions use the Librarian
// verbs ("my tray", "keep draft <id>", "drop draft <id>"); both doors call webmind/tray.ts.
//
//   GET  /admin/tray?agent=<id>&limit=20
//   POST /admin/tray/draft { agent, content, source, dedup_key? }  (B47: load outside text into a tray)
//   POST /admin/tray/review { agent, kind: "journal"|"note", id, decision: "kept"|"dropped", content?, reverse? }
//
// Only a live draft is reviewed (409 already_reviewed otherwise). { reverse: true } is Raziel's override
// to re-decide a kept/dropped row; Hearth's /tray lists drafts only and never sends it.

import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { isCompanionId } from "../companions.js";
import { noteInsert } from "../webmind/tray-insert.js";
import { TRAY_IMPORT_CORRELATION_PREFIX } from "../webmind/review-state.js";
import { listTray, reviewDraft, parseTrayKind, parseTrayDecision } from "../webmind/tray.js";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

export async function getAdminTray(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent")?.trim() ?? "";
  if (!isCompanionId(agent)) return json({ error: "agent must be cypher, drevan, or gaia" }, 400);
  const rawLimit = parseInt(url.searchParams.get("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) ? rawLimit : undefined;
  const view = await listTray(env, agent, limit);
  return json(view);
}

export async function postAdminTrayReview(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const agent = typeof body["agent"] === "string" ? body["agent"].trim() : "";
  if (!isCompanionId(agent)) return json({ error: "agent must be cypher, drevan, or gaia" }, 400);
  const kind = parseTrayKind(body["kind"]);
  if (!kind) return json({ error: 'kind must be "journal" or "note"' }, 400);
  const id = typeof body["id"] === "string" ? body["id"].trim() : "";
  if (!id) return json({ error: "id is required" }, 400);
  const decision = parseTrayDecision(body["decision"]);
  if (!decision) return json({ error: 'decision must be "kept" or "dropped"' }, 400);
  const content = typeof body["content"] === "string" ? body["content"] : null;
  const reverse = body["reverse"] === true;

  const r = await reviewDraft(env, { agent, kind, id, decision, content, reverse });
  if (!r.ok) {
    if (r.reason === "not_found") return json({ error: "not found (or not this agent's row)" }, 404);
    if (r.reason === "bad_id") return json({ error: "id must be the full id or a prefix of at least 8 characters (letters, digits, - or _)" }, 400);
    if (r.reason === "ambiguous") return json({ error: "ambiguous id prefix -- nothing changed; use more of the id", matches: r.matches }, 409);
    if (r.reason === "already_reviewed") {
      return json({ error: `already ${r.review_state}${r.reviewed_at ? ` on ${r.reviewed_at}` : ""} -- nothing changed; pass reverse: true to re-decide`, ...r }, 409);
    }
    if (r.reason === "archived") return json({ error: "row is archived (retracted/released) -- the tray does not un-retract", ...r }, 409);
    if (r.reason === "rewrite_unavailable") return json({ error: "keep-with-rewrite needs migration 0133 -- keep as written or drop", ...r }, 503);
    return json({ error: "content, when given, must be non-empty" }, 400);
  }
  return json(r);
}

export const TRAY_DRAFT_MAX_CHARS = 4000;
const SOURCE_RE = /^[A-Za-z0-9_:-]{2,64}$/; // spec example "hermes_memory:MEMORY" has capitals, so case-insensitive
const DEDUP_KEY_MAX = 200;

async function sha256Hex(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Create ONE draft in a companion's own tray (wm_continuity_notes, review_state 'draft', born by the
 * rule in review-state.ts via the tray_import: correlation prefix). Never embeds and never runs the
 * novelty gate: a draft is not searchable memory until its owner keeps it (a keep-with-rewrite
 * re-embeds; a plain keep leaves the row unindexed, as for every other clerk draft).
 * Provenance: source column = the caller's tag, and the text carries a leading "[<source>]" tag (the
 * convention of "[discord:pulse]"), which is what "review my tray" excerpts show.
 * Idempotent on correlation_id = tray_import:<dedup_key | sha256(agent|source|content)>, across every
 * review state: a dropped draft is not resurrected by a re-run.
 */
export async function postAdminTrayDraft(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) return json({ error: "Invalid JSON body" }, 400);
  const agent = typeof body["agent"] === "string" ? body["agent"].trim() : "";
  if (!isCompanionId(agent)) return json({ error: "agent must be cypher, drevan, or gaia" }, 400);
  const content = typeof body["content"] === "string" ? body["content"].trim() : "";
  if (content.length < 1 || content.length > TRAY_DRAFT_MAX_CHARS) {
    return json({ error: `content must be 1..${TRAY_DRAFT_MAX_CHARS} characters` }, 400);
  }
  const source = typeof body["source"] === "string" ? body["source"].trim() : "";
  if (!SOURCE_RE.test(source)) return json({ error: "source must match /^[A-Za-z0-9_:-]{2,64}$/" }, 400);
  let dedupKey: string;
  if (body["dedup_key"] === undefined || body["dedup_key"] === null) {
    dedupKey = await sha256Hex(`${agent}
${source}
${content}`);
  } else if (typeof body["dedup_key"] === "string" && body["dedup_key"].trim().length > 0 && body["dedup_key"].trim().length <= DEDUP_KEY_MAX) {
    dedupKey = body["dedup_key"].trim();
  } else {
    return json({ error: `dedup_key, when given, must be a non-empty string up to ${DEDUP_KEY_MAX} characters` }, 400);
  }
  const correlation = `${TRAY_IMPORT_CORRELATION_PREFIX}${dedupKey}`;

  const existing = await env.DB.prepare(
    `SELECT note_id FROM wm_continuity_notes WHERE agent_id = ? AND correlation_id = ? LIMIT 1`,
  ).bind(agent, correlation).first<{ note_id: string }>();
  if (existing) return json({ id: existing.note_id, created: false, agent }, 200);

  const id = crypto.randomUUID();
  await noteInsert(env.DB, {
    note_id: id,
    agent_id: agent,
    thread_key: null,
    note_type: "tray_import",
    content: `[${source}] ${content}`,
    salience: "normal",
    actor: "system",
    source,
    correlation_id: correlation,
    created_at: new Date().toISOString(),
  }).run();
  return json({ id, created: true, agent }, 201);
}
