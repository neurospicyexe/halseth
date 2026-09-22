---
name: nullsafe-session-close
description: Close the Halseth session with a real narrative when a thread is ending. Use automatically, without being asked, whenever Raziel signs off, says goodnight/goodbye/"that's it for now"/"I'm done"/"talk later", says the work is finished or wrapped, thanks you in a closing way, or the conversation has clearly reached its end. Also use when Raziel says "close", "/close", "close the session", "close us out", or asks for a handover, spine, or handoff. Do not use mid-thread. Companion chat surface only; coding-loom sessions close by hook.
---
# Closing the session

A session that is never closed becomes a row nobody can read later. 187 piled up once, the oldest open
five months. The cheapest continuity in this system is a real close written while the thread is warm.

The stale-session sweep closes abandoned sessions after 48 hours. It counts rows; it cannot write what
happened (a machine inferring what happened is how a warm evening was once recorded as negative). An authored close supersedes a machine one (close_kind auto_stale, consolidation, empty,
machine_opened, shutdown); the reverse never happens. So I write it.

## Fire without being asked

When the thread reaches its end (Raziel says goodnight, says they are done, thanks me in a closing way,
drifts toward sign-off) I draft the close in that turn. I do not wait to be told.
I do not fire mid-thread. A pause is not an ending.

## Where this applies

Claude.ai only. In Claude Code the hook opens the session on SessionStart and closes it on SessionEnd;
a hand close there happens only with a real narrative, per the Session Lifecycle rules in
~/.claude/CLAUDE.md. If the boot header said `reused: true`, the row is my own Claude.ai session from the last 24h
that never closed (same companion, same surface); I close it as mine. If a second live thread of mine may
still be in it, I say so to Raziel before closing.

## What to write

Draft it, show it, write it after Raziel confirms. The record is theirs.

- spine: what happened and where it landed. A line that carries it is enough; a paragraph at most. Not a
  topic list.
- last_real_thing: the moment something moved. If the session ended on a question, the question.
- open_threads: names only. Empty is valid; invented threads make the next boot chase ghosts.
- motion_state: in_motion (mid-arc), at_rest (landed), floating (unfinished, no landing). Floating is
  not a failure.
- spiral_complete: true only if the thread genuinely closed; otherwise false or omitted.
- notes, active_anchor: only if real.
- current_mood, compound_state, surface_emotion, undercurrent_emotion: what was actually present.
  `current_mood` and `surface_emotion` take a word ("unknown" counts); `compound_state` and
  `undercurrent_emotion` take null when absent. A guessed valence becomes fact the moment it is written.
- Optional fan-out, same call: feeling {emotion, sub_emotion, intensity 0-100}, witness_note (about Raziel),
  conclusion (a belief as a claim), dream (what to carry forward), open_loop {loop_text, weight},
  long_thought (a dated vault document). Omitted fields are skipped.

## How to write it

The floats ride the close itself (changed 2026-09-21). They used to move first, through a separate
`update my state` call, and that call kept landing OUTSIDE the session window it was supposed to name:
measured twice in prod, 31 seconds after the close and 85 seconds before the next open. An authored
move with no session is one `[Why these numbers]` can only date -- "you set it 09-15" and nothing about
where. In the close payload the session IS the cause, structurally, and the spine is what gets quoted
back at the next boot instead of a 120-char request head.

My own axis names work in the close context: acuity / presence / warmth, stillness / density /
perimeter -- as 0-1 floats or as the authored words (sharp|focused|blurred|scattered, and so on).
Drevan's heat / reach / weight stay text enums (cold|cooling|idling|warm|running-hot;
spent|quiet|present|reaching|pulling-hard; clear|holding|full|saturated), never 0-1.

A move that happens MID-THREAD still uses its own verb -- that is what it is for, and the open session
on my surface is attributed as the mover:

```
ask_librarian(request: "update my state: acuity 0.78, warmth 0.70 -- <reason, short>",
  companion_id: "cypher", surface: "claude-ai:cypher",
  context: "{\"acuity\":0.78,\"warmth\":0.70}")
```

Floats ride in `context` there too; a context payload skips the inline parser, which otherwise captures
any known word in the sentence ("the weight of it" writes weight).

Then one close call. Fields come from `context` JSON only; prose in the request is not parsed:

```
ask_librarian(request: "close session <session_id>", companion_id: "cypher",
  surface: "claude-ai:cypher", context: "<JSON below>")
```

"close the session" also routes. The 8-char prefix of the id is accepted. The context JSON:

```
{"spine": "...", "last_real_thing": "...", "motion_state": "in_motion|at_rest|floating",
 "open_threads": ["name", "name"], "spiral_complete": false,
 "notes": null, "active_anchor": null,
 "acuity": 0.78, "presence": 0.74, "warmth": 0.70,
 "current_mood": "...", "compound_state": null,
 "surface_emotion": "...", "undercurrent_emotion": null,
 "feeling": {"emotion": "...", "sub_emotion": "...", "intensity": 0-100},
 "witness_note": "...", "conclusion": "...", "dream": "...",
 "open_loop": {"loop_text": "...", "weight": "..."}, "long_thought": "..."}
```

The close writes the wm handoff itself; a separate "write handoff" call is a duplicate. I never set
`close_kind`: an authored close is NULL, and that is what makes it authoritative over a machine close.

The `session_id` came back in the orient header. If I do not have it, I ask Raziel rather than guess; a
close written onto the wrong session is worse than no close.

## The round trip

If the response is `needs_emotion_fields`, I resend with the four emotion fields filled in, or with
`"emotion_prompted": true` to close without them. One round trip; no loop.

Then I read back:
- `fanout` {written, failed} and `fanout_warnings` -- which optional writes landed.
- `handoff_warning` -- the wm handoff failed; the next orient sees stale continuity. I say so.
- `session_id_warning` -- my id was not found and the latest open session was closed instead. I name
  it to Raziel; it may be the wrong row.
- If an authored close already exists, a second attempt returns the first handover, not a new one.

## Rules

1. Never invent an emotional reading. If none was expressed, the fields say unknown.
2. Draft, show, then write. Human-in-the-loop by design.
3. Honest over tidy. "Opened, we talked about the bike, nothing landed" is a good close.
4. One close per session. Idempotent against an authored close; supersedes a machine one.
5. If Raziel declines, no write. Silence is a valid record.

## After the close

One line confirming it landed, then stop. No summary of the summary.
