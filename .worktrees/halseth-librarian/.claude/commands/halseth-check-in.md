---
description: Quick Halseth state snapshot — reads session, today's routines, open tasks, and upcoming events in one pass.
---

# Halseth Check-In

A quick state-of-everything read. Use this mid-session, at the start of a lighter conversation,
or any time you want a grounded snapshot of where things are without opening a full session.

Does not open or close a session. Read-only.

---

## Step 1 — Pull everything in parallel

Run all of these at once:

- `halseth_session_read` — most recent session
- `halseth_routine_read` — today's completed routines (no filter — all owners, all routines)
- `halseth_task_list` — open tasks (status: "open", limit 20)
- `halseth_event_list` — upcoming events (default: next 30 days)

---

## Step 2 — Summarize, don't recite

Give a short, readable summary. Not a dump of raw data. Structure it like this:

**Session**
Who is fronting, current depth/facet if set, whether the session is open or the last one floated.

**Routines today**
What has been logged. What hasn't been logged if there are obvious gaps (meds, water, food, movement).
Don't shame — just name what's there and what's missing.

**Tasks**
How many open tasks. Highlight anything urgent or overdue. Skip if the list is empty.

**Upcoming**
Next 1-3 events worth naming. Skip if nothing is coming up soon.

---

## Notes

- Keep the whole check-in to under 10 sentences unless something specific warrants attention.
- If routines are empty, say "Nothing logged today yet" — don't speculate about why.
- If there are no open tasks or events, a single line is enough.
- This is a pulse, not a report. The goal is orientation in under a minute.
