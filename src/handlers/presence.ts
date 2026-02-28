import { Env } from "../types";
import { getOpenSession } from "../db/queries";
import type { HouseState, CompanionNote, Task, HandoverPacket } from "../types";

// GET /presence — full system state for the Hearth dashboard.
// No auth: returns summary data safe for a personal dashboard.
export async function getPresence(_request: Request, env: Env): Promise<Response> {
  const [session, houseRow, companionsResult, tasksResult, woundsRow, notesResult] =
    await Promise.all([
      getOpenSession(env),
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
      env.DB.prepare("SELECT COUNT(*) as n FROM living_wounds").first<{ n: number }>(),
      env.DB.prepare(
        "SELECT id, author, content, note_type, created_at FROM companion_notes ORDER BY created_at DESC LIMIT 3"
      ).all<CompanionNote>(),
    ]);

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
    session: session
      ? {
          id:                  session.id,
          front_state:         session.front_state,
          active_anchor:       session.active_anchor,
          facet:               session.facet,
          depth:               session.depth,
          hrv_range:           session.hrv_range,
          emotional_frequency: session.emotional_frequency,
          created_at:          session.created_at,
          open: true as const,
        }
      : null,
    last_handover: handover
      ? {
          id:              handover.id,
          spine:           handover.spine,
          last_real_thing: handover.last_real_thing,
          open_threads:    handover.open_threads
            ? (JSON.parse(handover.open_threads) as string[])
            : [],
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
    wounds_count: woundsRow?.n ?? 0,
    recent_notes: (notesResult.results ?? []).map((n) => ({
      id:        n.id,
      author:    n.author,
      content:   n.content,
      note_type: n.note_type,
      created_at: n.created_at,
    })),
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
