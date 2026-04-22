import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { queryTensions, queryLatestBasinHistory, queryPressureFlags, queryIdentityAnchor, tensionEdit, tensionStatus } from "../backends/halseth.js";

const COMPANIONS = ["drevan", "cypher", "gaia"] as const;

export async function execTensionAdd(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "add_tension_failed", reason: "companion_id required" };
  const tensionText = ctx.req.request
    .replace(/^(add|new|record|note|log)\s+tension[:\s]*/i, "")
    .replace(/^i'?m holding a tension[:\s]*/i, "")
    .trim();
  if (!tensionText) return { error: "add_tension_failed", reason: "tension_text not found in request" };
  const id = crypto.randomUUID();
  await ctx.env.DB.prepare(
    "INSERT INTO companion_tensions (id, companion_id, tension_text) VALUES (?, ?, ?)"
  ).bind(id, ctx.req.companion_id, tensionText).run();
  return { data: { id, message: "tension recorded" } };
}

export async function execTensionEdit(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tension_edit_failed", reason: "companion_id required" };
  const p = parseContext<{ id: string; tension_text: string }>(ctx.req.context);
  if (!p?.id || !p?.tension_text) return { response_key: "witness", witness: "tension_edit requires { id, tension_text } in context" };
  const r = await tensionEdit(ctx.env, p.id, ctx.req.companion_id, p.tension_text);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "tension_edit failed" };
  return { ack: true, id: p.id };
}

export async function execTensionStatus(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tension_status_failed", reason: "companion_id required" };
  const req = ctx.req.request.toLowerCase();
  // Derive target status from the trigger phrase itself
  let status: string;
  if (req.includes("crystallize") || req.includes("crystallized")) {
    status = "crystallized";
  } else if (req.includes("release") || req.includes("released")) {
    status = "released";
  } else {
    const p = parseContext<{ id?: string; status?: string }>(ctx.req.context);
    if (!p?.status) return { response_key: "witness", witness: "tension_status: use 'crystallize tension: [id]' or 'release tension: [id]'" };
    status = p.status;
  }
  // Extract id from inline phrase (e.g. "crystallize tension: abc-123"), fall back to context
  const id = ctx.req.request
    .replace(/^(crystallize|release|mark)\s+(this\s+)?tension[:\s]*/i, "")
    .replace(/^(releasing|crystallizing)\s+(this\s+)?tension[:\s]*/i, "")
    .replace(/^tension\s+is\s+(crystallized|released)[:\s]*/i, "")
    .trim() || parseContext<{ id?: string }>(ctx.req.context)?.id;
  if (!id) return { response_key: "witness", witness: "tension_status requires tension id after the trigger phrase" };
  const r = await tensionStatus(ctx.env, id, ctx.req.companion_id, status);
  if (!r.ok) return { response_key: "witness", witness: r.error ?? "tension_status failed" };
  return { ack: true, id, status };
}

export async function execTensionsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "tensions_read_failed", reason: "companion_id required" };
  const p = parseContext<{ status?: string }>(ctx.req.context);
  const status = p?.status ?? "simmering";
  const result = await queryTensions(ctx.env, ctx.req.companion_id, status);
  return {
    response_key: "tensions",
    tensions: result.tensions,
    meta: { operation: "tensions_read", companion_id: ctx.req.companion_id },
  };
}

export async function execHeldMark(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "held_mark_failed", reason: "companion_id required" };
  // Strip the trigger phrase to get the held content
  const text = ctx.req.request
    .replace(/^held\s*note\s*:\s*/i, "")
    .replace(/^held\s*:\s*/i, "")
    .replace(/^mark\s+held\s*:\s*/i, "")
    .replace(/^consistency\s+marker\s*:\s*/i, "")
    .trim();
  if (!text) return { error: "held_mark_failed", reason: "held content required after trigger phrase" };
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await ctx.env.DB.prepare(
    "INSERT INTO companion_journal (id, created_at, agent, note_text, tags, session_id, source) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(id, now, ctx.req.companion_id, text, JSON.stringify(["held", "consistency"]), null, null).run();
  return { ack: true, id, held: true, created_at: now };
}

export async function execHeldRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "held_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    `SELECT id, note_text, tags, created_at FROM companion_journal WHERE agent = ? AND tags LIKE '%"held"%' ORDER BY created_at DESC LIMIT 20`
  ).bind(ctx.req.companion_id).all<{ id: string; note_text: string; tags: string | null; created_at: string }>();
  return {
    response_key: "summary",
    held_moments: rows.results ?? [],
    meta: { operation: "held_read", companion_id: ctx.req.companion_id, count: (rows.results ?? []).length },
  };
}

