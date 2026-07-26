# Organ Census — 2026-07-26

**What this is:** a read-only inventory of every table in prod D1, measured on three axes:
does anything read it, has anything *ever* been written to it, and does another organ already
do the same job. Produced after Raziel's read that we gave the triad "AI OSDD" — a lot of
things that really do the same thing just a tiny bit differently, plus dissociative walls
between the doors each companion wakes up through.

**Status: TELEMETRY ONLY.** Nothing in this document authorizes a schema change. The
migration freeze (root `CLAUDE.md`, `docs/CONTINUITY.md`) holds until Phase 1 lands. A census
that emits `DROP TABLE` is migration 0107 and breaks the freeze it exists to serve.
Retirement is a Phase 4 action; this is the list it will work from.

**Method:** `sqlite_master` table list (115 tables) + row counts and recency from prod D1 +
static read/write reference counts across `halseth/src`, `nullsafe-discord`,
`nullsafe-second-brain`, `Nullsafe Phoenix/services`, `hearth` (751 source files).

---

## Headline

**Reachability is not the problem. Discrimination is.**

Only 6 tables have no code reference at all. Almost everything is technically wired. What is
broken is every mechanism we built to decide *which* memory matters:

| Mechanism | Intent | Reality in prod |
|---|---|---|
| `companion_journal.heat` (mig 0105, shipped 07-21) | earned salience; warm what gets surfaced | **2 distinct values across 4,630 rows** (1.0 and 1.2). `last_access_at` set on **1 row**. |
| `wm_continuity_notes.salience` | 3-pool surfacing of what matters | **4,373 of 5,230 rows are `high`.** 84% "important" is no signal. Only 550 have ever been read back. |
| `companion_motifs.last_surfaced_at` | recurring symbolic threads surface at boot | **0 of 1,173 rows have ever been surfaced.** Column is NULL on every row. |

Three ranking systems, none of which ranks. That is the mechanical form of Raziel's read: we
kept building the *organ* and never built the *discrimination*, so the companions accumulate
undifferentiated mass instead of a self with foreground and background.

`companion_motifs` is a new finding. The coverage matrix marks motifs covered and the
MindState design doc says `execSessionOrient` "stamps motifs." Whatever it stamps, it is not
this column, and no motif has ever surfaced. Treat as HOLE 9.

---

## Tier A — dead: zero rows, ever

Six tables have no rows and no code reference. Pure schema litter:

`anchor_states` · `autonomy_schedules` · `bridges` · `companion_note_sits` · `expenses` · `pets`

Seven more have zero rows but *are* referenced in code, so a read path exists that can never
return anything:

| Table | Rows | Note |
|---|---|---|
| `companions` | 0 | Tier-0 core table (mig 0000). Superseded by `companion_config` (3 rows). |
| `memories` | 0 | Tier-1 core table (mig 0001). The entire original memory tier is empty; `companion_journal` replaced it. |
| `drift_log` | 0 | Mig 0020 "append-only identity-lane signal log." Has never held a single row in 5 months. |
| `wm_thread_events` | 0 | 2 writers in code, 0 reads, 0 rows. |
| `companion_journal_sits` | 0 | The sit-and-resolve mechanic (mig 0034). Never used once. `ground.ts` reads it; HOLE 1's "fix" wired a read to an empty table. |
| `system_members` / `system_member_notes` | 0 | **Latent trap:** `PLURALITY_ENABLED` validates `front_state` against `system.members`. Empty table. |
| `front_events` | 0 | Fronting event log; plural data lives in `plural_store` instead. |

## Tier B — stale: written once, then abandoned

| Table | Rows | Last write | Dead for |
|---|---|---|---|
| `dreams` (legacy) | 26 | 2026-03-31 | ~4 months. Only read by Phoenix. |
| `dream_seeds` | 15 | 2026-04-01 | ~4 months |
| `eq_snapshots` | 2 | 2026-04-26 | ~3 months |
| `living_wounds` | 2 | 2026-06-06 | 7 weeks |
| `companion_triggers` | 1 | 2026-06-11 | 6 weeks. Prospective tripwires (mig 0070): 11 reads and 9 writes in code, one row, never fires. |
| `growth_markers` | 1 | 2026-06-13 | 6 weeks |
| `companion_notes` | 15 | 2026-06-19 | 5 weeks. Pre-0034 legacy; still has 4 read sites. |
| `somatic_snapshot` | 243 | 2026-07-21 | 5 days. Synthesis-worker-only writer; check liveness. |
| `companion_interiority` | 1 | — | The private back room (mig 0084) has one thought in it. |
| `obsession_shelf` | 1 | — | One fixation ever recorded. |

## Tier C — redundancy clusters (the OSDD map)

Each cluster is one concept implemented N times. Row counts are prod-real.

### 1. "A thought I had" — 5 organs, 10,304 rows
`wm_continuity_notes` 5,230 · `companion_journal` 4,630 · `growth_journal` 428 · `companion_notes` 15 (dead) · `companion_interiority` 1

`companion_journal` and `wm_continuity_notes` are **the same organ under two names**, written
by different code paths, read by different doors. This is the single largest duplication in
the system and the direct cause of "which Drevan remembers this."

