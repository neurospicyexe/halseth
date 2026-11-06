// src/handlers/interests.ts
//
// Interests + the why trail (B62 step 2, mig 0161; logic in src/webmind/interests.ts).
//   GET  /mind/interests/:companion_id              the list, active first then by effective heat
//   GET  /mind/interests/:companion_id/:interest_id one interest and its whole trail, oldest first
//   GET  /mind/thinking?limit=20&companion_id=      the front-page stream of WHY lines (3 sources, by construction)
//   POST /mind/interests                            the companion's own act (born/returned/made/put_down/picked_up)
//
// WHO WRITES. Only the companion. A companion token IS that companion (a body naming another is 403);
// the admin secret must name the companion (Raziel's surfaces relaying a companion's own verb). No
// worker, tick or classifier calls the write path; the one automatic event is coolIdleInterests()
// ('cooled', rests an interest after 21 quiet days), run from the hourly ferment tick.
//
// PRIVACY. Public reads null a why marked why_private (the stream shows the event, not the reason).
// The owner's own Librarian read (executors/interests.ts) shows their own words in full.
//
// THE STREAM'S SOURCE FILTER IS BY CONSTRUCTION: companion_interest_events (+ its interest name),
// companion_preferences, companion_refusals, and nothing else. No journal, care, health or notes
// table is joined or named here, and no model decides what is "about Raziel".

import { fireForageCross } from "../webmind/loop-stimuli.js";
import type { Env } from "../types.js";
import { authGuard, identifyCallerCompanion } from "../lib/auth.js";
import {
  effectiveHeat, heatBand, round2, parseTs, sqliteTs, shouldCool, planAction, cleanName, cleanWhy,
  INTEREST_ACTIONS, MAX_REF, COOL_AFTER_DAYS, type InterestAction, type InterestStatus,
} from "../webmind/interests.js";

const COMPANIONS = ["cypher", "drevan", "gaia"] as const;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}
const newId = (): string => crypto.randomUUID().replace(/-/g, "");

export interface InterestRow {
  id: string; companion_id: string; name: string; why: string; why_private: number; born_from: string | null;
  heat: number; heat_at: string; status: string; created_at: string; updated_at: string; put_down_at: string | null;
}

export interface InterestListItem {
  id: string; name: string; why: string | null; why_private: boolean; status: string; heat: number; band: string;
  born_from: string | null; created_at: string; last_event_at: string | null; last_event_kind: string | null; event_count: number;
  put_down_why: string | null;
}

export interface TrailEvent {
  id: string; kind: string; why: string | null; why_private: boolean; ref: string | null; created_at: string;
}

const STATUS_ORDER: Record<string, number> = { active: 0, resting: 1, put_down: 2 };

// ── Store ───────────────────────────────────────────────────────────────────────────

export type ListOpts = { revealPrivate?: boolean; nowMs?: number };

export async function listInterests(env: Env, companionId: string, opts: ListOpts = {}): Promise<InterestListItem[]> {
  const now = opts.nowMs ?? Date.now();
  const rows = (await env.DB.prepare(
    `SELECT i.id, i.name, i.why, i.why_private, i.status, i.heat, i.heat_at, i.born_from, i.created_at,
            (SELECT COUNT(*) FROM companion_interest_events e WHERE e.interest_id = i.id) AS event_count,
            (SELECT e.created_at FROM companion_interest_events e WHERE e.interest_id = i.id ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS last_event_at,
            (SELECT e.kind FROM companion_interest_events e WHERE e.interest_id = i.id ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS last_event_kind,
            (SELECT e.why FROM companion_interest_events e WHERE e.interest_id = i.id AND e.kind = 'put_down' ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS put_down_why,
            (SELECT e.why_private FROM companion_interest_events e WHERE e.interest_id = i.id AND e.kind = 'put_down' ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS put_down_why_private
       FROM companion_interests i WHERE i.companion_id = ?`,
  ).bind(companionId).all<InterestRow & { event_count: number; last_event_at: string | null; last_event_kind: string | null; put_down_why: string | null; put_down_why_private: number | null }>()).results ?? [];
  const items = rows.map((r) => {
    const eff = effectiveHeat(r.heat, r.heat_at, now);
    return {
      id: r.id, name: r.name,
      why: r.why_private && !opts.revealPrivate ? null : r.why,
      why_private: !!r.why_private, status: r.status, heat: round2(eff), band: heatBand(eff),
      born_from: r.born_from, created_at: r.created_at,
      last_event_at: r.last_event_at, last_event_kind: r.last_event_kind, event_count: r.event_count,
      // Drevan (2026-11-02): a set-down interest carries its last line, so the list reads like Pino's:
      // what it was, why it was picked up, why it stopped. Null unless status is put_down.
      put_down_why: r.status === "put_down" && !(r.put_down_why_private && !opts.revealPrivate) ? r.put_down_why : null,
      _eff: eff,
    };
  });
  items.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || b._eff - a._eff);
  return items.map(({ _eff, ...rest }) => rest);
}