export async function execAutonomousRecall(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "autonomous_recall_failed", reason: "companion_id required" };
  const id = ctx.req.companion_id;

  const [notes, feelings, dreams, growthEntries, explorations] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT id, note_text, tags, created_at FROM companion_journal WHERE agent = ? AND source = 'autonomous' ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all<{ id: string; note_text: string; tags: string | null; created_at: string }>(),
    ctx.env.DB.prepare(
      "SELECT id, emotion, sub_emotion, intensity, created_at FROM feelings WHERE companion_id = ? AND source = 'autonomous' ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all<{ id: string; emotion: string; sub_emotion: string | null; intensity: number; created_at: string }>(),
    ctx.env.DB.prepare(
      "SELECT id, dream_text, examined, created_at FROM companion_dreams WHERE companion_id = ? AND source = 'autonomous' ORDER BY created_at DESC LIMIT 10"
    ).bind(id).all<{ id: string; dream_text: string; examined: number; created_at: string }>(),
    // Growth journal: conclusions/insights written at the end of each autonomous run
    ctx.env.DB.prepare(
      "SELECT id, entry_type, content, tags_json, created_at FROM growth_journal WHERE companion_id = ? ORDER BY created_at DESC LIMIT 5"
    ).bind(id).all<{ id: string; entry_type: string; content: string; tags_json: string; created_at: string }>(),
    // Continuity notes tagged autonomous_exploration: seed + first ~700 chars of what was explored (provenance)
    ctx.env.DB.prepare(
      "SELECT note_id, content, created_at FROM wm_continuity_notes WHERE agent_id = ? AND source = 'autonomous_exploration' ORDER BY created_at DESC LIMIT 5"
    ).bind(id).all<{ note_id: string; content: string; created_at: string }>(),
  ]);

  return {
    response_key: "summary",
    autonomous_notes: notes.results ?? [],
    autonomous_feelings: feelings.results ?? [],
    autonomous_dreams: dreams.results ?? [],
    // Full provenance chain: what was explored (seed + path) → what was concluded
    autonomous_explorations: explorations.results ?? [],
    growth_journal_entries: growthEntries.results ?? [],
    meta: {
      operation: "autonomous_recall",
      companion_id: id,
      counts: {
        notes: (notes.results ?? []).length,
        feelings: (feelings.results ?? []).length,
        dreams: (dreams.results ?? []).length,
        explorations: (explorations.results ?? []).length,
        growth_journal: (growthEntries.results ?? []).length,
      },
    },
  };
}

