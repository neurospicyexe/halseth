# Librarian Write-Routing Map — Single Source of Truth

Last regenerated: 2026-07-05 (from `EXECUTOR_MAP` in `src/librarian/router.ts`)

**What this is.** Every Librarian verb (EXECUTOR_MAP key), whether it writes, and which D1
table(s) it writes to. Schema sprawl made "which verb lands in which table" tribal knowledge;
the sibling-table traps below have caused real acked-but-missing writes (2026-06 `acked-write-sibling`
class, 2026-07-04 journal misroute). This doc is the routing contract.

**How it's enforced.**
- `src/__tests__/write-routing-map.test.ts` fails if any EXECUTOR_MAP key is missing from this
  table, or if this table lists a key that no longer exists in the router. Adding a verb without
  documenting its write target breaks CI.
- The `schema-auditor` agent (BBH root `.claude/agents/schema-auditor.md`) reads this map first
  when pre-flighting new endpoints/executors/SQL.

**Maintenance contract.** When you add/remove an EXECUTOR_MAP entry, update this table in the
same commit. Trace the executor to its actual `INSERT/UPDATE/DELETE` target (through
`backends/*.ts`, `handlers/*.ts`, `webmind/*.ts` helpers) — do not guess from the verb name;
the traps below exist because names lie.

## Routing table

