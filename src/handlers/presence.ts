import { Env } from "../types";
import { getAllOpenSessions } from "../db/queries";
import type { HouseState, CompanionNote, Task, HandoverPacket, BiometricSnapshot, LivingWound, RelationalDeltaV4 } from "../types";

// GET /presence — full system state for the Hearth dashboard.
// No auth: returns summary data safe for a personal dashboard.
export async function getPresence(_request: Request, env: Env): Promise<Response> {
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
  ] = await Promise.all([
    getAllOpenSessions(env),
    env.DB.prepare("SELECT * FROM house_state WHERE id = 'main'").first<HouseState>(),
    env.DB.prepare(
      "SELECT id, display_name, role FROM companion_config WHERE active = 1"
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
      "SELECT id, content, created_at FROM companion_notes WHERE note_type = 'dream' ORDER BY created_at DESC LIMIT 3"
    ).all<Pick<CompanionNote, "id" | "content" | "created_at">>(),
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
      id:         d.id,
      content:    d.content,
      created_at: d.created_at,
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
    })),
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
