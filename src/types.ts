// ── Cloudflare Worker environment bindings ────────────────────────────────────
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;

  // Config flags — set in wrangler.toml [vars], not in code.
  PLURALITY_ENABLED: string;   // "true" | "false"
  COMPANIONS_ENABLED: string;  // "true" | "false"
}

// ── Domain types ─────────────────────────────────────────────────────────────

export interface Companion {
  id: string;
  name: string;
  created_at: string;
  config_json: string | null;
}

export interface Session {
  id: string;
  companion_id: string;
  started_at: string;
  ended_at: string | null;
  metadata_json: string | null;
}

export interface MemoryEntry {
  id: string;
  companion_id: string;
  session_id: string | null;
  tier: number;
  content: string;
  tags_json: string | null;
  created_at: string;
}

// relational_deltas is append-only by covenant.
// If you are reading this and considering an UPDATE or DELETE — don't.
export interface RelationalDelta {
  id: string;
  companion_id: string;
  subject_id: string;        // the entity the delta is about
  delta_type: string;        // e.g. "affinity_change", "trust_shift", "note"
  payload_json: string;      // structured diff or event data
  created_at: string;
}

// ── Utility ───────────────────────────────────────────────────────────────────

export type ConfigFlags = {
  pluralityEnabled: boolean;
  companionsEnabled: boolean;
};

export function resolveFlags(env: Env): ConfigFlags {
  return {
    pluralityEnabled:  env.PLURALITY_ENABLED  === "true",
    companionsEnabled: env.COMPANIONS_ENABLED === "true",
  };
}