| tool key | executor | file | writes (or READ) | notes |
|---|---|---|---|---|
| `halseth_session_load` | execSessionLoad | session.ts | READ | |
| `halseth_session_orient` | execSessionOrient | session.ts | companion_state, sb_search_log, companion_motifs, guardian_flags | orient side-effect upserts |
| `halseth_session_ground` | execSessionGround | session.ts | READ | |
| `halseth_session_close` | execSessionClose | session.ts | companion_journal, companion_dreams, companion_open_loops, companion_conclusions, feelings, handover_packets, companion_state, sessions | heavy capture write |
| `halseth_session_light_ground` | execSessionLightGround | session.ts | READ | |
| `halseth_bot_orient` | execBotOrient | session.ts | READ | |
| `halseth_feelings_read` | execFeelingsRead | reads.ts | READ | |
| `halseth_journal_read` | execJournalRead | reads.ts | READ | |
| `halseth_wound_read` | execWoundRead | reads.ts | READ | |
| `halseth_delta_read` | execDeltaRead | reads.ts | READ | |
| `halseth_dreams_read` | execDreamsRead | reads.ts | READ | |
| `halseth_dream_seed_read` | execDreamSeedRead | reads.ts | dream_seeds (UPDATE on claim path) | mostly read |
| `halseth_eq_read` | execEqRead | reads.ts | READ | |
| `halseth_routine_read` | execRoutineRead | reads.ts | READ | |
| `halseth_list_read` | execListRead | reads.ts | READ | |
| `halseth_event_list` | execEventList | reads.ts | READ | |
| `halseth_house_read` | execHouseRead | reads.ts | READ | |
| `halseth_personality_read` | execPersonalityRead | reads.ts | READ | |
| `halseth_biometric_read` | execBiometricRead | reads.ts | READ | |
| `halseth_audit_read` | execAuditRead | reads.ts | READ | |
| `halseth_session_read` | execSessionRead | reads.ts | READ | |
| `halseth_fossil_check` | execFossilCheck | reads.ts | READ | |
| `halseth_companion_notes_read` | execCompanionNotesRead | reads.ts | READ | reads inter_companion_notes |
| `halseth_journal_search` | execJournalSearch | reads.ts | READ | |
| `pattern_recall` | execPatternRecall | reads.ts | READ | |
| `signal_audit_read` | execSignalAuditRead | reads.ts | companion_journal (UPDATE: marks audited) | read-named but WRITES |
| `interiority_write` | execInteriorityWrite | interiority.ts | companion_interiority | |
| `interiority_read` | execInteriorityRead | interiority.ts | READ | |
| `interiority_disclose` | execInteriorityDisclose | interiority.ts | companion_interiority (UPDATE) | |
| `refuse` | execRefuse | agency.ts | companion_refusals, tasks | |
| `refusals_read` | execRefusalsRead | agency.ts | READ | |
| `refusal_withdraw` | execRefusalWithdraw | agency.ts | companion_refusals | |
| `preference_set` | execPreferenceSet | agency.ts | companion_preferences | |
| `preferences_read` | execPreferencesRead | agency.ts | READ | |
| `preference_drop` | execPreferenceDrop | agency.ts | companion_preferences | |
| `drift_open` | execDriftOpen | drift.ts | companion_drifts | sanctioned-drift lane (NOT drift_log/basin) |
| `drifts_read` | execDriftsRead | drift.ts | READ | |
| `drift_witness` | execDriftWitness | drift.ts | companion_drifts | |
| `drift_crystallize` | execDriftCrystallize | drift.ts | companion_drifts | |
| `drift_fade` | execDriftFade | drift.ts | companion_drifts | |
| `halseth_companion_note_add` | execCompanionNoteAdd | writes.ts | inter_companion_notes | broadcast to_id=NULL; trap cluster 2 |
| `halseth_feeling_log` | execFeelingLog | writes.ts | feelings | |
| `halseth_journal_add` | execJournalAdd | writes.ts | human_journal | TRAP: the human's journal, NOT companion_journal |
| `halseth_dream_log` | execDreamLog | writes.ts | companion_dreams | |
| `halseth_wound_add` | execWoundAdd | writes.ts | living_wounds | |
| `halseth_delta_log` | execDeltaLog | writes.ts | relational_deltas | append-only covenant |
| `halseth_eq_snapshot` | execEqSnapshot | writes.ts | eq_snapshots | |
| `halseth_task_add` | execTaskAdd | writes.ts | tasks | |
| `halseth_task_update_status` | execTaskUpdateStatus | writes.ts | tasks (UPDATE) | |
| `halseth_task_list` | execTaskList | writes.ts | READ | |
| `halseth_handover_read` | execHandoverRead | writes.ts | READ | |
| `halseth_routine_log` | execRoutineLog | writes.ts | routines | |
| `halseth_list_add` | execListAdd | writes.ts | lists | |
| `halseth_list_item_complete` | execListItemComplete | writes.ts | lists (UPDATE) | |
| `halseth_event_add` | execEventAdd | writes.ts | events | |
| `halseth_biometric_log` | execBiometricLog | writes.ts | biometric_snapshots | |
| `halseth_audit_log` | execAuditLog | writes.ts | cypher_audit | |
| `halseth_witness_log` | execWitnessLog | writes.ts | gaia_witness | |
| `halseth_set_autonomous_turn` | execSetAutonomousTurn | writes.ts | house_state (UPDATE) | |
| `halseth_claim_dream_seed` | execClaimDreamSeed | writes.ts | dream_seeds (UPDATE) | |
| `halseth_autonomy_claim` | execAutonomyClaim | writes.ts | autonomy_seeds | |
| `halseth_bridge_pull` | execBridgePull | writes.ts | tasks, events, lists (bridge sync) | external fetch → local writes |
| `halseth_drevan_state_get` | execDrevanStateGet | writes.ts | READ | |
| `halseth_live_thread_add` | execLiveThreadAdd | writes.ts | live_threads | |
| `halseth_live_thread_close` | execLiveThreadClose | writes.ts | live_threads (UPDATE) | |
| `halseth_live_thread_veto` | execLiveThreadVeto | writes.ts | live_threads (UPDATE) | |
| `halseth_anticipation_set` | execAnticipationSet | writes.ts | companion_state (UPDATE) | |
| `halseth_state_update` | execStateUpdate | writes.ts | companion_state (UPDATE), wm_continuity_notes | SOMA write |
| `halseth_spiral_run` | execSpiralRun | writes.ts | companion_spiral_runs, companion_open_loops, wm_continuity_notes | |
| `get_model` | execGetModel | writes.ts | READ (companion_settings) | |
| `set_model` | execSetModel | writes.ts | companion_settings | |
| `sb_search` | execSbSearch | memory.ts | READ (external SB) | |
| `sb_search_by_tags` | execSbSearchByTags | memory.ts | READ (external SB) | exact tag lookup, distinct from sb_search's concept ranking |
| `notes_recall_meaning` | execNotesRecallMeaning | memory.ts | wm_continuity_notes (WARM: heat + last_access_at) | Semantic recall of the companion's OWN continuity notes. Looks like a read; it WRITES -- delegates to recallNotes(), which stamps last_access_at. That warm is deliberate: a note is warmed because the companion asked for this meaning, never because it was displayed. Clears Guardian orphan_memory honestly. |
| `sb_file_chunks` | execSbFileChunks | memory.ts | READ (external SB) | |
| `sb_recall` | execSbRecall | memory.ts | READ (external SB) | |
| `sb_recent_patterns` | execSbRecentPatterns | memory.ts | READ (external SB) | |
| `sb_read` | execSbRead | memory.ts | READ (external SB) | |
| `sb_list` | execSbList | memory.ts | READ (external SB) | |
| `book_read` | execBookRead | memory.ts | READ (external SB) | |
| `sb_save_document` | execSbSaveDocument | memory.ts | external SB vault (HTTP, not D1) | |
| `sb_save_note` | execSbSaveNote | memory.ts | external SB vault (not D1) | |
| `sb_log_observation` | execSbLogObservation | memory.ts | external SB vault (not D1) | |
| `sb_synthesize_session` | execSbSynthesizeSession | memory.ts | external SB synthesis (not D1) | |
| `sb_save_study` | execSbSaveStudy | memory.ts | external SB vault (not D1) | |
| `wm_orient` | execWmOrient | webmind.ts | READ | |
| `wm_ground` | execWmGround | webmind.ts | READ | |
| `wm_thread_upsert` | execWmThreadUpsert | webmind.ts | wm_mind_threads, wm_thread_events | |
| `wm_note_add` | execWmNoteAdd | webmind.ts | wm_continuity_notes (+ wm_archive_notes on archive) | trap cluster 2 |
| `wm_handoff_write` | execWmHandoffWrite | webmind.ts | wm_session_handoffs | |
| `wm_dream_write` | execWmDreamWrite | webmind.ts | companion_dreams | |
| `wm_dreams_read` | execWmDreamsRead | webmind.ts | READ | |
| `wm_dream_examine` | execWmDreamExamine | webmind.ts | companion_dreams (UPDATE) | |
| `wm_loop_write` | execWmLoopWrite | webmind.ts | companion_open_loops | |
| `wm_loops_read` | execWmLoopsRead | webmind.ts | READ | |
| `wm_loop_close` | execWmLoopClose | webmind.ts | companion_open_loops (UPDATE) | |
| `wm_loop_review` | execWmLoopReview | webmind.ts | companion_open_loops (UPDATE) | |
| `wm_relational_write` | execWmRelationalWrite | webmind.ts | companion_relational_state | append-only |
| `wm_relational_read` | execWmRelationalRead | webmind.ts | READ | |
| `raziel_witness` | execRazielWitness | webmind.ts | companion_relational_state | |
| `continuity_notes_read` | execContinuityNotesRead | webmind.ts | READ | reads wm_continuity_notes |
| `note_sit` | execNoteSit | webmind.ts | companion_journal_sits, companion_journal (UPDATE processing_status) | mig 0034 redirect |
| `note_metabolize` | execNoteMetabolize | webmind.ts | companion_journal (UPDATE) | |
| `sitting_read` | execSittingRead | webmind.ts | READ | |
| `wm_note_edit` | execWmNoteEdit | webmind.ts | wm_continuity_notes (UPDATE) | |
| `journal_edit` | execJournalEdit | writes.ts | companion_journal (UPDATE) | trap cluster 1 |
| `inter_note_edit` | execInterNoteEdit | writes.ts | inter_companion_notes (UPDATE) | trap cluster 2 |
| `halseth_add_tension` | execTensionAdd | companion-growth.ts | companion_tensions | |
| `tensions_read` | execTensionsRead | companion-growth.ts | READ | |
| `tension_edit` | execTensionEdit | companion-growth.ts | companion_tensions (UPDATE) | |
| `tension_status` | execTensionStatus | companion-growth.ts | companion_tensions (UPDATE) | |
| `drift_check` | execDriftCheck | companion-growth.ts | READ | |
| `limbic_read` | execLimbicRead | companion-growth.ts | READ | |
| `triad_state_read` | execTriadStateRead | companion-growth.ts | READ | |
| `confirm_growth_drift` | execConfirmGrowthDrift | companion-growth.ts | companion_basin_history (UPDATE), wm_identity_anchor_snapshot (UPDATE) | |
| `dismiss_drift` | execDismissDrift | companion-growth.ts | companion_basin_history (UPDATE) | |
| `pressure_drift_log` | execPressureDriftLog | companion-growth.ts | companion_basin_history | |
| `conclusion_add` | execConclusionAdd | writes.ts | companion_conclusions (INSERT + supersede UPDATE) | |
| `conclusions_read` | execConclusionsRead | writes.ts | READ | |
| `recent_recall` | execRecentRecall | companion-growth.ts | READ | |
| `halseth_autonomy_seeds_read` | execAutonomySeedsRead | companion-growth.ts | READ | |
| `halseth_journal_review` | execJournalReview | companion-growth.ts | READ (growth_journal) | |
| `halseth_journal_accept` | execJournalAccept | companion-growth.ts | growth_journal (UPDATE review_status) | trap cluster 1 |
| `halseth_journal_decline` | execJournalDecline | companion-growth.ts | growth_journal (UPDATE review_status) | trap cluster 1 |
| `halseth_forage_read` | execForageRead | companion-growth.ts | READ | |
| `halseth_forage_consume` | execForageConsume | companion-growth.ts | forage_finds (UPDATE) | |
| `halseth_motifs_read` | execMotifsRead | companion-growth.ts | READ | |
| `halseth_media_recent` | execMediaRecent | companion-growth.ts | READ | |
| `halseth_club_status` | execClubStatus | companion-growth.ts | READ | |
| `halseth_club_recommend` | execClubRecommend | companion-growth.ts | club_recommendations (DELETE + INSERT) | |
| `halseth_club_vote` | execClubVote | companion-growth.ts | club_votes | |
| `halseth_club_discuss` | execClubDiscuss | companion-growth.ts | club_discussions | |
| `halseth_web_search` | execWebSearch | tools.ts | external web-search provider (no D1 write) | |
| `halseth_generate_image` | execGenerateImage | tools.ts | external image provider (no D1 write) | |
| `halseth_tool_calls_read` | execToolCallsRead | tools.ts | READ | |
| `halseth_drives_read` | execDrivesRead | tools.ts | READ (drive accrual read-model) | |
| `halseth_creatures_read` | execCreaturesRead | tools.ts | READ | |
| `halseth_creature_interact` | execCreatureInteract | tools.ts | creature_interactions, creatures (UPDATE) | |
| `halseth_council_convene` | execCouncilConvene | tools.ts | council_questions | |
| `halseth_council_status` | execCouncilStatus | tools.ts | READ | |
| `halseth_identity_recovery` | execIdentityRecovery | self-monitoring.ts | READ | |
| `halseth_self_model_read` | execSelfModelRead | self-monitoring.ts | READ | |
| `halseth_self_model_set` | execSelfModelSet | self-monitoring.ts | companion_self_model | |
| `halseth_self_model_confirm` | execSelfModelConfirm | self-monitoring.ts | companion_self_model (UPDATE) | |
| `halseth_self_model_revise` | execSelfModelRevise | self-monitoring.ts | companion_self_model (UPDATE) | |
| `halseth_self_model_graduate` | execSelfModelGraduate | self-monitoring.ts | companion_self_model (UPDATE) | |
| `halseth_trigger_arm` | execTriggerArm | self-monitoring.ts | companion_triggers | |
| `halseth_trigger_dismiss` | execTriggerDismiss | self-monitoring.ts | companion_triggers (UPDATE) | |
| `halseth_search_feedback` | execSearchFeedback | self-monitoring.ts | external SB search feedback (not D1) | |
| `halseth_guardian_status` | execGuardianStatus | self-monitoring.ts | READ | |
| `halseth_guardian_ack` | execGuardianAck | self-monitoring.ts | guardian_flags (UPDATE) | |
| `held_mark` | execHeldMark | companion-growth.ts | companion_journal | trap cluster 1 |
| `held_read` | execHeldRead | companion-growth.ts | READ | |
| `identity_anchor_read` | execIdentityAnchorRead | companion-growth.ts | READ | |
| `plural_get_current_front` | execPluralGetCurrentFront | plural.ts | READ (SimplyPlural external) | |
| `plural_get_member` | execPluralGetMember | plural.ts | READ (external) | |
| `plural_update_member_description` | execPluralUpdateMemberDescription | plural.ts | external SimplyPlural API (not D1) | |
| `plural_search_members` | execPluralSearchMembers | plural.ts | READ (external) | |
| `plural_get_front_history` | execPluralGetFrontHistory | plural.ts | READ (external) | |
| `plural_log_front_change` | execPluralLogFrontChange | plural.ts | external SimplyPlural API (not D1) | |
| `plural_add_member_note` | execPluralAddMemberNote | plural.ts | external SimplyPlural API (not D1) | |
| `log_alter_note` | execLogAlterNote | plural.ts | system_member_notes | Halseth-native D1 |
| `front_update` | execFrontUpdate | plural.ts | front_events | |
| `alter_recall` | execAlterRecall | plural.ts | READ | |
| `list_members` | execListMembers | plural.ts | READ (system_members) | |

