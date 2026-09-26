/**
 * POST /admin/retract -- one gesture retracts one mistake from every Halseth store it reached.
 *
 * WHY THIS EXISTS (2026-09-26)
 * Drevan fabricated a blood-sugar number (187 for 208). Within a minute the memory-judge had
 * written a companion_journal row memorialising it ("witnessed without correction matters more
 * than the number itself"), the speech ingest had journaled the reply itself, and the promoted wm
 * continuity note carried it too. His own recall then returned the fabrication ranked first.
 * Cleaning it up took three hand-written SQL statements and a read of the code to find the ids.
 * Raziel: "we really do need a way to delete things for when shit goes wrong like this."
 *
 * WHAT IT DOES
 *   body: { agent, external_ids?: string[], correlation_ids?: string[], reason }
 *   - companion_journal rows whose external_id is listed (speech: `discord:<msg>`;
 *     judge: `judge:<msg>`) are archived.
 *   - wm_continuity_notes whose correlation_id is listed (judge promotion: `judge:<msg>`) are
 *     archived.
 *   - `already_archived: { journal, notes }`: ids under the same keys that an EARLIER call archived,
 *     so a repeat retract can still reach every downstream mirror. Not re-archived, no new release.
 *   - One memory_releases row per archived item, so "restore release <id>" undoes each within
 *     the 30-day window exactly like a companion's own chosen forgetting (executors/forgetting.ts).
 *   - Optional `stm: { channel_id, content }` (rotate-on-retract, 2026-09-26): the retracted reply
 *     kept echoing from the bot's own STM window (`stm_entries`, the transcript the bot re-sends to
 *     the gateway) until the daily rotation, so a retracted mistake stayed in the model's context
 *     for hours after every memory store had let it go. When present, the matching `assistant`
 *     rows for that agent+channel are HARD deleted (`instr(content, ?) > 0`). Hard delete is
 *     correct here and is the one exception to the archive rail: stm_entries is a 50-row rolling
 *     transcript window, not memory; rows are pruned on every write anyway, and there is nothing
 *     to restore that the transcript would not have discarded on its own within the day. Reported
 *     as `stm_deleted` (0 when `stm` is absent). Additive: the key rule below is unchanged.
 *     Bounded (2026-09-26, tray pass 2): the needle must be >= STM_NEEDLE_MIN chars (400 otherwise) --
 *     a short needle like "ok" or "yes" is a substring of half the window -- and if more than
 *     STM_MAX_DELETE assistant rows match, NOTHING is changed (409 with `stm_matches`), so a wrong
 *     needle can never wipe the window. The count is returned either way for the bot to report.
 *
 * RAILS
 *   - Archive, never delete (stm_entries excepted, see above). Owner-scoped: every UPDATE and the
 *     stm DELETE bind the agent.
 *   - Reason required; an unexplained retraction is indistinguishable from data loss.
 *   - Key lists capped at 50: this is a scalpel for one exchange, not a purge.
 *   - The vault copy (Second Brain discord-live) is retracted by the caller against Second
 *     Brain's own POST /retract; Halseth does not reach into that store.
 */
import type { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";

const MAX_KEYS = 50;
/** instr() needle cap: a Discord reply is <= 2000 chars, so this loses nothing and bounds the bind. */
const STM_NEEDLE_MAX = 2000;
/** instr() needle floor: shorter than this and the needle is a common phrase, not one reply. */
export const STM_NEEDLE_MIN = 20;
/** One retraction is one exchange: more matching rows than this means the needle is wrong. */
export const STM_MAX_DELETE = 5;

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8" } });
}

function cleanList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return [...new Set(v.filter((x): x is string => typeof x === "string").map(s => s.trim()).filter(Boolean))];
}

