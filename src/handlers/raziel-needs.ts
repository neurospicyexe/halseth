import { Env } from "../types.js";
import { authGuard } from "../lib/auth.js";
import { RATIFIABLE_PENDING_SQL } from "../lib/ratifiable.js";

// "Needs you": one read-only list of everything waiting on Raziel, across four tables.
// Resolving happens through each table's existing route; this handler only reads.

const jsonRes = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

export type NeedsKind = "question" | "growth" | "guardian" | "basin";

export interface NeedsItem {
  key: string; // `${kind}:${id}`
  kind: NeedsKind;
  id: string;
  companion_id: string | null;
  created_at: string; // basin: recorded_at
  title: string | null;
  detail: string | null;
  severity?: "notice" | "warning" | "red"; // guardian only
  drift_score?: number; // basin only
}

export interface NeedsCounts {
  total: number;
  question: number;
  growth: number;
  guardian: number;
  basin: number;
}

// Predicates are static strings. growth's comes from ratifiable.ts (one definition of "awaiting review").
const WHERE = {
  question: "status = 'open'",
  growth: RATIFIABLE_PENDING_SQL,
  guardian: "status IN ('open','surfaced')",
  basin: "drift_type = 'pressure' AND caleth_confirmed = 0 AND dismissed_at IS NULL",
} as const;

const SELECT = {
  question:
    "SELECT id, companion_id, created_at, question AS title, context AS detail FROM companion_questions",
  growth:
    "SELECT id, companion_id, created_at, content AS title, entry_type AS detail FROM growth_journal",
  guardian:
    "SELECT id, companion_id, created_at, summary AS title, flag_type AS detail, severity FROM guardian_flags",
  basin:
    "SELECT id, companion_id, recorded_at AS created_at, worst_basin AS title, notes AS detail, drift_score FROM companion_basin_history",
} as const;

const ORDER_COL: Record<NeedsKind, string> = {
  question: "created_at",
  growth: "created_at",
  guardian: "created_at",
  basin: "recorded_at",
};

const TABLE: Record<NeedsKind, string> = {
  question: "companion_questions",
  growth: "growth_journal",
  guardian: "guardian_flags",
  basin: "companion_basin_history",
};

const KINDS: NeedsKind[] = ["question", "growth", "guardian", "basin"];

function toItem(kind: NeedsKind, row: any): NeedsItem {
  const item: NeedsItem = {
    key: `${kind}:${row.id}`,
    kind,
    id: row.id,
    companion_id: row.companion_id ?? null,
    created_at: row.created_at,
    title: row.title ?? null,
    detail: row.detail ?? null,
  };
  if (kind === "guardian") item.severity = row.severity;
  if (kind === "basin") item.drift_score = Number(row.drift_score);
  return item;
}

async function readCounts(env: Env): Promise<NeedsCounts> {
  const rows = await Promise.all(
    KINDS.map((k) =>
      env.DB.prepare(`SELECT COUNT(*) AS n FROM ${TABLE[k]} WHERE ${WHERE[k]}`).first<{ n: number }>(),
    ),
  );
  const [question = 0, growth = 0, guardian = 0, basin = 0] = rows.map((r) => r?.n ?? 0);
  return { total: question + growth + guardian + basin, question, growth, guardian, basin };
}

export async function getRazielNeeds(
  request: Request,
  env: Env,
  _params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const raw = parseInt(new URL(request.url).searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(1, isNaN(raw) ? 50 : raw), 100);

  const [counts, ...lists] = await Promise.all([
    readCounts(env),
    ...KINDS.map((k) =>
      env.DB.prepare(
        `${SELECT[k]} WHERE ${WHERE[k]} ORDER BY ${ORDER_COL[k]} DESC, id DESC LIMIT ?`,
      ).bind(limit).all(),
    ),
  ]);

  const items = lists
    .flatMap((res, i) => (res.results ?? []).map((row: any) => toItem(KINDS[i] as NeedsKind, row)))
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : a.key < b.key ? 1 : -1))
    .slice(0, limit);

  return jsonRes({ items, counts });
}

export async function getRazielNeedsCount(
  request: Request,
  env: Env,
  _params: Record<string, string> = {},
): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  return jsonRes(await readCounts(env));
}