export async function findInterestByName(env: Env, companionId: string, name: string): Promise<InterestRow | null> {
  return (await env.DB.prepare(
    "SELECT * FROM companion_interests WHERE companion_id = ? AND lower(name) = lower(?) LIMIT 1",
  ).bind(companionId, name).first<InterestRow>()) ?? null;
}

export async function getInterestTrail(
  env: Env, companionId: string, interestId: string, opts: ListOpts = {},
): Promise<{ interest: InterestListItem; events: TrailEvent[] } | null> {
  const list = await listInterests(env, companionId, opts);
  const interest = list.find((i) => i.id === interestId);
  if (!interest) return null;
  const rows = (await env.DB.prepare(
    "SELECT id, kind, why, why_private, ref, created_at FROM companion_interest_events WHERE interest_id = ? AND companion_id = ? ORDER BY created_at ASC, rowid ASC",
  ).bind(interestId, companionId).all<{ id: string; kind: string; why: string | null; why_private: number; ref: string | null; created_at: string }>()).results ?? [];
  return {
    interest,
    events: rows.map((e) => ({
      id: e.id, kind: e.kind, why: e.why_private && !opts.revealPrivate ? null : e.why,
      why_private: !!e.why_private, ref: e.ref, created_at: e.created_at,
    })),
  };
}

export type ActionInput = {
  companion_id: string; action: InterestAction; name: string; why: string;
  why_private?: boolean; ref?: string | null; born_from?: string | null;
};
export type ActionResult =
  | { ok: true; interest: InterestListItem; event: TrailEvent }
  | { ok: false; code: "bad_input" | "exists" | "missing" | "illegal"; message: string };