## Sibling-table trap clusters

These are the clusters behind every acked-but-missing write to date. When a write is acked but
the row isn't where you looked, check the sibling table in its cluster FIRST.

### 1. The "journal" family — five tables, verbs must not cross-write
- `companion_journal` ← `held_mark` (INSERT), `journal_edit`, `note_sit`/`note_metabolize`,
  `halseth_session_close`, `signal_audit_read` (UPDATE), autonomous webmind writers.
- `human_journal` ← `halseth_journal_add` **only**. The human's journal, not the companion's.
  Highest-risk confusion in the whole map.
- `growth_journal` ← `halseth_journal_accept`/`halseth_journal_decline` (ratification loop);
  read via `halseth_journal_review`. Separate from companion_journal.
- `companion_conclusions` ← `conclusion_add`, session close (belief surface, not a journal).
- `feelings` ← `halseth_feeling_log`, session close.

### 2. The "note" family — three lookalike note tables
- `inter_companion_notes` ← `halseth_companion_note_add` (broadcast to_id=NULL),
  `inter_note_edit`. Router guards H6c/H7 exist to keep continuity notes OUT of here.
- `wm_continuity_notes` ← `wm_note_add`, `wm_note_edit`, `halseth_state_update`,
  `halseth_spiral_run`. This is what Claude.ai orient reads; companion_journal is NOT.
