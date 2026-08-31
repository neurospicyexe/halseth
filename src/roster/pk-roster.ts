/**
 * pk_roster -- the system roster as a lookup, so an unfamiliar name is a question, not an error.
 *
 * WHY (2026-08-12): a companion called a real system member "drift" because there was nothing to
 * check the name against outside the Discord bots. The standing rule "never treat an unfamiliar name
 * as an error, look it up" was recorded without a place to look it up. This is that place.
 *
 * THE ONE INVARIANT THIS FILE EXISTS TO HOLD: "I looked, and this name is not in the roster" and
 * "I could not look" are DIFFERENT ANSWERS and must never collapse into each other. A cold or failed
 * cache answering `not_found` would re-arm the exact failure being fixed -- asserting something
 * confidently wrong about a real person. Hence `status: "unavailable"` and the `pk_roster_sync`
 * table behind it.
 *
 * Second invariant: this resolver never picks a winner it is not sure about. An exact label match
 * that two members share returns BOTH (measured: cecilia, hermes, robbie). A partial match returns
 * candidates LABELLED as candidates. A ranked list whose top row is always "the answer" cannot
 * express absence, and absence is the whole point here.
 *
 * NOT the same job as `nullsafe-discord/packages/shared/src/pk-roster.ts`. That one maps a PluralKit
 * webhook username to a sender TIER for proxy attribution and must never guess, because a wrong
 * guess grants Raziel's authority to a stranger. This one is a fuzzy SEARCH over partial names.
 * Deliberately separate implementations -- do not "unify" them, or the search behaviour will silently
 * become the attribution behaviour and drop that guarantee.
 */
import type { Env } from "../types.js";

/** How stale the cached roster may be before the cron refreshes it. Member lists change rarely. */
const REFRESH_AFTER_HOURS = 24;
/** Above this, a lookup will not serve the cache at all -- it reports staleness instead of guessing. */
const HARD_STALE_HOURS = 24 * 14;
const PK_TIMEOUT_MS = 20_000;
/** Candidate cap. Clipped lists always report the true total (see `total_matches`). */
const MAX_CANDIDATES = 8;

export interface RosterMember {
  member_id: string;
  name: string;
  display_name: string | null;
  /** null = not recorded OR recorded privately. Never defaulted. */
  pronouns: string | null;
  description: string | null;
  avatar_url: string | null;
  proxy_tags: string | null;
  message_count: number | null;
  birthday: string | null;
  system_id: string;
  fetched_at: string;
}

export type RosterLookup =
  /** Exactly one member owns this label. */
  | { status: "found"; query: string; member: RosterMember; roster_size: number; fetched_at: string }
  /** The label is owned by more than one member. Both are returned; the caller must not choose. */
  | { status: "ambiguous"; query: string; members: RosterMember[]; roster_size: number; fetched_at: string }
  /** No exact label; these merely CONTAIN the query. Explicitly not answers. */
  | { status: "candidates"; query: string; candidates: RosterMember[]; total_matches: number; roster_size: number; fetched_at: string }
  /** We looked at a healthy roster and this name is genuinely not in it. */
  | { status: "not_found"; query: string; roster_size: number; fetched_at: string }
  /** We could NOT look. Never conflate with not_found. */
  | { status: "unavailable"; query: string; reason: string; last_sync: SyncRow | null; roster_size: number };

export interface SyncRow {
  started_at: string;
  finished_at: string | null;
  status: string;
  member_count: number | null;
  detail: string | null;
}

interface PkApiMember {
  id: string;
  uuid?: string | null;
  system?: string | null;
  name?: string | null;
  display_name?: string | null;
  pronouns?: string | null;
  description?: string | null;
  avatar_url?: string | null;
  color?: string | null;
  birthday?: string | null;
  proxy_tags?: unknown;
  message_count?: number | null;
  created?: string | null;
  last_message_timestamp?: string | null;
}

/** Lowercase, collapse internal whitespace, trim. Applied to both sides of every comparison. */
export function norm(s: string | null | undefined): string {
  return (s ?? "").toLowerCase().replace(/\s+/g, " ").trim();
}

function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

const MEMBER_COLS = `member_id, name, display_name, pronouns, description, avatar_url,
                     proxy_tags, message_count, birthday, system_id, fetched_at`;

