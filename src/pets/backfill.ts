// B64 Task 7: history backfill. Raziel's ruling: "honor his past and his future". Memories are kept
// (every past interaction gets an appraisal); opinions start fresh (backfill appraisals are source
// 'backfill', weak weight, no quirks matched, and the sleep pass can only seed a weak trait from them,
// never promote). Reads `note` ONLY as a null/non-null signal for the via rule; no text is copied.
import { appraise, type Via } from "./appraise.js";
import { writeAppraisal, type AppraisalRow } from "./store.js";
import { deriveDrives, isValidAction, type LastActed } from "../webmind/creatures.js";
import type { Env } from "../types.js";
import { isAdminToken } from "../lib/auth.js";
import { careFit, SETTLED_WINDOW_MINUTES } from "../webmind/sol-care.js";

export const BACKFILL_BATCH = 50;

/** Via for a past row. Sol's own rows are appearances; the imp and Raziel are what they were. */
export function inferBackfillVia(row: { actor: string; action: string; note: string | null }): Via {
  if (row.actor === "sol") return "appear";
  if (row.actor === "imp") return "imp";
  if (row.actor === "raziel") return "hand";
  if (row.action === "give" && row.note !== null) return "hand";
  return "backfill";
}

interface InteractionRow { id: string; actor: string; action: string; note: string | null; created_at: string }

function toMs(raw: string): number {
  return Date.parse(raw.includes("T") ? raw : raw.replace(" ", "T") + "Z");
}

export async function backfillAppraisals(
  db: D1Database, creatureId: string, nowMs: number,
): Promise<{ inserted: number; skipped: number }> {
  const creature = await db.prepare("SELECT created_at FROM creatures WHERE id = ?").bind(creatureId)
    .first<{ created_at: string | null }>();
  const createdAt = creature?.created_at ?? new Date(nowMs).toISOString();

  const [rows, existing] = await Promise.all([
    db.prepare(
      "SELECT id, actor, action, note, created_at FROM creature_interactions WHERE creature_id = ? ORDER BY created_at ASC, rowid ASC",
    ).bind(creatureId).all<InteractionRow>(),
    db.prepare("SELECT interaction_id FROM creature_appraisals WHERE creature_id = ?").bind(creatureId)
      .all<{ interaction_id: string }>(),
  ]);
  const have = new Set((existing.results ?? []).map((r) => r.interaction_id));

  const stmts: D1PreparedStatement[] = [];
  let skipped = 0;
  // Drives as they stood BEFORE each row: replay the ledger, mirroring performTend's read
  // (per-action last feed/play, and last contact, from non-sol rows).
  const last: LastActed = { feed: null, play: null, any: null };
  const recent: Array<{ actor: string; action: string; ms: number }> = [];

  for (const r of rows.results ?? []) {
    const ms = toMs(r.created_at);
    if (Number.isNaN(ms) || ms > nowMs) { skipped++; continue; }
    const at = new Date(ms).toISOString();
    const isSol = r.actor === "sol";
    const cutoff = ms - SETTLED_WINDOW_MINUTES * 60_000;
    const recentSame = recent.filter((p) => p.actor === r.actor && p.action === r.action && p.ms > cutoff && p.ms <= ms).length;
    const drives = deriveDrives({ ...last }, createdAt, ms);

    // Advance the replay state for the NEXT row whether or not this one is written.
    const advance = () => {
      recent.push({ actor: r.actor, action: r.action, ms });
      if (!isSol) {
        if (r.action === "feed") last.feed = at;
        if (r.action === "play") last.play = at;
        last.any = at;
      }
    };

    if (have.has(r.id)) { skipped++; advance(); continue; }
    if (!isSol && !isValidAction(r.action)) { skipped++; advance(); continue; }

    const action = isSol ? "appear" : (r.action as "feed" | "play" | "talk" | "give");
    const fit = isSol ? null : careFit(action as "feed" | "play" | "talk" | "give", drives, recentSame);
    const via = inferBackfillVia(r);
    // quirks: [] on purpose. Opinions start fresh; a past row never matches (or opens a grudge on) a quirk.
    const ap = appraise({ actor: r.actor, action, fit, via, nowMs: ms, quirks: [], recentSame });
    const row: AppraisalRow = {
      id: crypto.randomUUID().replace(/-/g, ""), creature_id: creatureId, interaction_id: r.id,
      actor: r.actor, action, via, fit, valence: ap.valence, arousal: ap.arousal, friction: ap.friction,
      tags: ap.tags, weight: ap.weight, source: "backfill", created_at: at,
    };
    stmts.push(writeAppraisal(db, row));
    advance();
  }

  let inserted = 0;
  for (let i = 0; i < stmts.length; i += BACKFILL_BATCH) {
    const res = await db.batch(stmts.slice(i, i + BACKFILL_BATCH));
    // INSERT OR IGNORE: a concurrent live write of the same interaction changes 0 rows.
    for (const x of res) inserted += x.meta?.changes ?? 0;
  }
  return { inserted, skipped: skipped + (stmts.length - inserted) };
}

/** POST /admin/creatures/:id/backfill-appraisals. ADMIN_SECRET exactly; companion pets only. */
export async function postBackfillAppraisals(
  request: Request, env: Env, params: Record<string, string>,
): Promise<Response> {
  const json = (b: unknown, status = 200) =>
    new Response(JSON.stringify(b), { status, headers: { "Content-Type": "application/json" } });
  if (!isAdminToken(request, env)) return new Response("Unauthorized", { status: 401 });
  const id = params["id"] ?? "";
  if (!id) return json({ error: "id is required" }, 400);
  const c = await env.DB.prepare("SELECT kind FROM creatures WHERE id = ?").bind(id).first<{ kind: string }>();
  if (!c) return json({ error: "creature not found" }, 404);
  if (c.kind !== "companion_pet") return json({ error: "only a companion pet has appraisals" }, 400);
  return json(await backfillAppraisals(env.DB, id, Date.now()));
}