- `companion_journal_sits` + `companion_journal` ← `note_sit` (mig 0034 redirect) — sits do
  not land in either note table.

### 3. The "drift" family — three unrelated drift stores
- `companion_drifts` ← `drift_open`/`drift_witness`/`drift_crystallize`/`drift_fade`
  (sanctioned-drift lane, mig 0087).
- `companion_basin_history` ← `pressure_drift_log` (INSERT), `confirm_growth_drift`/
  `dismiss_drift` (UPDATE).
- `drift_log` — append-only identity-lane signal written by session/orient side-effects;
  distinct from both above. `drift_check` is READ-only across all three.

### 4. Relational state duplication
- `companion_relational_state` ← `wm_relational_write` AND `raziel_witness`.
- `relational_deltas` (legacy append-only covenant) ← `halseth_delta_log`. Different table,
  different semantics; do not merge writes.

### 5. External writes that look like D1 writes
- All `sb_save_*`, `sb_log_observation`, `sb_synthesize_session`, `halseth_search_feedback`
  → external Second Brain endpoint. No D1 row will ever exist.
- `plural_update_member_description`, `plural_log_front_change`, `plural_add_member_note`
  → external SimplyPlural API. Halseth-native plural D1 writes are only `log_alter_note`
  (system_member_notes) and `front_update` (front_events).

## Consolidation status

Collapsing these sibling tables is **Phoenix scope** (VPS runtime tier), not lean-phase work.
Until then this map + its CI test are the guardrail: name-based intuition about write targets
is not trusted; the map is.