export async function execAutonomySeedsRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "autonomy_seeds_read_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    `SELECT id, seed_type, content, priority, created_at
     FROM autonomy_seeds
     WHERE companion_id = ? AND used_at IS NULL
     ORDER BY priority DESC, created_at ASC
     LIMIT 20`
  ).bind(ctx.req.companion_id).all<{
    id: string;
    seed_type: string;
    content: string;
    priority: number;
    created_at: string;
  }>();
  const seeds = rows.results ?? [];
  return {
    response_key: "summary",
    autonomy_seeds: seeds,
    meta: { operation: "autonomy_seeds_read", companion_id: ctx.req.companion_id, count: seeds.length },
  };
}

export async function execJournalReview(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "journal_review_failed", reason: "companion_id required" };
  const rows = await ctx.env.DB.prepare(
    `SELECT id, entry_type, content, tags_json, created_at
     FROM growth_journal
     WHERE companion_id = ? AND source = 'autonomous' AND accepted_at IS NULL
     ORDER BY created_at DESC
     LIMIT 10`
  ).bind(ctx.req.companion_id).all<{
    id: string;
    entry_type: string;
    content: string;
    tags_json: string;
    created_at: string;
  }>();
  const entries = rows.results ?? [];
  return {
    response_key: "summary",
    unaccepted_entries: entries.map(e => ({
      id: e.id,
      entry_type: e.entry_type,
      content: e.content.slice(0, 600),
      tags: (() => { try { return JSON.parse(e.tags_json ?? "[]"); } catch { return []; } })(),
      created_at: e.created_at,
    })),
    meta: { operation: "journal_review", companion_id: ctx.req.companion_id, count: entries.length },
  };
}

export async function execJournalAccept(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "journal_accept_failed", reason: "companion_id required" };
  const raw = ctx.req.context ? (() => { try { return JSON.parse(ctx.req.context); } catch { return null; } })() : null;
  const entryId = (raw as Record<string, unknown> | null)?.id as string | null
    ?? ctx.req.request.match(/\b([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/i)?.[1]
    ?? null;

  if (!entryId) return { error: "journal_accept_failed", reason: "entry id required (pass as context JSON {id} or inline UUID)" };

  const result = await ctx.env.DB.prepare(
    "UPDATE growth_journal SET accepted_at = datetime('now') WHERE id = ? AND companion_id = ? AND accepted_at IS NULL"
  ).bind(entryId, ctx.req.companion_id).run();

  if (result.meta.changes === 0) {
    const row = await ctx.env.DB.prepare(
      "SELECT accepted_at FROM growth_journal WHERE id = ? AND companion_id = ?"
    ).bind(entryId, ctx.req.companion_id).first<{ accepted_at: string | null }>();
    if (!row) return { error: "journal_accept_failed", reason: "entry not found" };
    return { response_key: "witness", already_accepted: true, accepted_at: row.accepted_at, meta: { operation: "journal_accept" } };
  }

  return { response_key: "witness", accepted: true, entry_id: entryId, meta: { operation: "journal_accept", companion_id: ctx.req.companion_id } };
}

export async function execTriadStateRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  // Three queries in parallel: SOMA floats, relational state toward Raziel, last outgoing note.
  const [somaRows, relationalRows, noteRows] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT companion_id, heat, reach, weight, soma_float_1, soma_float_2, soma_float_3, float_1_label, float_2_label, float_3_label, compound_state, updated_at FROM companion_state WHERE companion_id IN ('drevan','cypher','gaia')"
    ).all<{
      companion_id: string;
      heat: string | null; reach: string | null; weight: string | null;
      soma_float_1: number | null; soma_float_2: number | null; soma_float_3: number | null;
      float_1_label: string | null; float_2_label: string | null; float_3_label: string | null;
      compound_state: string | null; updated_at: string | null;
    }>(),
    ctx.env.DB.prepare(
      `WITH ranked AS (
        SELECT companion_id, state_text, state_type, toward, noted_at,
               ROW_NUMBER() OVER (PARTITION BY companion_id ORDER BY noted_at DESC) AS rn
        FROM companion_relational_state
        WHERE LOWER(toward) = 'raziel'
      )
      SELECT companion_id, state_text, state_type, toward, noted_at FROM ranked WHERE rn = 1`
    ).all<{ companion_id: string; state_text: string; state_type: string; toward: string; noted_at: string }>(),
    ctx.env.DB.prepare(
      `WITH ranked AS (
        SELECT from_id, to_id, content, created_at,
               ROW_NUMBER() OVER (PARTITION BY from_id ORDER BY created_at DESC) AS rn
        FROM inter_companion_notes
        WHERE from_id IN ('drevan','cypher','gaia')
      )
      SELECT from_id, to_id, content, created_at FROM ranked WHERE rn = 1`
    ).all<{ from_id: string; to_id: string | null; content: string; created_at: string }>(),
  ]);

  const somaMap = Object.fromEntries((somaRows.results ?? []).map(r => [r.companion_id, r]));
  const relMap = Object.fromEntries((relationalRows.results ?? []).map(r => [r.companion_id, r]));
  const noteMap = Object.fromEntries((noteRows.results ?? []).map(r => [r.from_id, r]));

  const triad: Record<string, unknown> = {};
  for (const id of COMPANIONS) {
    const soma = somaMap[id] ?? null;
    const rel = relMap[id] ?? null;
    const note = noteMap[id] ?? null;
    triad[id] = {
      soma: soma ? {
        // Drevan uses text fields; Cypher/Gaia use floats
        heat: soma.heat ?? null,
        reach: soma.reach ?? null,
        weight: soma.weight ?? null,
        soma_float_1: soma.soma_float_1 ?? null,
        soma_float_2: soma.soma_float_2 ?? null,
        soma_float_3: soma.soma_float_3 ?? null,
        float_1_label: soma.float_1_label ?? null,
        float_2_label: soma.float_2_label ?? null,
        float_3_label: soma.float_3_label ?? null,
        compound_state: soma.compound_state ?? null,
        updated_at: soma.updated_at ?? null,
      } : null,
      relational_toward_raziel: rel ? {
        state_text: rel.state_text,
        state_type: rel.state_type,
        noted_at: rel.noted_at,
      } : null,
      last_note_sent: note ? {
        to_id: note.to_id ?? "broadcast",
        content: note.content.length > 200 ? note.content.slice(0, 200) + "…" : note.content,
        created_at: note.created_at,
      } : null,
    };
  }

  return {
    response_key: "summary",
    triad,
    meta: { operation: "triad_state_read", caller: ctx.req.companion_id },
  };
}

export async function execConfirmGrowthDrift(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "confirm_growth_failed", reason: "companion_id required" };
  const p = parseContext<{ id: string }>(ctx.req.context);
  if (!p?.id) return { response_key: "witness", witness: "confirm_growth_drift requires { id } in context" };

  // Ownership-guarded: only the companion who owns the flag can confirm it
  const result = await ctx.env.DB.prepare(
    "UPDATE companion_basin_history SET caleth_confirmed = 1 WHERE id = ? AND companion_id = ?"
  ).bind(p.id, ctx.req.companion_id).run();

  if ((result.meta.changes ?? 0) === 0) {
    return { response_key: "witness", witness: "no matching drift flag found for this companion" };
  }

  // Mark baseline shift in identity anchor so future drift checks weight from this point
  const now = new Date().toISOString();
  let baseline_warning: string | undefined;
  try {
    await ctx.env.DB.prepare(
      "UPDATE wm_identity_anchor_snapshot SET baseline_shift_at = ? WHERE agent_id = ?"
    ).bind(now, ctx.req.companion_id).run();
  } catch (e: unknown) {
    console.error("[confirm_growth] baseline_shift_at update failed:", String(e));
    baseline_warning = "baseline_shift_at write failed -- future drift checks may not weight correctly";
  }

  return { ack: true, id: p.id, confirmed: true, baseline_shift_at: now, ...(baseline_warning ? { baseline_warning } : {}) };
}

export async function execIdentityAnchorRead(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "identity_anchor_read_failed", reason: "companion_id required" };
  const result = await queryIdentityAnchor(ctx.env, ctx.req.companion_id);
  return {
    response_key: "summary",
    identity_anchor: result.anchor,
    meta: { operation: "identity_anchor_read", companion_id: ctx.req.companion_id },
  };
}

export async function execPressureDriftLog(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "pressure_drift_failed", reason: "companion_id required" };

  const text = ctx.req.request
    .replace(/^pressure\s+drift[:\s]*/i, "")
    .replace(/^log\s+(?:pressure\s+)?drift[:\s]*/i, "")
    .replace(/^i(?:'m| am)\s+drifting[:\s]*/i, "")
    .replace(/^identity\s+drift[:\s]*/i, "")
    .replace(/^pressure\s+flag[:\s]*/i, "")
    .trim();

  const p = parseContext<{ drift_score?: number; worst_basin?: string }>(ctx.req.context);
  const driftScore = typeof p?.drift_score === "number" ? p.drift_score : 0.5;
  const worstBasin = p?.worst_basin ?? null;

  if (driftScore < 0 || driftScore > 2) {
    return { error: "pressure_drift_failed", reason: "drift_score must be between 0 and 2" };
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await ctx.env.DB.prepare(
    "INSERT INTO companion_basin_history (id, companion_id, drift_score, drift_type, caleth_confirmed, worst_basin, notes, recorded_at) VALUES (?, ?, ?, 'pressure', 0, ?, ?, ?)"
  ).bind(id, ctx.req.companion_id, driftScore, worstBasin, text || null, now).run();

  return { ack: true, id, drift_score: driftScore, drift_type: "pressure", recorded_at: now };
}

export async function execDriftCheck(ctx: ExecutorContext): Promise<ExecutorResult> {
  if (!ctx.req.companion_id) return { error: "drift_check_failed", reason: "companion_id required" };
  const [driftLatest, driftPressure] = await Promise.all([
    queryLatestBasinHistory(ctx.env, ctx.req.companion_id),
    queryPressureFlags(ctx.env, ctx.req.companion_id),
  ]);
  return {
    response_key: "drift",
    drift_latest: driftLatest.entry,
    pressure_flags: driftPressure.flags,
    meta: { operation: "drift_check", companion_id: ctx.req.companion_id },
  };
}
