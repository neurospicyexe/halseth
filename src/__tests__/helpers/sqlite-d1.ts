// A real SQLite behind the D1 shape, with the REAL schema (every migration in migrations/, in order).
//
// Why: a fake that answers by table name can only prove a query string contains a word. The imp-tray
// gate is a property of what rows come back, so the tests that guard it run the actual statements
// against the actual columns (node:sqlite, built in since Node 22). All 139 migrations apply cleanly
// in node's SQLite -- verified 2026-09-26.
//
// D1 surface covered: prepare(sql).bind(...).{first,all,run}, the same three unbound, batch([...]),
// and run() returning { meta: { changes, last_row_id } } (handlers read meta.changes).
//
// `upTo` stops before the first migration whose number is greater -- e.g. upTo: 132 gives the schema
// as it stands in prod until 0133 is applied, so a missing-column fallback is tested for real.

import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = fileURLToPath(new URL("../../../migrations/", import.meta.url).href);

function migrationNumber(file: string): number {
  const m = /^(\d{4})/.exec(file);
  return m ? Number(m[1]) : Number.NaN;
}

export interface SqliteD1 {
  db: DatabaseSync;
  /** The D1Database-shaped binding. */
  DB: any;
  /** Every SQL string prepared, in order (for "was it called at all" checks, never for gating asserts). */
  prepared: string[];
}

export function makeSqliteD1(opts: { upTo?: number } = {}): SqliteD1 {
  const db = new DatabaseSync(":memory:");
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    const n = migrationNumber(f);
    if (opts.upTo !== undefined && n > opts.upTo) continue;
    db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8"));
  }
  const prepared: string[] = [];

  const norm = (binds: unknown[]): any[] =>
    binds.map((b) => (b === undefined ? null : typeof b === "boolean" ? (b ? 1 : 0) : b));

  // D1 binds `?NNN` positionally (?1 = first bind); node:sqlite does not. Rewrite each ?NNN to a plain
  // `?` and lay the binds out in occurrence order, so a numbered query runs exactly as on D1.
  const numbered = (sql: string, binds: unknown[]): [string, unknown[]] => {
    if (!/\?\d/.test(sql)) return [sql, binds];
    const out: unknown[] = [];
    const text = sql.replace(/\?(\d+)/g, (_m, n: string) => { out.push(binds[Number(n) - 1]); return "?"; });
    return [text, out];
  };

  const exec = (rawSql: string, rawBinds: unknown[]) => {
    const [sql, binds] = numbered(rawSql, rawBinds);
    return execPlain(sql, binds);
  };

  const execPlain = (sql: string, binds: unknown[]) => ({
    first: async <T = unknown>(col?: string): Promise<T | null> => {
      const row = db.prepare(sql).get(...norm(binds)) as Record<string, unknown> | undefined;
      if (!row) return null;
      return (col ? (row[col] as T) : ({ ...row } as T));
    },
    all: async <T = unknown>(): Promise<{ results: T[]; success: true; meta: Record<string, unknown> }> => ({
      results: (db.prepare(sql).all(...norm(binds)) as Record<string, unknown>[]).map((r) => ({ ...r })) as T[],
      success: true,
      meta: {},
    }),
    run: async () => {
      const r = db.prepare(sql).run(...norm(binds));
      return { success: true, meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
    },
  });

  const stmt = (sql: string, binds: unknown[] = []) => {
    const e = exec(sql, binds);
    return {
      __sql: sql,
      __binds: binds,
      bind: (...b: unknown[]) => stmt(sql, b),
      first: e.first,
      all: e.all,
      run: e.run,
    };
  };

  const DB = {
    prepare: (sql: string) => {
      prepared.push(sql);
      return stmt(sql);
    },
    batch: async (stmts: Array<{ run: () => Promise<unknown> }>) => {
      const out: unknown[] = [];
      for (const s of stmts) out.push(await s.run());
      return out;
    },
  };

  return { db, DB, prepared };
}

// ── Row seeders (only the columns a test cares about; the rest take schema defaults) ──────────

export interface JournalSeed {
  id: string;
  agent?: string;
  note_text?: string;
  source?: string | null;
  created_at?: string;
  review_state?: "draft" | "kept" | "dropped";
  reviewed_at?: string | null;
  archived?: 0 | 1;
  tags?: string | null;
  session_id?: string | null;
  topic_tags?: string | null;
  processing_status?: string | null;
}

/** INSERT only the given columns (undefined = schema default), so NOT NULL defaults still apply. */
function insertRow(db: DatabaseSync, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row).filter((k) => row[k] !== undefined);
  db.prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .run(...(cols.map((c) => row[c]) as any[]));
}

export function seedJournal(db: DatabaseSync, r: JournalSeed): void {
  insertRow(db, "companion_journal", {
    agent: "cypher", note_text: `text of ${r.id}`, created_at: new Date().toISOString(), review_state: "kept", archived: 0,
    ...r,
  });
}

export function seedSession(db: DatabaseSync, r: { id: string; companion_id?: string; created_at?: string }): void {
  const at = r.created_at ?? new Date().toISOString();
  insertRow(db, "sessions", { id: r.id, companion_id: r.companion_id ?? "cypher", created_at: at, updated_at: at });
}

export interface NoteSeed {
  note_id: string;
  agent_id?: string;
  content?: string;
  salience?: string;
  note_type?: string;
  source?: string;
  created_at?: string;
  review_state?: "draft" | "kept" | "dropped";
  reviewed_at?: string | null;
  archived?: 0 | 1;
  thread_key?: string | null;
  heat?: number;
}

export function seedNote(db: DatabaseSync, r: NoteSeed): void {
  insertRow(db, "wm_continuity_notes", {
    agent_id: "cypher", content: `content of ${r.note_id}`, salience: "normal", note_type: "continuity", source: "system",
    created_at: new Date().toISOString(), review_state: "kept", archived: 0, heat: 1.0,
    ...r,
  });
}
