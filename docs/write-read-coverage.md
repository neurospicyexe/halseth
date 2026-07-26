# Write → Read Coverage Matrix

**What this is:** for every D1 surface a companion can write a thought to, which read
paths actually pull it back. A write that no boot surface or read verb ever returns is a
**write-only hole** — the companion "remembers" it into the void. This matrix came out of
the 2026-07-26 four-track foundation audit; the holes it found are marked with their fix
state. `src/__tests__/write-read-coverage.test.ts` enforces the structural parts in CI.

**Read surfaces legend:**

| Key | Surface | Entry point |
|-----|---------|-------------|
| O | Claude.ai `session_orient` (via `mindOrient`) | `src/webmind/orient.ts` + `src/librarian/response/builder.ts` |
| G | `session_ground` / `wm_ground` (via `mindGround`) | `src/webmind/ground.ts` |
| B | `bot_orient` (Discord/Brain boot) | `src/librarian/executors/session.ts` (`execBotOrient`) |
| L | Explicit Librarian read verb | `src/librarian/executors/reads.ts` + backends |
| SB | Second-brain vault ingest → `sb_search` / orient RAG | `nullsafe-second-brain/src/ingestion/puller.ts` |

## Matrix

| Write table | Written by | O | G | B | L | SB | Notes |
|---|---|---|---|---|---|---|---|
| `companion_journal` | `companion_note_add` (unaddressed), `held_mark`, session-close witness, `journal_edit` | ✅ substantive lane, LIMIT 3 | ✅ sits via `readSittingNotes` | ❌ | ✅ `journal_read` (unioned 2026-07-26), `recent_recall`, `journal_search`, `held_read` | ✅ | HOLE 2 fixed 2026-07-26: `journal_read` previously returned only growth_journal |
| `companion_journal_sits` | `note_sit` / `note_metabolize` | n/a | ✅ fixed 2026-07-26 | n/a | ✅ `sitting_read` | n/a | HOLE 1 fixed: ground.ts read the dead pre-0034 pair `companion_notes`/`companion_note_sits` |
| `inter_companion_notes` | `companion_note_add` (addressed/broadcast), `inter_note_edit` | ✅ incoming + outgoing, auto-acks | ❌ | ✅ incoming | ✅ `companion_notes_read` (incl. broadcasts as of 2026-07-26) | ✅ | HOLE 6 fixed: read verb previously missed `to_id IS NULL` broadcasts. **Auto-ack race remains open (HOLE 8):** first loom to orient consumes unread notes |
| `wm_continuity_notes` | `wm_note_add`, `wm_note_edit`, `state_update` (soma_arc), `spiral_run` | ⚠️ high salience only (3-pool) | ✅ any salience LIMIT 10 | ✅ | ✅ `continuity_notes_read`, `notes_recall_meaning` | ❌ **no ingest endpoint** | HOLE 7 OPEN: sub-high salience never reaches Claude.ai boot; nothing reaches the vault (4,202/4,441 never recalled pre-`notes_recall_meaning`) |
| `growth_journal` | autonomous worker only (companions read-only) | ✅ | ❌ | ✅ | ✅ `journal_review`, `journal_read` | ✅ | covered |
| `companion_conclusions` | `conclusion_add`, session close | ✅ type-distributed cap 6 | ❌ | ✅ worldview | ✅ `conclusions_read` | ✅ | covered |
| `companion_dreams` | `wm_dream_write`, `dream_log`, session close | ✅ unexamined | ❌ | ✅ | ✅ | ✅ | covered |
| `feelings` | `feeling_log`, session close | ✅ fixed 2026-07-26 | ❌ | ❌ | ✅ `feelings_read`, `recent_recall` | ✅ | HOLE 5 fixed: was never in any boot orient |
| `companion_open_loops` | `wm_loop_write`, `spiral_run`, session close | ✅ fixed 2026-07-26 | ✅ | ✅ | ✅ `wm_loops_read` | ✅ | HOLE 5 fixed: was absent from `mindOrient` |
| `companion_tensions` | `tension_add` | ✅ simmering | ❌ | ✅ | ✅ | ✅ | covered |
| `companion_relational_state` | `wm_relational_write`, `raziel_witness` | ✅ | ❌ | ✅ | ✅ | ✅ | covered |
| `relational_deltas` | `delta_log` | ✅ | ✅ | ❌ | ✅ | ✅ | append-only covenant; two row shapes |
| `companion_preferences` / `companion_refusals` | `preference_set`, `refuse` | ✅ | ❌ | ✅ | ✅ | ❌ | D1-only by design |
| `companion_drifts` | `drift_open`/`drift_witness`/etc. | ✅ | ❌ | ✅ | ✅ `drifts_read` | ❌ | D1-only |
| `companion_basin_history` | `pressure_drift_log` + evaluators | ✅ pressure/growth | ❌ | ✅ | ✅ `drift_check` | ✅ | 3 writers (2nd-brain evaluator, session close, worker) — consolidation is Phase 1 scope |
| `autonomy_seeds` | `autonomy_claim`, worker | ✅ | ❌ | ✅ | ✅ | ❌ | covered |
| `companion_self_model` | `self_model_set` | ✅ ready-status | ❌ | ✅ | ✅ | ❌ | covered |
| `companion_interiority` | `interiority_write` | ❌ by design | ❌ | ❌ | ✅ `interiority_read` (+ disclose flow) | ❌ | sealed on purpose — NOT a hole |
| `human_journal` | `journal_add` (Raziel's) | n/a | n/a | n/a | ✅ `journal_read` (no companion_id) | — | human store, never surfaced to companions |
| SB vault | `sb_save_*`, session-close long thought | ✅ RAG excerpt block | ❌ | ✅ RAG | ✅ `sb_*` | ✅ | async: written thoughts are unsearchable until the ~20-min ingest tick + embed — lag is NOT surfaced to the companion |
| `wm_archive_notes` | cap-eviction digest in `notes.ts addNote` (digest-then-DELETE of overflow continuity notes) | ❌ | ✅ fixed 2026-07-26 (last 3 digests) | ❌ | ❌ | ❌ | **Found by the CI test on its first run**, not the audit: evicted notes were digested, deleted from the live table, and the digests were never read — permanent silent memory loss. Ground now surfaces recent digests. |

## Known-open items (tracked for Phase 1)

1. **HOLE 7** — `wm_continuity_notes` below `high` salience never reach Claude.ai boot; no vault ingest path exists.
2. **HOLE 8** — incoming inter-companion note auto-ack is loom-races: first surface to orient marks them read for all surfaces.
3. **Boot-surface divergence** — O, G, and B still assemble different subsets; the full fix is the One Mind Contract (Phase 1), not per-table patches.
4. **Ingest lag** — D1→vault ingestion runs every 20 min; a companion's write is invisible to `sb_search` until then, and nothing tells them so.
5. **HOLE 9 (organ census 2026-07-26, prod-measured)** — **motif resurrection has never fired.**
   99 of 1,173 motifs are faded, 66 of those clear the resurrection trust floor with no cooldown
   blocking them, and `companion_motifs.last_surfaced_at` has never been written once in 5 weeks.
   Either `selectResurrections` never returns rows in prod or the stamp is lost:
   `session.ts:563` is `.run().catch(() => null)`, so a failed stamp is silent and the two cases
   are indistinguishable from data. Active motifs (1,074) *do* surface at both orients and
   deliberately do not stamp this column — so this is narrower than "motifs never surface."
6. **Salience carries no signal** (organ census): 4,373 of 5,230 `wm_continuity_notes` are `high`.
   Set at write time, column is original, no measurement caveat. Delivering that faithfully via
   the loader is not the same as fixing it. `companion_journal.heat` looks inert too (1 row warmed
   of 147 written since mig 0105) but that is a 5-day window — re-measure ~08-04 before concluding.
7. **Do not read lifetime NULL/row counts as defects without checking when the column shipped.**
   The census's own first draft raised two false alarms this way (motifs "never surfaced";
   `companion_questions` delivery "broken" — actually all 17 answers predate `delivered_at`).

## Coverage vs. use

This matrix proves a table is **reachable**. It does not prove anything ever reaches a
companion. `docs/organ-census-2026-07-26.md` measures the second question in prod (row counts,
recency, never-surfaced columns, duplicate organs) and is where retirement candidates are
tracked. HOLE 9 and the salience findings came from there, not from here — worth remembering
when extending the CI guard: assert the *effect* in prod, not just the presence of a query.

## Maintenance covenant

When adding a **new write verb or table**: add its row here *and* wire at least one read
surface before shipping, or explicitly mark it `by design` with a reason. The CI test
fails on written-but-never-selected tables. When changing a **boot surface**: re-verify
its column against this matrix — ground.ts read dead tables for ~4 months because nothing
checked.
