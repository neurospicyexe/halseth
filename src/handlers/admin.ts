import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { embedAndStoreBatch, EMBEDDING_MODEL } from "../mcp/embed.js";
import { safeEqual } from "../lib/auth.js";
import { FAST_PATH_PATTERNS } from "../librarian/patterns.js";

interface CompanionSeed {
  id: string;
  display_name: string;
  role: string;
  facets?: string[];
  depth_range?: { min: number; max: number };
  lanes?: string[];
}

interface WoundSeed {
  name: string;
  description: string;
}

interface FossilSeed {
  subject: string;
  directive: string;
  reason: string;
  refresh_trigger?: string;
}

interface BootstrapBody {
  system?: {
    name?: string;
    owner?: string;
    plural?: boolean;
    coordination?: boolean;
    members?: string[];
  };
  companions?: CompanionSeed[];
  wounds?: WoundSeed[];
  fossils?: FossilSeed[];
}

export async function bootstrapConfig(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return new Response("Service not configured: ADMIN_SECRET required", { status: 503 });
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.ADMIN_SECRET}`)) return new Response("Unauthorized", { status: 401 });

  let body: BootstrapBody;
  try {
    body = await request.json() as BootstrapBody;
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }

  const now = new Date().toISOString();
  const statements: D1PreparedStatement[] = [];

  // ── system_config ──────────────────────────────────────────────────────────
  const sys = body.system ?? {};
  const sysName  = sys.name          ?? env.SYSTEM_NAME  ?? "Halseth";
  const sysOwner = sys.owner         ?? env.SYSTEM_OWNER ?? "owner";
  const sysPlural       = sys.plural       ?? false;
  const sysCoordination = sys.coordination ?? true;
  const sysMembers      = sys.members      ?? [sysOwner];

  const configRows: [string, string][] = [
    ["system.name",        sysName],
    ["system.owner",       sysOwner],
    ["system.plural",      String(sysPlural)],
    ["system.coordination", String(sysCoordination)],
    ["system.members",     JSON.stringify(sysMembers)],
  ];

  for (const [key, value] of configRows) {
    statements.push(
      env.DB.prepare(
        "INSERT OR IGNORE INTO system_config (key, value, updated_at) VALUES (?, ?, ?)"
      ).bind(key, value, now)
    );
  }

  // ── companion_config ───────────────────────────────────────────────────────
  for (const c of body.companions ?? []) {
    statements.push(
      env.DB.prepare(`
        INSERT OR REPLACE INTO companion_config (id, display_name, role, facets, depth_range, lanes, active)
        VALUES (?, ?, ?, ?, ?, ?, 1)
      `).bind(
        c.id,
        c.display_name,
        c.role,
        c.facets ? JSON.stringify(c.facets) : null,
        c.depth_range ? JSON.stringify(c.depth_range) : null,
        c.lanes ? JSON.stringify(c.lanes) : null,
      )
    );
  }

  // ── living_wounds ──────────────────────────────────────────────────────────
  // Wounds seeded here use INSERT OR IGNORE so re-running bootstrap is safe.
  // do_not_archive and do_not_resolve are always 1 per schema DEFAULT.
  for (const w of body.wounds ?? []) {
    statements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO living_wounds (id, created_at, name, description, do_not_archive, do_not_resolve)
        VALUES (?, ?, ?, ?, 1, 1)
      `).bind(generateId(), now, w.name, w.description)
    );
  }

  // ── prohibited_fossils ─────────────────────────────────────────────────────
  for (const f of body.fossils ?? []) {
    statements.push(
      env.DB.prepare(`
        INSERT OR IGNORE INTO prohibited_fossils (id, subject, directive, reason, created_at, refresh_trigger)
        VALUES (?, ?, ?, ?, ?, ?)
      `).bind(generateId(), f.subject, f.directive, f.reason, now, f.refresh_trigger ?? null)
    );
  }

  if (statements.length === 0) {
    return new Response(JSON.stringify({ seeded: 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  }

  await env.DB.batch(statements);

  return new Response(
    JSON.stringify({ seeded: statements.length, at: now }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * POST /admin/backfill-embeddings
 * One-time endpoint to embed all existing rows into Vectorize.
 * Process one table at a time via the ?table= param to avoid timeouts.
 * Remove this endpoint once backfill is complete.
 */
export async function backfillEmbeddings(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return new Response("Service not configured: ADMIN_SECRET required", { status: 503 });
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.ADMIN_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(request.url);
  const table = url.searchParams.get("table");

  const TABLES: Record<string, { sql: string; getText: (r: Record<string, unknown>) => string; getCompanion: (r: Record<string, unknown>) => string }> = {
    relational_deltas: {
      sql:          "SELECT id, delta_text, agent FROM relational_deltas WHERE delta_text IS NOT NULL",
      getText:      (r) => r.delta_text as string,
      getCompanion: (r) => (r.agent as string) ?? "",
    },
    feelings: {
      sql:          "SELECT id, emotion, sub_emotion, companion_id FROM feelings",
      getText:      (r) => r.sub_emotion ? `${r.emotion} — ${r.sub_emotion}` : r.emotion as string,
      getCompanion: (r) => r.companion_id as string,
    },
    dreams: {
      sql:          "SELECT id, dream_text AS content, companion_id FROM companion_dreams",
      getText:      (r) => r.content as string,
      getCompanion: (r) => r.companion_id as string,
    },
    companion_journal: {
      sql:          "SELECT id, note_text, agent FROM companion_journal",
      getText:      (r) => r.note_text as string,
      getCompanion: (r) => r.agent as string,
    },
    // 2026-07-09: continuity notes were never embedded, so they had NO meaning-weight retrieval
    // path at all -- recallable only if something already knew the note_id. 4,202 of 4,441 had
    // never been accessed, and Guardian's orphan_memory was right to say so. `note_id AS id`
    // because the rebuild loop keys on `row.id`.
    wm_continuity_notes: {
      sql:          "SELECT note_id AS id, content, agent_id FROM wm_continuity_notes",
      getText:      (r) => r.content as string,
      getCompanion: (r) => r.agent_id as string,
    },
    living_wounds: {
      sql:          "SELECT id, name, description FROM living_wounds",
      getText:      (r) => `${r.name}: ${r.description}`,
      getCompanion: () => "gaia",
    },
    cypher_audit: {
      sql:          "SELECT id, content FROM cypher_audit",
      getText:      (r) => r.content as string,
      getCompanion: () => "cypher",
    },
  };

  const targets = table ? [table] : Object.keys(TABLES);
  const results: Record<string, number> = {};

  // Pagination (2026-07-09). `SELECT ... .all()` silently TRUNCATES at D1's result-size cap:
  // a companion_journal rebuild reported `{companion_journal: 2500}` and stopped, having never
  // seen the newest ~2,100 rows -- including the 1,023 backfilled speech rows it was run to
  // repair. Nothing errored; the count read like a total. A rebuild that silently covers half
  // the table is worse than none, because it reports success.
  //
  // Page by a stable ORDER BY id with LIMIT/OFFSET, and return `scanned` + `has_more` so the
  // caller can tell "done" from "truncated". Wrapping def.sql as a subquery keeps each table's
  // own WHERE clause intact.
  const pageSize = Math.min(Math.max(parseInt(url.searchParams.get("limit") ?? "500", 10) || 500, 1), 2000);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10) || 0, 0);
  let scanned = 0;
  let hasMore = false;
  const errors: Array<{ table: string; offset: number; error: string }> = [];

  for (const t of targets) {
    const def = TABLES[t];
    if (!def) {
      return new Response(JSON.stringify({ error: `Unknown table: ${t}` }), { status: 400 });
    }
    const rows = await env.DB.prepare(
      `SELECT * FROM (${def.sql}) ORDER BY id LIMIT ?1 OFFSET ?2`
    ).bind(pageSize, offset).all();
    const allRows = (rows.results as Record<string, unknown>[]);
    scanned += allRows.length;
    if (allRows.length === pageSize) hasMore = true;

    // Batch embed+upsert (50/req) so large tables stay within Cloudflare's
    // per-request subrequest limit -- a per-row loop fails on big tables.
    const BATCH = 50;
    let count = 0;
    for (let i = 0; i < allRows.length; i += BATCH) {
      const items = allRows.slice(i, i + BATCH)
        .map(row => ({ text: def.getText(row), table: t, rowId: row.id as string, companionId: def.getCompanion(row) }))
        .filter(it => it.text);
      try {
        count += await embedAndStoreBatch(env, items);
      } catch (err) {
        // Surface the failure to the CALLER, not only to a log nobody is tailing. A swallowed
        // batch error meant this endpoint returned 200 {"backfilled": 0} -- a rebuild reporting
        // success while doing nothing, which is how a stale index hides. (2026-07-09)
        console.error("[backfill] batch embed failed", { table: t, offset: offset + i, err: String(err) });
        errors.push({ table: t, offset: offset + i, error: String(err).slice(0, 300) });
      }
    }
    results[t] = count;
  }

  return new Response(JSON.stringify({
    backfilled: results, scanned, offset, limit: pageSize, has_more: hasMore,
    ...(errors.length > 0 ? { errors } : {}),
  }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * POST /admin/seed-routing-vectors
 * Seeds FAST_PATH_PATTERNS trigger phrases into Vectorize with table="routing" metadata.
 * Idempotent: uses deterministic IDs so re-running updates existing vectors without duplication.
 * Run once after deploy, then again whenever new fast-path patterns are added.
 */
export async function seedRoutingVectors(request: Request, env: Env): Promise<Response> {
  if (!env.ADMIN_SECRET) return new Response("Service not configured: ADMIN_SECRET required", { status: 503 });
  const auth = request.headers.get("Authorization") ?? "";
  if (!safeEqual(auth, `Bearer ${env.ADMIN_SECRET}`)) {
    return new Response("Unauthorized", { status: 401 });
  }

  // Clean up orphaned vectors from renamed pattern keys (best-effort, non-fatal)
  const ORPHAN_KEYS = [
    "drevan_thread_add", "drevan_thread_close", "drevan_thread_veto",
    "drevan_anticipation_set", "conclusion_supersede", "get_state",
  ];
  const orphanIds = ORPHAN_KEYS.flatMap(k => Array.from({ length: 20 }, (_, i) => `routing:${k}:${i}`));
  try { await env.VECTORIZE.deleteByIds(orphanIds); } catch { /* non-fatal */ }

  // Flatten all triggers into a single list with stable IDs
  type TriggerItem = { id: string; text: string; patternKey: string };
  const items: TriggerItem[] = [];
  for (const [patternKey, entry] of Object.entries(FAST_PATH_PATTERNS)) {
    entry.triggers.forEach((trigger, i) => {
      if (trigger) items.push({ id: `routing:${patternKey}:${i}`, text: trigger, patternKey });
    });
  }

  // Batch embed: bge-base supports multi-text input, avoids per-trigger rate-limit exhaustion
  const BATCH = 50;
  let seeded = 0;
  let errors = 0;

  for (let start = 0; start < items.length; start += BATCH) {
    const chunk = items.slice(start, start + BATCH);
    try {
      const embedding = await env.AI.run(EMBEDDING_MODEL, {
        text: chunk.map(c => c.text),
      }) as { data: number[][] };
      const vectors = chunk
        .map((c, idx) => {
          const v = embedding.data[idx];
          if (!v) return null;
          return { id: c.id, values: v, metadata: { table: "routing", rowId: c.patternKey, companionId: "system" } };
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
      if (vectors.length > 0) {
        await env.VECTORIZE.upsert(vectors);
        seeded += vectors.length;
      }
      errors += chunk.length - vectors.length;
    } catch (err) {
      console.error("[seedRoutingVectors] batch failed", { start, err: String(err) });
      errors += chunk.length;
    }
  }

  const patternKeys = [...new Set(items.map(i => i.patternKey))];
  return new Response(JSON.stringify({ seeded, errors, patterns: patternKeys.length, pattern_keys: patternKeys }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
