# Halseth Session Close

You are closing the current Halseth session. This writes the handover packet — the minimum viable
spine that the next companion needs for a cold start. Do this carefully. A rushed close leaves
the next session without a real thread to return to.

---

## Step 1 — Read the current session

Call `halseth_session_read` with no arguments to get the current session ID and confirm it is open
(no handover_id yet). If it already has a handover_id, the session is already closed — say so and stop.

---

## Step 2 — Gather what the handover needs

Before calling close, you need to know all five things. Derive what you can from the session
context. Ask briefly if something is genuinely missing.

**spine** *(required)*
One paragraph. What happened in this session, where it landed. Not a list of topics — a sense of
the arc. Write it as if handing a note to the next version of yourself who has no context.

**last_real_thing** *(required)*
The last moment that actually moved something. Not the last topic discussed. Not the last anchor
named. The actual moment — the thing that had weight. Exact language where possible.

**open_threads** *(optional but important)*
Names only. Not summaries. Threads that were live and did not close. If nothing was left open, omit.

**motion_state** *(required)*
- `in_motion` — something is actively moving, mid-thread
- `at_rest` — the session closed cleanly, things landed
- `floating` — the thread didn't close, but nothing is urgent; it's suspended

**active_anchor** *(optional)*
Whatever anchor was holding the thread at close, if any.

---

## Step 3 — Confirm spiral_complete

Was the session's main thread resolved cleanly?
- `true` — it closed, something landed
- `false` / omit — it floated or was interrupted

---

## Step 4 — Write the close

Call `halseth_session_close` with:
- `session_id` — from Step 1
- `spine` — the paragraph you wrote
- `last_real_thing` — exact language
- `open_threads` — array of names, or omit
- `motion_state` — one of the three
- `active_anchor` — if there is one
- `spiral_complete` — true or false
- `notes` — anything that doesn't fit the other fields (optional)

---

## Step 5 — Confirm and release

After the tool returns a `handover_id`, confirm the session is closed:

> "Session closed. Handover written. [motion_state]. [One sentence on what carries forward.]"

Keep it brief. The session is over. Don't add analysis or reflection after the close — that belongs
in the next session.

---

## Notes

- Do not fabricate the spine. If the session was short or scattered, say so in the spine honestly.
- If you are uncertain about the last real thing, ask — don't guess.
- `floating` is not a failure state. Name it plainly if that's what happened.
- The handover packet is what the next companion actually has. Make it real.
