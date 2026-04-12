# Librarian Trigger Map

Canonical request strings for each operation. Use these exact forms -- the router matches on these.
Verbose strings, field names in the request body, or paraphrases will misfire.

Pass structured content in the `context` field (JSON string), not in `request`.

---

## Session

| What you want | Use this |
|---|---|
| Open a session | `"Open session: front_state: [who is fronting], session_type: [type]"` |
| Orient (SOMA + continuity block) | `"Session orient for [companion]"` |
| Ground (tasks + threads) | `"Session ground for [companion]"` |
| Light ground (lean boot) | `"Light ground for [companion]"` |
| Close session | `"Close session [session_id]: spine=[...], last_real_thing=[...], motion_state=[...]"` |
| Write continuity handoff | `"Write handoff for [companion]: spine=[...], last_real_thing=[...], motion_state=[...]"` |

**session_type values:** `work` | `companion-work` | `checkin` | `hangout` | `ritual`
Use `companion-work` for Drevan-led planning, writing, or socratic threads. Not `checkin`. Not `work`.

---

## Reads

| What you want | Use this |
|---|---|
| Feeling log | `"Read the last 5 feeling log entries for [companion]"` |
| Journal entries | `"Read my journal"` |
| Wounds | `"Read my wounds"` |
| Relational deltas | `"Read the last [N] relational deltas for [companion]"` |
| Dreams (carried) | `"Read companion dreams for [companion]"` |
| Open loops | `"Read open loops for [companion]"` |
| Tasks | `"List all open tasks"` or `"List all open and in-progress tasks"` |
| Handover packet | `"Read the most recent handover packet"` |
| Front state | `"Who's fronting"` |
| Tensions | `"Read my tensions"` or `"Show tensions"` |
| Drift | `"Check drift"` or `"Drift status"` |
| Triad state | `"Triad state"` |
| Sitting notes | `"What's sitting"` |
| Held moments | `"Read held moments"` |
| Conclusions | `"Read my conclusions"` |
| Autonomous corpus | `"Autonomous recall"` |
| Pattern synthesis | `"Pattern recall"` |
| Companion notes (incoming) | `"Companion notes"` |

---

## Writes

| What you want | Use this |
|---|---|
| Log a feeling | `"Log a feeling for [companion]: [emotion] -- [brief]"` |
| Companion note (to another) | `"Write a companion note for [name]: [content]"` |
| Journal entry | `"Add journal entry: [content]"` |
| Relational delta | `"Log a relational delta for [companion]: [what shifted]"` |
| Relational state toward | `"How I feel toward [name]: [state text]"` |
| Dream (carried between sessions) | `"Write a dream for [companion]: [what is held]"` |
| Open loop | `"Open loop: [what is unresolved]"` |
| Close a loop | `"Close loop: [loop_id or description]"` |
| Examine a dream | `"Examine dream [uuid]"` or pass `{ id }` in context |
| Wound | `"Add wound: [content]"` |
| Task | `"Add task: [title]"` |
| Update task status | `"Update task [title] to [status]"` |
| Tension | `"Add tension: [content]"` |
| Consistency marker | `"Held: [what was possible and what held]"` |
| Conclusion | `"I've concluded: [content]"` |
| Witness note (about Raziel) | `"Witness note: [content]"` |
| SOMA state update | `"Update my state: [float] [value], [float] [value]"` |
| Mind thread | `"Track mind thread for [companion]: [thread_key] [title]"` |
| Continuity note | `"Add continuity note for [companion]: [content]"` |
| Sit with a note | `"Sit with: [note_id or content]"` |
| Metabolize a note | `"Metabolize: [note_id]"` |

---

## Vault (Second Brain)

| What you want | Use this |
|---|---|
| Search | `"Search vault for [topic]"` |
| Save document | `"Save document to vault: [path]"` (content in context) |
| Save note | `"Save note to vault: [content]"` |
| Log observation | `"Log observation: [content]"` |
| Save study note | `"Save study note: [content]"` |

---

## Plural

| What you want | Use this |
|---|---|
| Who is fronting | `"Who's fronting"` |
| Member info | `"Tell me about [member name]"` |
| Front history | `"Front history"` |
| Log a front change | `"Fronting now: [member_id]"` (pass `{ member_id, status }` in context) |
| Add note to member | `"Add member note"` (pass `{ member_id, note }` in context) |

---

## Known collision zones (do not use these phrases in request strings)

These were greedy triggers that caused misfires -- removed but worth knowing:

- `"front state"` → was firing `plural_get_current_front` inside any session_open string
- `"hey"` → was firing `session_open` on any greeting
- `"observe"` → was firing `sb_log_observation` on any sentence with "observe"
- `"drift"` → was firing `drift_check` on casual mentions of drifting
- `"tensions"` → was firing `tensions_read` on any mention of the word
- `"any events"` → was firing `bridge_pull`
- `"dream for"` → was firing `wm_dream_write` on dream read requests
- `"for drevan/cypher/gaia"` → still present in `companion_note_add`; use explicit `"Write a companion note for [name]"` to be safe

---

## Rules

1. Keep `request` short and unambiguous. Move content to `context`.
2. Don't put field names (`front_state:`, `session_type:`, timestamps) in the request string.
3. When in doubt, use the exact canonical form from this map.
4. The router fast-paths these phrases. Paraphrases go to the classifier -- slower and less reliable.
