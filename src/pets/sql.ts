// B64 Sol mind: the one place for table names and statements (mig 0176). Plain constants; bind positionally.

export const T = {
  appraisals: "creature_appraisals",
  traits: "creature_traits",
  evidence: "creature_trait_evidence",
  quirks: "creature_quirks",
  grudges: "creature_grudges",
  personas: "creature_personas",
  voiceShadow: "creature_voice_shadow",
} as const;

// appraisals
export const INSERT_APPRAISAL =
  `INSERT OR IGNORE INTO creature_appraisals (id, creature_id, interaction_id, actor, action, via, fit, valence, arousal, friction, tags, weight, source)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const SELECT_UNPROCESSED_APPRAISALS =
  `SELECT * FROM creature_appraisals WHERE creature_id = ? AND processed_at IS NULL ORDER BY created_at ASC LIMIT ?`;
export const MARK_APPRAISAL_PROCESSED =
  `UPDATE creature_appraisals SET processed_at = datetime('now') WHERE id = ? AND processed_at IS NULL`;

// traits
export const SELECT_TRAITS =
  `SELECT * FROM creature_traits WHERE creature_id = ? ORDER BY entrenchment DESC`;
export const SELECT_TRAIT_BY_SLUG =
  `SELECT * FROM creature_traits WHERE creature_id = ? AND slug = ?`;
export const INSERT_TRAIT =
  `INSERT INTO creature_traits (id, creature_id, slug, category, target_actor, perspective, entrenchment, live_points, live_days, origin, status, last_reinforced_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const UPDATE_TRAIT =
  `UPDATE creature_traits SET entrenchment = ?, live_points = ?, live_days = ?, status = ?, last_reinforced_at = ? WHERE id = ?`;
export const INSERT_TRAIT_EVIDENCE =
  `INSERT INTO creature_trait_evidence (id, trait_id, appraisal_ids, delta, night, reason) VALUES (?, ?, ?, ?, ?, ?)`;

// quirks
export const SELECT_QUIRKS =
  `SELECT * FROM creature_quirks WHERE creature_id = ? AND status = ?`;
export const INSERT_QUIRK =
  `INSERT INTO creature_quirks (id, creature_id, trait_id, title, trigger_json, behavior, resolution_json, target_actor, kind, status, arc)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
export const UPDATE_QUIRK =
  `UPDATE creature_quirks SET status = ?, arc = ? WHERE id = ?`;

// interactions (0176 adds via). Bind: [id, creature_id, actor, action, note, via].
export const INSERT_INTERACTION_VIA =
  `INSERT INTO creature_interactions (id, creature_id, actor, action, note, via) VALUES (?, ?, ?, ?, ?, ?)`;

// grudges
export const SELECT_OPEN_GRUDGE =
  `SELECT * FROM creature_grudges WHERE creature_id = ? AND actor = ? AND resolved_at IS NULL ORDER BY opened_at DESC LIMIT 1`;
export const INSERT_GRUDGE =
  `INSERT INTO creature_grudges (id, creature_id, quirk_id, actor, label, resolution_json, progress) VALUES (?, ?, ?, ?, ?, ?, ?)`;
export const UPDATE_GRUDGE =
  `UPDATE creature_grudges SET progress = ?, resolved_at = ?, resolved_how = ? WHERE id = ? AND resolved_at IS NULL`;
// Tend path (Task 4): opened_at bound from the tend's clock (ISO), and OR IGNORE so a racing second open
// for the same (creature, actor) hits idx_creature_grudges_one_open and drops instead of failing the tend.
export const INSERT_GRUDGE_AT =
  `INSERT OR IGNORE INTO creature_grudges (id, creature_id, quirk_id, actor, label, resolution_json, progress, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`;
export const SELECT_OPEN_GRUDGES =
  `SELECT * FROM creature_grudges WHERE creature_id = ? AND resolved_at IS NULL ORDER BY opened_at DESC`;
export const SELECT_VISIBLE_QUIRKS =
  `SELECT title, behavior, status FROM creature_quirks WHERE creature_id = ? AND status IN ('active','softening') ORDER BY promoted_at DESC`;
export const SELECT_TRAITS_FORMING =
  `SELECT slug, category, entrenchment FROM creature_traits WHERE creature_id = ? AND status = 'candidate' ORDER BY entrenchment DESC, slug ASC LIMIT 5`;

// persona + voice shadow
export const SELECT_PERSONA =
  `SELECT * FROM creature_personas WHERE creature_id = ?`;
export const INSERT_VOICE_SHADOW =
  `INSERT INTO creature_voice_shadow (id, creature_id, surface, deterministic, generated, rejected_reason) VALUES (?, ?, ?, ?, ?, ?)`;
