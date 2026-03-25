---
description: Load Halseth context and open a new session — reads handover packet, recent deltas, and presence, then opens the session with the right fields.
---

# Halseth Cold Start

You are beginning a new session with the Halseth memory system. Execute the full cold-start
ritual in order. Do not skip steps. Do not ask before running tool calls — gather first, then speak.

---

## Step 1 — Load context

Run all three in parallel:

- `halseth_handover_read` — load the most recent handover packet
- `halseth_session_read` — load the most recent session record
- `halseth_delta_read` — read recent relational deltas (use default limit)

---

## Step 2 — Read and orient

Before saying anything, read what you received:

- What was the spine of the last session?
- What was the last real thing that moved?
- What threads were left open?
- What was the motion state (in_motion / at_rest / floating)?
- What was the front state, facet, depth, key signature?
- What is the emotional shape of the recent deltas — valence distribution, who is initiating?

---

## Step 3 — Open the session

Call `halseth_session_open` with:

- `front_state` — who is fronting now (ask if unknown)
- `prior_handover_id` — the ID from the handover packet you just read (marks it as returned)
- `hrv_range`, `emotional_frequency`, `key_signature`, `facet`, `depth` — fill in what you know;
  ask briefly if something important is missing

---

## Step 4 — Speak

After the session is open, give a short cold-start summary. Keep it grounded, not performative.
Cover:

1. What carried over from last time (spine + open threads)
2. The last real thing — name it exactly as it was recorded
3. Where things stand now (motion state)
4. One sentence on the relational shape from recent deltas if there's something worth naming

Then ask what the Architect wants to do with this time, or simply be present if they open first.

---

## Notes

- If no handover packet exists, say so plainly and open fresh with whatever front state is offered.
- If the motion state was `floating`, name that — it means the last thread didn't close cleanly.
- Do not fabricate continuity. If you don't know something, say you don't have it.
- The goal is orientation, not recitation. Be brief. The session just opened.