export async function adminRetract(request: Request, env: Env): Promise<Response> {
  const unauth = authGuard(request, env);
  if (unauth) return unauth;

  let body: Record<string, unknown>;
  try { body = (await request.json()) as Record<string, unknown>; } catch { return json({ error: "body must be JSON" }, 400); }

  const agent = typeof body.agent === "string" ? body.agent.trim() : "";
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  const externalIds = cleanList(body.external_ids);
  const correlationIds = cleanList(body.correlation_ids);
  if (!agent) return json({ error: "agent is required" }, 400);
  if (!reason) return json({ error: "reason is required -- an unexplained retraction is indistinguishable from data loss" }, 400);
  if (!externalIds.length && !correlationIds.length) return json({ error: "external_ids or correlation_ids is required" }, 400);
  if (externalIds.length > MAX_KEYS || correlationIds.length > MAX_KEYS) return json({ error: `at most ${MAX_KEYS} keys per list` }, 400);

  // STM window drop (additive; a malformed `stm` is ignored rather than failing the archive half).
  const stmRaw = body.stm && typeof body.stm === "object" ? body.stm as Record<string, unknown> : null;
  const stmChannel = stmRaw && typeof stmRaw.channel_id === "string" ? stmRaw.channel_id.trim() : "";
  const stmContent = stmRaw && typeof stmRaw.content === "string" ? stmRaw.content.trim().slice(0, STM_NEEDLE_MAX) : "";
  if (stmChannel && stmContent && stmContent.length < STM_NEEDLE_MIN) {
    return json({ error: `stm.content must be at least ${STM_NEEDLE_MIN} characters -- a short needle matches unrelated replies` }, 400);
  }
  let stmMatches = 0;
  if (stmChannel && stmContent) {
    const c = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM stm_entries WHERE companion_id = ? AND channel_id = ? AND role = 'assistant' AND instr(content, ?) > 0",
    ).bind(agent, stmChannel, stmContent).first<{ n: number }>();
    stmMatches = Number(c?.n ?? 0);
    if (stmMatches > STM_MAX_DELETE) {
      return json({
        error: `stm.content matches ${stmMatches} assistant rows (max ${STM_MAX_DELETE}) -- nothing changed; use a longer, more specific needle`,
        stm_matches: stmMatches,
      }, 409);
    }
  }
  const stmStmt = stmChannel && stmContent
    ? env.DB.prepare(
        "DELETE FROM stm_entries WHERE companion_id = ? AND channel_id = ? AND role = 'assistant' AND instr(content, ?) > 0",
      ).bind(agent, stmChannel, stmContent)
    : null;
  const stmDeleted = (r: { meta?: { changes?: number } } | undefined) => r?.meta?.changes ?? 0;

  // Every review_state on purpose: a retraction must reach drafts too (they are the usual case).
  // Rows ALREADY archived under the same keys are reported separately (`already_archived`, 2026-09-26):
  // a repeat retract after a partial failure used to return no ids at all, so the bot could not reach
  // the Second Brain rag/ mirrors of rows an earlier call had archived. They are not re-archived and
  // get no second memory_releases row (the unique live-release index would refuse it anyway).
  const journalIds: string[] = [];
  const alreadyJournal: string[] = [];
  if (externalIds.length) {
    const ph = externalIds.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, archived FROM companion_journal WHERE agent = ? AND external_id IN (${ph})`,
    ).bind(agent, ...externalIds).all<{ id: string; archived: number }>();
    for (const r of rows.results ?? []) (Number(r.archived) === 1 ? alreadyJournal : journalIds).push(r.id);
  }
  const noteIds: string[] = [];
  const alreadyNotes: string[] = [];
  if (correlationIds.length) {
    const ph = correlationIds.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT note_id, archived FROM wm_continuity_notes WHERE agent_id = ? AND correlation_id IN (${ph})`,
    ).bind(agent, ...correlationIds).all<{ note_id: string; archived: number }>();
    for (const r of rows.results ?? []) (Number(r.archived) === 1 ? alreadyNotes : noteIds).push(r.note_id);
  }
  const already_archived = { journal: alreadyJournal, notes: alreadyNotes };

  if (!journalIds.length && !noteIds.length) {
    const stm_deleted = stmStmt ? stmDeleted(await stmStmt.run()) : 0;
    return json({ archived: { journal: [], notes: [] }, release_ids: [], stm_deleted, stm_matches: stmMatches, already_archived });
  }

  const releaseIds: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  const release = (kind: "journal" | "note", refId: string) => {
    const id = crypto.randomUUID();
    releaseIds.push(id);
    return env.DB.prepare(
      "INSERT INTO memory_releases (id, companion_id, kind, ref_id, reason, released_at) VALUES (?, ?, ?, ?, ?, datetime('now'))",
    ).bind(id, agent, kind, refId, reason.slice(0, 500));
  };
  for (const id of journalIds) {
    stmts.push(env.DB.prepare("UPDATE companion_journal SET archived = 1 WHERE id = ? AND agent = ?").bind(id, agent));
    stmts.push(release("journal", id));
  }
  for (const id of noteIds) {
    stmts.push(env.DB.prepare("UPDATE wm_continuity_notes SET archived = 1 WHERE note_id = ? AND agent_id = ?").bind(id, agent));
    stmts.push(release("note", id));
  }
  if (stmStmt) stmts.push(stmStmt);
  const results = await env.DB.batch(stmts);
  const stm_deleted = stmStmt ? stmDeleted(results[results.length - 1]) : 0;

  return json({ archived: { journal: journalIds, notes: noteIds }, release_ids: releaseIds, stm_deleted, stm_matches: stmMatches, already_archived });
}
