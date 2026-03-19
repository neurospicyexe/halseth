import { Env } from "../types.js";
import { generateId } from "../db/queries.js";
import { embedAndStore } from "../mcp/embed.js";

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
  // Require ADMIN_SECRET if set.
  if (env.ADMIN_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

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
  if (env.ADMIN_SECRET) {
    const auth = request.headers.get("Authorization") ?? "";
    if (auth !== `Bearer ${env.ADMIN_SECRET}`) {
      return new Response("Unauthorized", { status: 401 });
    }
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
      sql:          "SELECT id, content, companion_id FROM dreams",
      getText:      (r) => r.content as string,
      getCompanion: (r) => r.companion_id as string,
    },
    companion_journal: {
      sql:          "SELECT id, note_text, agent FROM companion_journal",
      getText:      (r) => r.note_text as string,
      getCompanion: (r) => r.agent as string,
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

  for (const t of targets) {
    const def = TABLES[t];
    if (!def) {
      return new Response(JSON.stringify({ error: `Unknown table: ${t}` }), { status: 400 });
    }
    const rows = await env.DB.prepare(def.sql).all();
    let count = 0;
    for (const row of (rows.results as Record<string, unknown>[])) {
      const text = def.getText(row);
      if (!text) continue;
      embedAndStore(env, text, t, row.id as string, def.getCompanion(row));
      count++;
    }
    results[t] = count;
  }

  return new Response(JSON.stringify({ backfilled: results }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
