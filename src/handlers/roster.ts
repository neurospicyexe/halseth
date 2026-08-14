/**
 * HTTP surface for the system roster (mig 0117).
 *
 * `GET /roster/who?q=<name>`  -- resolve one name. Returns a discriminated `status`, never a bare
 *                               best guess, and distinguishes "not in the roster" from "could not
 *                               check". See src/roster/pk-roster.ts for why that distinction is the
 *                               point of the whole feature.
 * `GET /roster/stats`         -- size, freshness, last sync attempt (including failures).
 * `POST /roster/refresh`      -- force a refresh now; the cron self-gates to 24h otherwise.
 *
 * There is deliberately NO "list the whole roster" endpoint. 538 names is not an answer to any
 * question a companion has, and having the route would invite injecting it into a prompt.
 */
import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { lookupMember, refreshRoster, renderLookup, type SyncRow } from "../roster/pk-roster.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export async function getRosterWho(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  const q = new URL(request.url).searchParams.get("q") ?? "";
  if (!q.trim()) {
    return json({ error: "q is required -- the name to look up" }, 400);
  }
  const result = await lookupMember(env, q);
  // `summary` is the line a companion should actually read; the structured result is for Hearth and
  // for anything that wants the fields.
  return json({ ...result, summary: renderLookup(result) });
}

export async function getRosterStats(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  const meta = await env.DB.prepare(
    `SELECT COUNT(*) AS members,
            SUM(CASE WHEN pronouns IS NOT NULL AND TRIM(pronouns) <> '' THEN 1 ELSE 0 END) AS with_pronouns,
            SUM(CASE WHEN description IS NOT NULL AND TRIM(description) <> '' THEN 1 ELSE 0 END) AS with_description,
            MAX(fetched_at) AS fetched_at
       FROM pk_roster`,
  ).first<{ members: number; with_pronouns: number; with_description: number; fetched_at: string | null }>();

  const sync = await env.DB.prepare(
    `SELECT started_at, finished_at, status, member_count, detail
       FROM pk_roster_sync ORDER BY started_at DESC, id DESC LIMIT 5`,
  ).all<SyncRow>();

  const fetchedAt = meta?.fetched_at ?? null;
  const ageHours = fetchedAt ? (Date.now() - Date.parse(fetchedAt)) / 3_600_000 : null;

  return json({
    members: meta?.members ?? 0,
    // Stated as a count, not a rate: 75 members without pronouns is a fact about what PluralKit
    // exposes unauthenticated, not a data-quality score, and it must never license a default.
    with_pronouns: meta?.with_pronouns ?? 0,
    without_pronouns: (meta?.members ?? 0) - (meta?.with_pronouns ?? 0),
    with_description: meta?.with_description ?? 0,
    fetched_at: fetchedAt,
    age_hours: ageHours === null ? null : Math.round(ageHours * 10) / 10,
    system_id_configured: Boolean(env.PLURALKIT_SYSTEM_ID?.trim()),
    recent_syncs: sync.results ?? [],
  });
}

export async function postRosterRefresh(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  const result = await refreshRoster(env);
  return json(result, result.status === "ok" ? 200 : 502);
}
