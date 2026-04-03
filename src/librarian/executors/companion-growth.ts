import { ExecutorContext, ExecutorResult, parseContext } from "./types.js";
import { queryTensions, queryLatestBasinHistory, queryPressureFlags } from "../backends/halseth.js";

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

  const [notes, feelings, dreams] = await Promise.all([
    ctx.env.DB.prepare(
      "SELECT id, note_text, tags, created_at FROM companion_journal WHERE agent = ? AND source = 'autonomous' ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all<{ id: string; note_text: string; tags: string | null; created_at: string }>(),
    ctx.env.DB.prepare(
      "SELECT id, emotion, sub_emotion, intensity, created_at FROM feelings WHERE companion_id = ? AND source = 'autonomous' ORDER BY created_at DESC LIMIT 20"
    ).bind(id).all<{ id: string; emotion: string; sub_emotion: string | null; intensity: number; created_at: string }>(),
    ctx.env.DB.prepare(
      "SELECT id, dream_text, examined, created_at FROM companion_dreams WHERE companion_id = ? AND source = 'autonomous' ORDER BY created_at DESC LIMIT 10"
    ).bind(id).all<{ id: string; dream_text: string; examined: number; created_at: string }>(),
  ]);

  return {
    response_key: "summary",
    autonomous_notes: notes.results ?? [],
    autonomous_feelings: feelings.results ?? [],
    autonomous_dreams: dreams.results ?? [],
    meta: {
      operation: "autonomous_recall",
      companion_id: id,
      counts: {
        notes: (notes.results ?? []).length,
        feelings: (feelings.results ?? []).length,
        dreams: (dreams.results ?? []).length,
      },
    },
  };
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
        SELECT companion_id, state_text, state_type, toward, created_at,
               ROW_NUMBER() OVER (PARTITION BY companion_id ORDER BY created_at DESC) AS rn
        FROM companion_relational_state
        WHERE LOWER(toward) = 'raziel'
      )
      SELECT companion_id, state_text, state_type, toward, created_at FROM ranked WHERE rn = 1`
    ).all<{ companion_id: string; state_text: string; state_type: string; toward: string; created_at: string }>(),
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
        created_at: rel.created_at,
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
