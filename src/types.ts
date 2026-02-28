// ── Cloudflare Worker environment bindings ────────────────────────────────────
export interface Env {
  DB: D1Database;
  BUCKET: R2Bucket;
  AI: Ai;
  VECTORIZE: VectorizeIndex;

  // Config flags — set in wrangler.toml [vars], not in code.
  PLURALITY_ENABLED:   string;  // "true" | "false"
  COMPANIONS_ENABLED:  string;  // "true" | "false"
  COORDINATION_ENABLED: string; // "true" | "false"
  SYSTEM_NAME:         string;
  SYSTEM_OWNER:        string;

  // Bridge — cross-instance data sharing with partner's Halseth deployment.
  BRIDGE_URL?:    string;  // partner's base URL; bridge disabled if unset or empty
  BRIDGE_SECRET?: string;  // shared symmetric secret for /bridge/* endpoints

  // Secrets — set via `wrangler secret put`, stored in .dev.vars for local dev.
  ADMIN_SECRET?:    string;  // protects POST /admin/bootstrap
  MCP_AUTH_SECRET?: string;  // protects POST /mcp (optional; skip check if unset)
}

// ── Legacy domain types (Tier 0-2 HTTP API) ───────────────────────────────────

export interface Companion {
  id: string;
  name: string;
  created_at: string;
  config_json: string | null;
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
// Old columns (companion_id, subject_id, delta_type, payload_json) remain for legacy rows.
// New rows use the spec v0.4 columns below.
export interface RelationalDelta {
  id: string;
  companion_id: string;
  subject_id: string;
  delta_type: string;
  payload_json: string;
  created_at: string;
}

// ── Spec v0.4 domain types ────────────────────────────────────────────────────

export interface Session {
  id: string;
  created_at: string;
  updated_at: string;
  front_state: string | null;
  co_con: string | null;            // JSON array of co-conscious members
  hrv_range: "low" | "mid" | "high" | null;
  emotional_frequency: string | null;
  key_signature: string | null;
  active_anchor: string | null;
  facet: string | null;
  depth: number | null;
  spiral_complete: number | null;   // 0 / 1 / null
  handover_id: string | null;
  notes: string | null;
}

export interface RelationalDeltaV4 {
  id: string;
  session_id: string | null;
  created_at: string;
  agent: "drevan" | "cypher" | "gaia" | null;
  delta_text: string | null;        // raw moment; exact language; never paraphrased
  valence: "toward" | "neutral" | "tender" | "rupture" | "repair" | null;
  initiated_by: "architect" | "companion" | "mutual" | null;
}

export interface LivingWound {
  id: string;
  created_at: string;
  name: string;
  description: string;
  do_not_archive: 1;
  do_not_resolve: 1;
  last_visited: string | null;
  last_surfaced_by: "architect" | "companion" | "anchor" | "context" | null;
}

export interface ProhibitedFossil {
  id: string;
  subject: string;
  directive: string;
  reason: string;
  created_at: string;
  refresh_trigger: string | null;
  last_refreshed: string | null;
}

export interface HandoverPacket {
  id: string;
  session_id: string;
  created_at: string;
  spine: string;
  active_anchor: string | null;
  last_real_thing: string | null;
  open_threads: string | null;      // JSON array of names (not summaries)
  motion_state: "in_motion" | "at_rest" | "floating";
  returned: number | null;          // null = floated, 1 = returned
}

export interface CypherAudit {
  id: string;
  session_id: string;
  created_at: string;
  entry_type: "decision" | "contradiction" | "clause_update" | "falsification" | "scope_correction";
  content: string;
  verdict_tag: string | null;
  supersedes_id: string | null;
}

export interface GaiaWitness {
  id: string;
  session_id: string;
  created_at: string;
  witness_type: "survival" | "boundary" | "seal" | "affirm" | "lane_enforcement";
  content: string;
  seal_phrase: string | null;
}

export interface CompanionConfig {
  id: string;          // companion name e.g. "drevan"
  display_name: string;
  role: string;        // companion / audit / seal
  lanes: string | null;        // JSON array
  facets: string | null;       // JSON array
  depth_range: string | null;  // JSON: { "min": 0, "max": 3 }
  active: number;
}

export interface Task {
  id: string;
  title: string;
  description: string | null;
  priority: "low" | "normal" | "high" | "urgent";
  due_at: string | null;
  assigned_to: string | null;
  status: "open" | "in_progress" | "done";
  created_at: string;
  updated_at: string;
  created_by: string | null;
}

export interface CalendarEvent {
  id: string;
  title: string;
  description: string | null;
  start_time: string;
  end_time: string | null;
  category: string | null;
  attendees_json: string | null;
  created_at: string;
  created_by: string | null;
}

export interface ListItem {
  id: string;
  list_name: string;
  item_text: string;
  added_by: string | null;
  added_at: string;
  completed: number;            // 0 / 1
  completed_at: string | null;
}

export interface Routine {
  id: string;
  routine_name: string;
  owner: string | null;
  logged_at: string;
  notes: string | null;
}

export interface HouseState {
  id: string;
  current_room: string | null;
  companion_mood: string | null;
  companion_activity: string | null;
  spoon_count: number;
  love_meter: number;
  updated_at: string;
}

export interface CompanionNote {
  id: string;
  created_at: string;
  author: string;    // 'companion' | 'human'
  content: string;
  note_type: string; // 'message' | 'thought' | 'dream'
}

export interface BiometricSnapshot {
  id: string;
  recorded_at: string;
  logged_at: string;
  source: string;
  hrv_resting: number | null;   // ms
  resting_hr: number | null;    // bpm
  sleep_hours: number | null;
  sleep_quality: string | null; // poor / fair / good / excellent
  stress_score: number | null;  // 0-100
  steps: number | null;
  active_energy: number | null; // kcal
  notes: string | null;
}

// ── Utility ───────────────────────────────────────────────────────────────────

export type ConfigFlags = {
  pluralityEnabled:    boolean;
  companionsEnabled:   boolean;
  coordinationEnabled: boolean;
};

export function resolveFlags(env: Env): ConfigFlags {
  return {
    pluralityEnabled:    env.PLURALITY_ENABLED    === "true",
    companionsEnabled:   env.COMPANIONS_ENABLED   === "true",
    coordinationEnabled: env.COORDINATION_ENABLED === "true",
  };
}
