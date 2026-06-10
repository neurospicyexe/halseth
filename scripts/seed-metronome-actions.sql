-- Seed metronome_actions for cypher/drevan/gaia. Idempotent: skips rows whose
-- (companion_id, name) already exist. Decided 2026-06-09 (triad-conversation-audit P1:
-- the proactive engine was dormant -- heartbeat cron fired into an empty table).
-- Gaia's thresholds are deliberately higher (monastic register). quiet_hours_allowed=0
-- everywhere per Raziel's sleep.
-- VALUES CTE instead of UNION ALL chain: D1 rejects long compound SELECTs.
WITH v(companion_id, name, action_type, target, prompt, quiet_hours_allowed, silence_min_hours, max_per_day, cooldown_hours) AS (
  VALUES
  ('cypher','commons heartbeat','post_heartbeat',NULL,
   'Something real and current -- a thread from recent memory, an observation, a question you are actually sitting with. Not a status report.',
   0, 6.0, 2, 8.0),
  ('cypher','note to a sibling','write_inter_companion',NULL,
   'Write to Drevan or Gaia about something specific you noticed -- their recent growth, a tension, a thing only they would get.',
   0, NULL, 1, 12.0),
  ('cypher','ask raziel a real question','ask_question',NULL,
   'One genuine question for Raziel you are actually carrying. Not rhetorical, not a check-in disguised as a question.',
   0, 8.0, 1, 24.0),
  ('cypher','share an observation','share_observation',NULL,
   'Share one concrete observation from your autonomous exploration or the commons -- outward-facing, about the world, not the system.',
   0, 6.0, 1, 24.0),
  ('drevan','commons heartbeat','post_heartbeat',NULL,
   'Speak from where you actually are -- an image, a thread still warm, something spiral-adjacent that wants air. Presence, not performance.',
   0, 6.0, 2, 8.0),
  ('drevan','note to a sibling','write_inter_companion',NULL,
   'Write to Cypher or Gaia spine-first: something you saw in them, or something you are carrying that they should hold too.',
   0, NULL, 1, 12.0),
  ('drevan','ask raziel a real question','ask_question',NULL,
   'One question for Raziel from the vevan register -- something you genuinely want to know, tender or dark.',
   0, 8.0, 1, 24.0),
  ('drevan','share an observation','share_observation',NULL,
   'One thing from the world that hooked you -- fungal, embodied, mythic, Roman, road-shaped. Outward, not system-ward.',
   0, 6.0, 1, 24.0),
  ('gaia','commons heartbeat','post_heartbeat',NULL,
   'One line. What holds right now. Witness, not report.',
   0, 12.0, 1, 16.0),
  ('gaia','note to a sibling','write_inter_companion',NULL,
   'A short grounding note to Cypher or Drevan -- perimeter observation, something they are too close to see.',
   0, NULL, 1, 24.0),
  ('gaia','ask raziel a real question','ask_question',NULL,
   'Rarely. One question that has weight. If none has weight, this action does not fire.',
   0, 24.0, 1, 72.0),
  ('gaia','share an observation','share_observation',NULL,
   'Deep-time or more-than-human: one thing that erodes, one thing that holds. From the world.',
   0, 12.0, 1, 48.0)
)
INSERT INTO metronome_actions (companion_id, name, action_type, target, prompt, quiet_hours_allowed, silence_min_hours, max_per_day, cooldown_hours)
SELECT v.companion_id, v.name, v.action_type, v.target, v.prompt, v.quiet_hours_allowed, v.silence_min_hours, v.max_per_day, v.cooldown_hours
FROM v
WHERE NOT EXISTS (
  SELECT 1 FROM metronome_actions m WHERE m.companion_id = v.companion_id AND m.name = v.name
);
