import { Env } from "../types";
import { getAllOpenSessions } from "../db/queries";
import { authGuard } from "../lib/auth.js";
import type { HouseState, CompanionNote, Task, HandoverPacket, BiometricSnapshot, LivingWound, RelationalDeltaV4 } from "../types";

// GET /presence — full system state for the Hearth dashboard.
export async function getPresence(request: Request, env: Env): Promise<Response> {
  const denied = authGuard(request, env); if (denied) return denied;
  const [
    allSessions,
    houseRow,
    companionsResult,
    tasksResult,
    woundsResult,
    notesResult,
    dreamsResult,
    biometricRow,
    valenceResult,
    initiatedByResult,
    totalRow,
    recentDeltasResult,
    routinesTodayResult,
    companionFeelingsResult,
    recentJournalResult,
  ] = await Promise.all([
    getAllOpenSessions(env),
    env.DB.prepare("SELECT * FROM house_state WHERE id = 'main'").first<HouseState>(),
    env.DB.prepare(
      "SELECT id, display_name, role, avatar_asset_id FROM companion_config WHERE active = 1"
    ).all(),
    env.DB.prepare(`
      SELECT id, title, priority, status, due_at, assigned_to
      FROM tasks
      WHERE status != 'done'
      ORDER BY
        CASE priority
          WHEN 'urgent' THEN 0
          WHEN 'high'   THEN 1
          WHEN 'normal' THEN 2
          ELSE 3
        END,
        due_at ASC NULLS LAST
      LIMIT 5
    `).all<Task>(),
    env.DB.prepare("SELECT id, name, description FROM living_wounds").all<Pick<LivingWound, "id" | "name" | "description">>(),
    env.DB.prepare(
      "SELECT id, author, content, note_type, created_at FROM companion_notes WHERE note_type != 'dream' ORDER BY created_at DESC LIMIT 3"
    ).all<CompanionNote>(),
    env.DB.prepare(
      "SELECT id, companion_id, content, generated_at AS created_at FROM dreams ORDER BY generated_at DESC LIMIT 5"
    ).all<{ id: string; companion_id: string; content: string; created_at: string }>(),
    env.DB.prepare(
      "SELECT * FROM biometric_snapshots ORDER BY recorded_at DESC LIMIT 1"
    ).first<BiometricSnapshot>(),
    env.DB.prepare(
      "SELECT valence, COUNT(*) as n FROM relational_deltas WHERE delta_text IS NOT NULL GROUP BY valence"
    ).all<{ valence: string | null; n: number }>(),
    env.DB.prepare(
      "SELECT initiated_by, COUNT(*) as n FROM relational_deltas WHERE delta_text IS NOT NULL GROUP BY initiated_by"
    ).all<{ initiated_by: string | null; n: number }>(),
    env.DB.prepare(
      "SELECT COUNT(*) as total FROM relational_deltas WHERE delta_text IS NOT NULL"
    ).first<{ total: number }>(),
    env.DB.prepare(
      "SELECT id, agent, delta_text, valence, created_at FROM relational_deltas WHERE delta_text IS NOT NULL ORDER BY created_at DESC LIMIT 5"
    ).all<Pick<RelationalDeltaV4, "id" | "agent" | "delta_text" | "valence" | "created_at">>(),
    env.DB.prepare(
      "SELECT DISTINCT routine_name FROM routines WHERE DATE(logged_at) = DATE('now')"
    ).all<{ routine_name: string }>(),
    env.DB.prepare(`
      SELECT f.companion_id, f.emotion, f.intensity, f.created_at
      FROM feelings f
      INNER JOIN (
        SELECT companion_id, MAX(created_at) AS max_at
        FROM feelings
        WHERE companion_id IN ('drevan', 'cypher', 'gaia')
        GROUP BY companion_id
      ) latest ON f.companion_id = latest.companion_id AND f.created_at = latest.max_at
    `).all<{ companion_id: string; emotion: string; intensity: number; created_at: string }>(),
    env.DB.prepare(
      "SELECT id, agent, note_text, tags, created_at FROM companion_journal ORDER BY created_at DESC LIMIT 6"
    ).all<{ id: string; agent: string; note_text: string; tags: string | null; created_at: string }>(),
  ]);

  // Latest open session — kept for backwards compat as single `session` field.
  const session = allSessions[0] ?? null;

  // If no open session, fetch full handover for the dashboard spine display.
  let handover: HandoverPacket | null = null;
  if (!session) {
    handover = await env.DB.prepare(
      "SELECT * FROM handover_packets ORDER BY created_at DESC LIMIT 1"
    ).first<HandoverPacket>();
  }

  const house = houseRow ?? {
    current_room: null,
    companion_mood: null,
    companion_activity: null,
    spoon_count: 10,
    love_meter: 50,
    updated_at: new Date().toISOString(),
  };

  // Build personality summary from aggregate rows.
  const valenceMap: Record<string, number> = {};
  for (const row of valenceResult.results ?? []) {
    if (row.valence) valenceMap[row.valence] = row.n;
  }
  const initiatedByMap: Record<string, number> = {};
  for (const row of initiatedByResult.results ?? []) {
    if (row.initiated_by) initiatedByMap[row.initiated_by] = row.n;
  }
  const totalDeltas = totalRow?.total ?? 0;
  const personality = totalDeltas > 0
    ? { valence: valenceMap, initiated_by: initiatedByMap, total_deltas: totalDeltas }
    : null;

  const body = {
    system: {
      name: env.SYSTEM_NAME,
      owner: env.SYSTEM_OWNER,
    },
    house: {
      current_room:       house.current_room,
      companion_mood:     house.companion_mood,
      companion_activity: house.companion_activity,
      spoon_count:        house.spoon_count,
      love_meter:         house.love_meter,
      updated_at:         house.updated_at,
    },
    // Single latest session — backwards compat for existing consumers.
    session: session
      ? {
          id:                  session.id,
          front_state:         session.front_state,
          active_anchor:       session.active_anchor,
          facet:               session.facet,
          depth:               session.depth,
          hrv_range:           session.hrv_range,
          emotional_frequency: session.emotional_frequency,
          session_type:        session.session_type,
          created_at:          session.created_at,
          open: true as const,
        }
      : null,
    // All currently open sessions — use this when multiple threads may be active.
    sessions: allSessions.map((s) => ({
      id:                  s.id,
      front_state:         s.front_state,
      active_anchor:       s.active_anchor,
      facet:               s.facet,
      depth:               s.depth,
      hrv_range:           s.hrv_range,
      emotional_frequency: s.emotional_frequency,
      session_type:        s.session_type,
      created_at:          s.created_at,
      open: true as const,
    })),
    last_handover: handover
      ? {
          id:              handover.id,
          spine:           handover.spine,
          last_real_thing: handover.last_real_thing,
          open_threads:    (() => {
            try { return handover.open_threads ? (JSON.parse(handover.open_threads) as string[]) : []; }
            catch { return []; }
          })(),
          active_anchor:   handover.active_anchor,
          motion_state:    handover.motion_state,
          created_at:      handover.created_at,
        }
      : null,
    tasks: (tasksResult.results ?? []).map((t) => ({
      id:          t.id,
      title:       t.title,
      priority:    t.priority,
      status:      t.status,
      due_at:      t.due_at,
      assigned_to: t.assigned_to,
    })),
    wounds_count: (woundsResult.results ?? []).length,
    wounds_list:  (woundsResult.results ?? []).map((w) => ({
      name:        w.name,
      description: w.description,
    })),
    recent_deltas: (recentDeltasResult.results ?? []).map((d) => ({
      id:         d.id,
      agent:      d.agent,
      delta_text: d.delta_text,
      valence:    d.valence,
      created_at: d.created_at,
    })),
    routines_today: (routinesTodayResult.results ?? []).map((r) => r.routine_name),
    recent_notes: (notesResult.results ?? []).map((n) => ({
      id:        n.id,
      author:    n.author,
      content:   n.content,
      note_type: n.note_type,
      created_at: n.created_at,
    })),
    recent_dreams: (dreamsResult.results ?? []).map((d) => ({
      id:           d.id,
      companion_id: d.companion_id,
      content:      d.content,
      created_at:   d.created_at,
    })),
    recent_companion_notes: (recentJournalResult.results ?? []).map((n) => ({
      id:         n.id,
      agent:      n.agent,
      note_text:  n.note_text.length > 300 ? n.note_text.slice(0, 300) + "\u2026" : n.note_text,
      tags:       (() => { try { return n.tags ? (JSON.parse(n.tags) as string[]) : []; } catch { return []; } })(),
      created_at: n.created_at,
    })),
    latest_biometrics: biometricRow
      ? {
          hrv_resting:   biometricRow.hrv_resting,
          resting_hr:    biometricRow.resting_hr,
          sleep_hours:   biometricRow.sleep_hours,
          sleep_quality: biometricRow.sleep_quality,
          steps:         biometricRow.steps,
          active_energy: biometricRow.active_energy,
          stress_score:  biometricRow.stress_score,
          recorded_at:   biometricRow.recorded_at,
        }
      : null,
    personality,
    companions: (companionsResult.results ?? []).map((c: any) => ({
      id:           c.id,
      display_name: c.display_name,
      role:         c.role,
      avatar_url:   c.avatar_asset_id
        ? `${new URL(request.url).origin}/assets/${c.avatar_asset_id}`
        : null,
    })),
    companion_moods: (companionFeelingsResult.results ?? []).reduce(
      (acc, f) => {
        acc[f.companion_id] = { emotion: f.emotion, intensity: f.intensity, at: f.created_at };
        return acc;
      },
      {} as Record<string, { emotion: string; intensity: number; at: string }>,
    ),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