// ── Refresh ──────────────────────────────────────────────────────────────────────────────────

export interface RefreshResult {
  status: "ok" | "http_error" | "fetch_error" | "no_system_id";
  member_count: number | null;
  detail: string | null;
}

/**
 * Fetch the roster from PluralKit and upsert it.
 *
 * Never blanks the table on failure: a stale roster is far more useful than an empty one, and an
 * empty one would make every lookup answer `unavailable` for the wrong reason. Every attempt writes
 * a `pk_roster_sync` row, success or not, so the failure is visible rather than silent.
 */
export async function refreshRoster(env: Env): Promise<RefreshResult> {
  const systemId = env.PLURALKIT_SYSTEM_ID?.trim();
  const startedAt = nowIso();

  const record = async (r: RefreshResult): Promise<RefreshResult> => {
    try {
      await env.DB.prepare(
        `INSERT INTO pk_roster_sync (started_at, finished_at, status, member_count, detail)
         VALUES (?, ?, ?, ?, ?)`,
      ).bind(startedAt, nowIso(), r.status, r.member_count, r.detail).run();
    } catch (e) {
      console.error("[pk-roster] could not record sync row:", e);
    }
    return r;
  };

  if (!systemId) {
    // A configuration fault, deliberately its own status: "nobody told me which system" is not
    // "the system has no members."
    return record({ status: "no_system_id", member_count: null, detail: "PLURALKIT_SYSTEM_ID is unset" });
  }

  let members: PkApiMember[];
  try {
    const res = await fetch(`https://api.pluralkit.me/v2/systems/${encodeURIComponent(systemId)}/members`, {
      headers: { "user-agent": "halseth-roster/1 (nullsafe)" },
      signal: AbortSignal.timeout(PK_TIMEOUT_MS),
    });
    if (!res.ok) {
      return record({
        status: "http_error",
        member_count: null,
        detail: `PluralKit returned HTTP ${res.status} (rate limit, private member list, or bad system id)`,
      });
    }
    const body = await res.json();
    if (!Array.isArray(body)) {
      return record({ status: "http_error", member_count: null, detail: "PluralKit returned a non-array body" });
    }
    members = body as PkApiMember[];
  } catch (e) {
    return record({
      status: "fetch_error",
      member_count: null,
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  if (members.length === 0) {
    // Ambiguous between "genuinely empty" and "list went private and PK answered 200 with []".
    // Keeping whatever we already have is the safe read.
    return record({ status: "http_error", member_count: 0, detail: "PluralKit returned zero members; cache left as-is" });
  }

  const fetchedAt = nowIso();
  const stmt = env.DB.prepare(
    `INSERT INTO pk_roster (member_id, uuid, system_id, name, display_name, pronouns, description,
                            avatar_url, color, birthday, proxy_tags, message_count, pk_created,
                            last_message_at, name_norm, display_norm, fetched_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     ON CONFLICT(member_id) DO UPDATE SET
       uuid=excluded.uuid, system_id=excluded.system_id, name=excluded.name,
       display_name=excluded.display_name, pronouns=excluded.pronouns,
       description=excluded.description, avatar_url=excluded.avatar_url, color=excluded.color,
       birthday=excluded.birthday, proxy_tags=excluded.proxy_tags,
       message_count=excluded.message_count, pk_created=excluded.pk_created,
       last_message_at=excluded.last_message_at, name_norm=excluded.name_norm,
       display_norm=excluded.display_norm, fetched_at=excluded.fetched_at`,
  );

  const batch = [];
  for (const m of members) {
    if (!m.id || !m.name) continue;
    batch.push(stmt.bind(
      m.id,
      m.uuid ?? null,
      m.system ?? systemId,
      m.name,
      m.display_name ?? null,
      m.pronouns ?? null,
      m.description ?? null,
      m.avatar_url ?? null,
      m.color ?? null,
      m.birthday ?? null,
      m.proxy_tags ? JSON.stringify(m.proxy_tags) : null,
      typeof m.message_count === "number" ? m.message_count : null,
      m.created ?? null,
      m.last_message_timestamp ?? null,
      norm(m.name),
      m.display_name ? norm(m.display_name) : null,
      fetchedAt,
    ));
  }

  // D1 caps a batch; chunk rather than assume 538 statements are accepted in one call.
  const CHUNK = 50;
  for (let i = 0; i < batch.length; i += CHUNK) {
    await env.DB.batch(batch.slice(i, i + CHUNK));
  }

  // Members removed upstream are deleted, but only after a SUCCESSFUL fetch -- doing it before, or
  // on a failed fetch, would empty the roster on a transient PluralKit outage.
  await env.DB.prepare(
    `DELETE FROM pk_roster WHERE system_id = ? AND fetched_at <> ?`,
  ).bind(systemId, fetchedAt).run();

  const done = await record({ status: "ok", member_count: batch.length, detail: null });
  // Best-effort: the sync log is evidence, not state, so a prune failure must not fail the refresh.
  try { await pruneRosterSyncLog(env); } catch { /* ignore */ }
  return done;
}

/**
 * Cron entry. TWO gates, and the second one is the important one.
 *
 * The obvious gate is roster age. But an EMPTY table has no age, so age alone skips the gate
 * entirely -- and this rides a cron that fires every MINUTE. On success that self-heals in one tick;
 * on sustained failure (PLURALKIT_SYSTEM_ID not yet set, or PluralKit returning 429) it would retry
 * every 60 seconds forever, insert ~1,440 `pk_roster_sync` rows a day, and hammer PluralKit exactly
 * when it is already rate-limiting us.
 *
 * So the second gate is the last ATTEMPT, with backoff: after a failure, wait
 * RETRY_AFTER_MINUTES before trying again. Retry pressure has to be bounded by attempts, not by the
 * state the attempts are failing to produce.
 */
const RETRY_AFTER_MINUTES = 30;

export async function runRosterRefresh(env: Env): Promise<{ ran: boolean; skipped?: string; result?: RefreshResult }> {
  // This gate rides the every-minute cron. COUNT(*) here scanned all ~538 roster rows per tick
  // (2.4M rows read/day); the gate only needs "any rows at all", which EXISTS answers in 1 row.
  // MAX(fetched_at) is a single seek on the 0128 fetched_at index. lookupMember keeps its real
  // COUNT(*) -- it is on-demand and reports roster_size to a human.
  const row = await env.DB.prepare(
    `SELECT (SELECT MAX(fetched_at) FROM pk_roster) AS newest,
            EXISTS(SELECT 1 FROM pk_roster) AS has_rows`,
  ).first<{ newest: string | null; has_rows: number }>();

  if (row?.newest && (row.has_rows ?? 0) > 0) {
    const ageHours = (Date.now() - Date.parse(row.newest)) / 3_600_000;
    if (Number.isFinite(ageHours) && ageHours < REFRESH_AFTER_HOURS) return { ran: false, skipped: "fresh" };
  }

  // Backoff gate. Applies to any recent attempt, not only failed ones: a successful attempt that
  // somehow left the table empty (PluralKit 200 with `[]`) must also not spin.
  const attempt = await env.DB.prepare(
    `SELECT started_at FROM pk_roster_sync ORDER BY started_at DESC, id DESC LIMIT 1`,
  ).first<{ started_at: string }>();
  if (attempt?.started_at) {
    const sinceMin = (Date.now() - Date.parse(attempt.started_at)) / 60_000;
    if (Number.isFinite(sinceMin) && sinceMin < RETRY_AFTER_MINUTES) {
      return { ran: false, skipped: "backoff" };
    }
  }

  return { ran: true, result: await refreshRoster(env) };
}

/**
 * Trim the sync log. Kept deliberately generous (it is the evidence behind every `unavailable`
 * answer) but not unbounded -- a long outage plus the backoff above is ~48 rows a day.
 */
export async function pruneRosterSyncLog(env: Env, keep = 200): Promise<void> {
  await env.DB.prepare(
    `DELETE FROM pk_roster_sync WHERE id NOT IN (
       SELECT id FROM pk_roster_sync ORDER BY started_at DESC, id DESC LIMIT ?
     )`,
  ).bind(keep).run();
}

// ── Lookup ───────────────────────────────────────────────────────────────────────────────────

async function lastSync(env: Env): Promise<SyncRow | null> {
  return await env.DB.prepare(
    `SELECT started_at, finished_at, status, member_count, detail
       FROM pk_roster_sync ORDER BY started_at DESC, id DESC LIMIT 1`,
  ).first<SyncRow>();
}

/**
 * Resolve a name against the roster.
 *
 * Order: exact label (name or display_name) -> substring candidates -> not_found. Each step's result
 * is typed distinctly so a caller cannot accidentally render a candidate as an answer.
 */
export async function lookupMember(env: Env, rawQuery: string): Promise<RosterLookup> {
  const query = (rawQuery ?? "").trim();
  const q = norm(query);

  const meta = await env.DB.prepare(
    `SELECT COUNT(*) AS n, MAX(fetched_at) AS newest FROM pk_roster`,
  ).first<{ n: number; newest: string | null }>();
  const rosterSize = meta?.n ?? 0;
  const fetchedAt = meta?.newest ?? "";

  if (!q) {
    return { status: "unavailable", query, reason: "no name given to look up", last_sync: await lastSync(env), roster_size: rosterSize };
  }

  // "Cannot look" checks come FIRST and always. Answering not_found out of an empty or badly stale
  // cache is the failure this module exists to prevent.
  if (rosterSize === 0) {
    const sync = await lastSync(env);
    return {
      status: "unavailable",
      query,
      reason: sync
        ? `the roster cache is empty; last sync attempt was ${sync.status}${sync.detail ? ` (${sync.detail})` : ""}`
        : "the roster cache is empty and has never been synced",
      last_sync: sync,
      roster_size: 0,
    };
  }
  if (fetchedAt) {
    const ageHours = (Date.now() - Date.parse(fetchedAt)) / 3_600_000;
    if (Number.isFinite(ageHours) && ageHours > HARD_STALE_HOURS) {
      return {
        status: "unavailable",
        query,
        reason: `the roster cache is ${Math.round(ageHours / 24)} days old (last fetched ${fetchedAt}); a new member added since would read as 'not found'`,
        last_sync: await lastSync(env),
        roster_size: rosterSize,
      };
    }
  }

  const exact = await env.DB.prepare(
    `SELECT ${MEMBER_COLS} FROM pk_roster
      WHERE name_norm = ?1 OR display_norm = ?1
      -- "(x IS NULL)" rather than "NULLS LAST": same ordering, but it does not depend on the newer
      -- SQLite syntax, so local miniflare and remote D1 cannot disagree about it.
      ORDER BY (message_count IS NULL) ASC, message_count DESC, name ASC`,
  ).bind(q).all<RosterMember>();
  const exactRows = exact.results ?? [];

  const sole = exactRows[0];
  if (exactRows.length === 1 && sole) {
    return { status: "found", query, member: sole, roster_size: rosterSize, fetched_at: fetchedAt };
  }
  if (exactRows.length > 1) {
    // Measured: 3 labels in the live roster are owned by two members each. Returning one of them
    // would be a coin flip presented as a fact.
    return { status: "ambiguous", query, members: exactRows, roster_size: rosterSize, fetched_at: fetchedAt };
  }

  // Substring. Count first so a clipped list can state its true total -- prose that says "and
  // others" without a number is the defect, not the fix.
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
  const counted = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM pk_roster
      WHERE name_norm LIKE ?1 ESCAPE '\\' OR display_norm LIKE ?1 ESCAPE '\\'`,
  ).bind(like).first<{ n: number }>();
  const total = counted?.n ?? 0;

  if (total > 0) {
    const cands = await env.DB.prepare(
      `SELECT ${MEMBER_COLS} FROM pk_roster
        WHERE name_norm LIKE ?1 ESCAPE '\\' OR display_norm LIKE ?1 ESCAPE '\\'
        ORDER BY LENGTH(name_norm) ASC, (message_count IS NULL) ASC, message_count DESC, name ASC
        LIMIT ?2`,
    ).bind(like, MAX_CANDIDATES).all<RosterMember>();
    return {
      status: "candidates",
      query,
      candidates: cands.results ?? [],
      total_matches: total,
      roster_size: rosterSize,
      fetched_at: fetchedAt,
    };
  }

  return { status: "not_found", query, roster_size: rosterSize, fetched_at: fetchedAt };
}

// ── Rendering ────────────────────────────────────────────────────────────────────────────────

function pronounLine(m: RosterMember): string {
  // Absence is stated as absence. 75 of 538 members have no pronouns recorded, and PluralKit nulls
  // private fields on an unauthenticated read, so we genuinely cannot tell "none set" from "not
  // shared" -- say so rather than pick one. Defaulting here is precisely how a member gets
  // misgendered by a system that was trying to be helpful.
  return m.pronouns?.trim()
    ? m.pronouns.trim()
    : "pronouns not recorded (or not public) -- ask, do not assume";
}

function oneLine(m: RosterMember): string {
  const shown = m.display_name && norm(m.display_name) !== norm(m.name)
    ? `${m.name} (shows as "${m.display_name}")`
    : m.name;
  return `${shown} -- ${pronounLine(m)} [${m.member_id}]`;
}

/**
 * Trim a PluralKit description down to the part that carries information.
 *
 * Members decorate their bios heavily (`˚・✭ ꒰☆꒱✫・゜`, `**ʚ...ɞ**`), and measured against the live
 * roster the decoration is often the majority of the bytes. An enumerate-the-bad-ranges approach was
 * tried first and missed most of it -- there are too many blocks. So this is a WHITELIST: keep
 * letters, digits, whitespace and the punctuation that carries meaning (`/` matters, it separates
 * "Nonbinary Masc/Bi/Old Enough"), drop everything else.
 *
 * The point is a line a companion can read mid-turn, not a faithful reproduction of the bio. Anyone
 * who needs the original has `description` on the structured result.
 */
function briefDescription(d: string | null): string | null {
  if (!d) return null;
  const segments = d
    .split(/[\n|]+/)
    .map((line) =>
      line
        .replace(/[*_~`]/g, "")                            // markdown emphasis
        .replace(/[^\p{L}\p{N}\s.,:;'"!?()/&+-]/gu, " ")   // whitelist; everything else is decoration
        .replace(/\s{2,}/g, " ")
        .replace(/^[\s./,&+-]+|[\s./,&+-]+$/g, "")
        .trim(),
    )
    // A segment needs at least two actual letters to be worth carrying.
    .filter((line) => (line.match(/\p{L}/gu) ?? []).length >= 2);

  const cleaned = segments.join(" / ").replace(/\s{2,}/g, " ").trim();
  if (!cleaned) return null;
  return cleaned.length > 320 ? `${cleaned.slice(0, 317).trimEnd()}...` : cleaned;
}

/**
 * Human-readable answer. Deliberately says what KIND of answer it is in the first clause, because
 * the difference between "this is who that is" and "I could not check" has to survive being read
 * quickly by a companion mid-turn.
 */
export function renderLookup(r: RosterLookup): string {
  switch (r.status) {
    case "found": {
      const m = r.member;
      const parts = [`${oneLine(m)} -- roster-verified system member.`];
      const d = briefDescription(m.description);
      if (d) parts.push(`Their own description: ${d}`);
      if (m.proxy_tags && m.proxy_tags !== "[]") parts.push(`Proxy tags: ${m.proxy_tags}`);
      if (typeof m.message_count === "number") parts.push(`${m.message_count} proxied messages on record.`);
      return parts.join(" ");
    }
    case "ambiguous":
      return `"${r.query}" is owned by ${r.members.length} different members, so this is ambiguous -- `
        + `do not pick one: ${r.members.map(oneLine).join(" | ")}`;
    case "candidates": {
      const shown = r.candidates.length;
      const more = r.total_matches > shown
        ? ` Showing ${shown} of ${r.total_matches} partial matches; narrow the name to see the rest.`
        : "";
      return `No member is named exactly "${r.query}". These ${shown} CONTAIN it and are candidates, `
        + `not answers: ${r.candidates.map(oneLine).join(" | ")}.${more}`;
    }
    case "not_found":
      return `Looked, and "${r.query}" is not in the roster (${r.roster_size} members, `
        + `fetched ${r.fetched_at}). That is a real absence, not a failed lookup -- but the roster `
        + `covers registered members only, so a nickname or a very new member could still be real. Ask.`;
    case "unavailable":
      return `Could NOT check "${r.query}" -- ${r.reason}. This is not the same as "no such member": `
        + `treat the name as possibly real and ask rather than calling it an error.`;
  }
}