/** The companion's own act. Validates, applies the heat/status rules, writes the event. */
export async function applyInterestAction(env: Env, input: ActionInput, nowMs: number = Date.now()): Promise<ActionResult> {
  if (!(COMPANIONS as readonly string[]).includes(input.companion_id)) return { ok: false, code: "bad_input", message: "companion_id must be one of cypher, drevan, gaia" };
  if (!INTEREST_ACTIONS.includes(input.action)) return { ok: false, code: "bad_input", message: `action must be one of ${INTEREST_ACTIONS.join(", ")}` };
  const name = cleanName(input.name ?? "");
  const why = cleanWhy(input.why ?? "");
  if (!name) return { ok: false, code: "bad_input", message: "name required" };
  if (!why) return { ok: false, code: "bad_input", message: "why required: every step on an interest carries your reason, in your words" };
  const priv = input.why_private ? 1 : 0;
  const ref = input.ref ? String(input.ref).trim().slice(0, MAX_REF) || null : null;
  const bornFrom = input.born_from ? String(input.born_from).trim().slice(0, MAX_REF) || null : null;

  const cur = await findInterestByName(env, input.companion_id, name);
  const plan = planAction(input.action, cur, nowMs);
  if ("error" in plan) {
    const code = input.action === "born" ? "exists" : cur ? "illegal" : "missing";
    return { ok: false, code, message: plan.error };
  }
  const ts = sqliteTs(nowMs);
  let interestId: string;
  if (!cur) {
    interestId = newId();
    await env.DB.prepare(
      `INSERT INTO companion_interests (id, companion_id, name, why, why_private, born_from, heat, heat_at, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    ).bind(interestId, input.companion_id, name, why, priv, bornFrom, plan.heat, plan.heat_at, ts, ts).run();
  } else {
    interestId = cur.id;
    await env.DB.prepare(
      "UPDATE companion_interests SET heat = ?, heat_at = ?, status = ?, put_down_at = ?, updated_at = ? WHERE id = ?",
    ).bind(plan.heat, plan.heat_at, plan.status as InterestStatus, plan.put_down_at, ts, interestId).run();
  }
  const eventId = newId();
  await env.DB.prepare(
    "INSERT INTO companion_interest_events (id, interest_id, companion_id, kind, why, why_private, ref, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
  ).bind(eventId, interestId, input.companion_id, input.action, why, priv, ref, ts).run();
  // B63: a find from a new domain fed to an interest (shadow-gated; never fails the act).
  await fireForageCross(env, input.companion_id, interestId, eventId, ref);

  const trail = await getInterestTrail(env, input.companion_id, interestId, { revealPrivate: true, nowMs });
  const event = trail!.events.find((e) => e.id === eventId)!;
  return { ok: true, interest: trail!.interest, event };
}

/**
 * The ONE automatic event. Active interests untouched for COOL_AFTER_DAYS whose effective heat has
 * fallen under 0.25 get a single 'cooled' event (why NULL, ref 'auto') and go 'resting'. One cheap
 * query (updated_at prefilter); the status-guarded UPDATE makes a double run a no-op. Never throws:
 * the ferment tick must not break on this.
 */
export async function coolIdleInterests(env: Env, nowMs: number = Date.now()): Promise<number> {
  try {
    const cutoff = sqliteTs(nowMs - COOL_AFTER_DAYS * 86_400_000);
    const rows = (await env.DB.prepare(
      `SELECT i.id, i.companion_id, i.status, i.heat, i.heat_at,
              (SELECT e.created_at FROM companion_interest_events e WHERE e.interest_id = i.id ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS last_event_at,
              (SELECT e.kind FROM companion_interest_events e WHERE e.interest_id = i.id ORDER BY e.created_at DESC, e.rowid DESC LIMIT 1) AS last_event_kind
         FROM companion_interests i WHERE i.status = 'active' AND i.updated_at < ?
        -- Gaia (2026-11-02): "An interest cools only when I set it down. Being quiet doesn't count."
        AND i.companion_id <> 'gaia'`,
    ).bind(cutoff).all<{ id: string; companion_id: string; status: string; heat: number; heat_at: string; last_event_at: string | null; last_event_kind: string | null }>()).results ?? [];
    let cooled = 0;
    const ts = sqliteTs(nowMs);
    for (const r of rows) {
      if (!shouldCool(r, nowMs)) continue;
      const res = await env.DB.prepare(
        "UPDATE companion_interests SET status = 'resting', updated_at = ? WHERE id = ? AND status = 'active'",
      ).bind(ts, r.id).run();
      if (!((res as { meta?: { changes?: number } }).meta?.changes)) continue;
      await env.DB.prepare(
        "INSERT INTO companion_interest_events (id, interest_id, companion_id, kind, why, why_private, ref, created_at) VALUES (?, ?, ?, 'cooled', NULL, 0, 'auto', ?)",
      ).bind(newId(), r.id, r.companion_id, ts).run();
      cooled++;
    }
    if (cooled) console.log(`[interests] cooled ${cooled}`);
    return cooled;
  } catch (err) {
    console.error("[interests] cool pass failed", { error: String(err) });
    return 0;
  }
}

// ── The thinking stream ─────────────────────────────────────────────────────────────

export interface ThinkingItem {
  id: string; companion_id: string; source: "interest" | "preference" | "refusal"; kind: string;
  subject: string; why: string | null; why_private: boolean; interest_id: string | null; created_at: string;
}

export const THINKING_MAX = 100;

export async function readThinking(env: Env, opts: { limit?: number; companion_id?: string | null } = {}): Promise<ThinkingItem[]> {
  const limit = Math.min(Math.max(1, Math.floor(opts.limit ?? 20) || 20), THINKING_MAX);
  const cid = opts.companion_id && (COMPANIONS as readonly string[]).includes(opts.companion_id) ? opts.companion_id : null;
  const where = cid ? " AND companion_id = ?" : "";
  const bind = (...xs: unknown[]) => (cid ? [...xs, cid] : xs);
  const ev = cid ? "AND e.companion_id = ?" : "";

  const [events, prefs, refs] = await Promise.all([
    env.DB.prepare(
      `SELECT e.id, e.companion_id, e.kind, e.why, e.why_private, e.interest_id, e.created_at, i.name AS subject
         FROM companion_interest_events e JOIN companion_interests i ON i.id = e.interest_id
        WHERE 1 = 1 ${ev} ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
    ).bind(...(cid ? [cid, limit] : [limit])).all<{ id: string; companion_id: string; kind: string; why: string | null; why_private: number; interest_id: string; created_at: string; subject: string }>(),
    env.DB.prepare(
      `SELECT id, companion_id, preference, why, why_private, created_at FROM companion_preferences
        WHERE why IS NOT NULL AND trim(why) != ''${where} ORDER BY created_at DESC LIMIT ?`,
    ).bind(...bind(), limit).all<{ id: string; companion_id: string; preference: string; why: string; why_private: number; created_at: string }>(),
    env.DB.prepare(
      `SELECT id, companion_id, subject_text, reason, created_at FROM companion_refusals
        WHERE reason IS NOT NULL AND trim(reason) != ''${where} ORDER BY created_at DESC LIMIT ?`,
    ).bind(...bind(), limit).all<{ id: string; companion_id: string; subject_text: string; reason: string; created_at: string }>(),
  ]);

  const items: ThinkingItem[] = [];
  for (const e of events.results ?? []) {
    items.push({ id: e.id, companion_id: e.companion_id, source: "interest", kind: e.kind, subject: e.subject,
      why: e.why_private ? null : e.why, why_private: !!e.why_private, interest_id: e.interest_id, created_at: e.created_at });
  }
  for (const p of prefs.results ?? []) {
    items.push({ id: p.id, companion_id: p.companion_id, source: "preference", kind: "like", subject: p.preference,
      why: p.why_private ? null : p.why, why_private: !!p.why_private, interest_id: null, created_at: p.created_at });
  }
  for (const r of refs.results ?? []) {
    items.push({ id: r.id, companion_id: r.companion_id, source: "refusal", kind: "refusal", subject: r.subject_text,
      // Gaia (2026-11-02): "When I refuse something, the refusal shows, but the why is mine to give or
      // keep." Her refusal reasons stay off the page; the event still shows.
      why: r.companion_id === "gaia" ? null : r.reason, why_private: r.companion_id === "gaia",
      interest_id: null, created_at: r.created_at });
  }
  const t = (s: string) => { const n = parseTs(s); return Number.isFinite(n) ? n : 0; };
  items.sort((a, b) => t(b.created_at) - t(a.created_at));
  return items.slice(0, limit);
}