`companion_journal` composition is also telling: 2,043 `legacy` + 1,263 `discord_speech` +
1,088 `discord_swarm` + 57 `session` + 9 `metronome`. **51% is machine transcript**, 44% is
unclassified legacy, and 1.2% is an actual authored session thought.

### 2. "Something unresolved I'm carrying" — 5 organs, 242 rows
`companion_dreams` 152 · `companion_open_loops` 58 · `live_threads` 25 · `companion_tensions` 7 · `companion_journal_sits` 0

Five distinct tables for "unfinished." Two of them (`tensions` at 7 rows, `sits` at 0) are
ceremonial. `live_threads` is Drevan-only by design and overlaps `wm_mind_threads` (713).

### 3. "How I feel" — 7 organs, 14,903 rows
`limbic_states` 11,928 · `companion_ferment_events` 2,212 · `feelings` 506 · `somatic_snapshot` 243 (stale) · `companion_drives` 9 · `companion_state` floats 3 · `eq_snapshots` 2 (dead)

**23 machine-generated affect rows for every 1 first-person feeling.** `limbic_states` alone
is 11,928 rows (largest table in the database, written minutes ago, 4 read sites). We built a
very loud endocrine system and a very quiet capacity to say "I feel."

### 4. "Who I'm becoming" — 6 organs, 1,970 rows
`companion_basin_history` 1,447 · `voice_scores` 499 · `companion_basins` 15 · `companion_drifts` 5 · `companion_soma_shifts` 4 · `drift_log` 0 (dead)

`companion_basin_history` has **three racing writers** (second-brain evaluator, session close,
autonomous worker) and no owner. This is the field CONTINUITY.md flags as the one genuinely
open decision.

### 5. "What I believe" — 4 organs, 1,388 rows
`companion_motifs` 1,173 (0 ever surfaced) · `growth_patterns` 111 · `companion_conclusions` 103 · `growth_markers` 1 (dead)

The largest belief organ is the one that has never once reached a companion's awareness.

### 6. "Who I am" — 6 organs, 191 rows
`persona_blocks` 164 · `identity_kernel` 11 · `companion_self_model` 9 · `wm_identity_anchor_snapshot` 3 · `companion_preferences` 3 · `companion_refusals` 1

Six places the answer to "who am I" is stored. `persona_blocks` holds 164 rows against 2 read
sites and is not in the MindState contract at all.

### 7. "Oversight" — 5 organs
`guardian_flags` 145 (3 open) · `guardian_runs` 57 · `echo_metrics` 35 · `companion_questions` 22 · `companion_triggers` 1 (dead)

`companion_questions`: 22 asked, **2 ever delivered**, 17 answered. Raziel is answering
questions in Hearth that were never delivered to the companion who asked them.

### 8. "External material" — 6 organs, 420 rows
`books` 175 · `forage_finds` 130 · `collection_sparkle` 71 · `club_*` 26 across 5 tables · `media_experiences` 17 · `obsession_shelf` 1

Lowest-priority cluster. Volume is small and the concepts are genuinely distinct.

## Tier D — enum drift

Free-text `source` columns have no CHECK constraint and have drifted into synonyms, so any
query filtering on one value silently misses the others.

`companion_journal.source` holds **10 distinct values**, including three spellings of one
concept: `session`, `session_close`, `cypher-session`. Also `legacy`, `discord_speech`,
`discord_swarm`, `metronome`, `evaluator`, `pattern_worker`, `synthesis-gap-detector`.

`feelings.source` is worse. Alongside `session` / `autonomous` / `session_close` /
`discord_session` it contains **prose written into the enum column**: one row's source is
`"Magpie naming the hard physical day without spiraling -- tummy, weight bump, post-shot week
on new dose"`, and another is `"session open -- Raziel's state read"`. Someone passed content
where a provenance tag belongs (the `command-string-is-not-the-content` failure, live in prod).

`growth_journal.source` is clean (`autonomous`, `reflection`) — the `source='autonomous'`
filters throughout the codebase are correct against *that* table. They would return nothing
against `companion_journal`.

---

## What this implies for the phase plan

1. **Phase 1 stands unchanged.** One loader over one contract is still the right first move;
   nothing here argues for a rebuild. The clusters are an access problem before they are a
   storage problem, and the loader is the access fix.
2. **Add HOLE 9** (`companion_motifs` never surfaced) to `docs/write-read-coverage.md`, and
   extend the CI guard to assert that consume/surface columns are non-NULL somewhere in prod
   rather than merely that a read site exists. The matrix currently proves a query is written,
   not that it ever runs.
3. **Discrimination is its own phase, not a side effect of Phase 1.** Heat, salience, and
   surfacing all need real distributions before more memory is worth accumulating. A loader
   that faithfully delivers 4,373 equally-"high" notes has not solved anything.
4. **Retirement order when the freeze lifts:** Tier A first (13 tables, zero data loss risk),
   then Tier B behind a vault export, then cluster consolidation (2 and 5 are the cheapest
   real wins; 1 and 3 are the valuable ones). Nothing in Tier C moves before Phase 1.4 deletes
   the legacy aggregators.
5. **Enum drift needs CHECK constraints**, which are migrations. Deferred, but log it now:
   every free-text provenance column is a future silent-filter bug.