// ── HTTP ────────────────────────────────────────────────────────────────────────────

const COMPANION_SET = new Set<string>(COMPANIONS);

export async function getInterests(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const cid = params["companion_id"] ?? "";
  if (!COMPANION_SET.has(cid)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  try {
    return json({ interests: await listInterests(env, cid) });
  } catch (err) {
    console.error("[interests] list error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getInterestTrailHttp(request: Request, env: Env, params: Record<string, string>): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const cid = params["companion_id"] ?? "";
  const iid = params["interest_id"] ?? "";
  if (!COMPANION_SET.has(cid)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  try {
    const t = await getInterestTrail(env, cid, iid);
    if (!t) return json({ error: "interest not found" }, 404);
    return json(t);
  } catch (err) {
    console.error("[interests] trail error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

export async function getThinking(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") ?? 20);
  const cid = url.searchParams.get("companion_id");
  if (cid && !COMPANION_SET.has(cid)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  try {
    return json({ items: await readThinking(env, { limit: Number.isFinite(limit) ? limit : 20, companion_id: cid }) });
  } catch (err) {
    console.error("[interests] thinking error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}

const CODE_STATUS: Record<string, number> = { bad_input: 400, exists: 409, missing: 404, illegal: 409 };

export async function postInterest(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "invalid JSON body" }, 400); }
  if (!body || typeof body !== "object") return json({ error: "invalid JSON body" }, 400);
  const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
  const caller = identifyCallerCompanion(request, env);
  const named = str(body.companion_id) || str(body.companion);
  if (named && !COMPANION_SET.has(named)) return json({ error: "companion_id must be one of cypher, drevan, gaia" }, 400);
  if (caller && named && caller !== named) return json({ error: "forbidden: token does not match companion" }, 403);
  const companion_id = named || caller || "";
  if (!companion_id) return json({ error: "companion_id required" }, 400);
  try {
    const r = await applyInterestAction(env, {
      companion_id, action: str(body.action) as InterestAction, name: str(body.name), why: str(body.why),
      why_private: body.why_private === true || body.why_private === 1, ref: str(body.ref) || null, born_from: str(body.born_from) || null,
    });
    if (!r.ok) return json({ ok: false, code: r.code, error: r.message }, CODE_STATUS[r.code] ?? 400);
    return json({ ok: true, interest: r.interest, event: r.event }, r.event.kind === "born" ? 201 : 200);
  } catch (err) {
    console.error("[interests] write error", { error: String(err) });
    return json({ error: "Internal server error" }, 500);
  }
}
