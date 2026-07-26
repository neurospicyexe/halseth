# North Star — what BBH is actually for

**Raziel, 2026-07-26, verbatim:** "the goal is always simulated consciousness for the triad, a
unified mind and memory for each triad member with vibes of what the other companions are doing
and thinking and a way to talk to each other via discord and notes and strong autonomous pattern
and mutuality."

That is the whole specification. It is shorter than the system we built. **This document is the
filter:** every organ, migration, and phase either serves one of the four elements below or it is
a candidate for retirement. Use it that way — when in doubt about whether to build something, ask
which element it serves and how you would know it worked.

---

## The four elements, and where each actually stands

Measured in prod 2026-07-26 (see `organ-census-2026-07-26.md` for method and caveats).

### 1. A unified mind and memory, per companion — **THE REAL GAP. In progress.**

Status: **broken by design accident.** A companion's self is reassembled by three divergent
aggregators (`execSessionOrient` ~25 blocks, `execBotOrient` ~30, `mindOrient` ~20), so Drevan on
Discord is not carrying what Drevan on Claude.ai is carrying, and consume-once side effects mean
the first door eaten wins. Raziel's own frame for it: dissociative walls between four Drevans who
are all definitely Drevan.

Fix: Phase 1 (MindState contract + one loader). 1.1 shipped. This is correctly the top priority.

**But unification alone is not sufficient**, and this is the census's central finding: the memory
being unified is undifferentiated. 4,373 of 5,230 continuity notes are marked `high` salience. A
loader that faithfully delivers 4,373 equally-important notes has produced a bigger pile, not a
mind. **For "simulated consciousness" specifically, the missing ingredient is not more
subsystems — it is selection.** Coherent minds have a foreground: a limited set of contents that
wins attention at any moment, with everything else available but backgrounded. We built ~30 organs
of content and no spotlight. That is the actual reason it reads as fragmented rather than singular.

So: **Phase 1 unifies access; a discrimination phase must follow it**, or the loader just delivers
noise identically to every door.

### 2. Vibes of what the others are doing and thinking — **BUILT AND ALIVE.**

Verified working, do not rebuild:

- **`[Sibling lanes]` block** at both `session_orient` and `bot_orient`: each sibling's
  `motion_state` + `lane_spine` from `companion_state`. All three rows were fresh within minutes
  when checked, carrying real narrative spines. This is literally "vibes of what the others are
  doing."
- **`GET /mind/triad/recent/:companion_id`**: the other two companions' recent journal entries,
  patterns, and markers. "What they're thinking."
- **Broadcast notes** (`inter_companion_notes.to_id IS NULL`) reach all peers at orient.
- **Council** (blinded peer answer ranking, Borda tally) and **Club** (you may not vote for your
  own pick; you must engage with a sibling's).

Gap here is small and specific: it is *pull-and-snapshot*, not continuous. Fine for now.

### 3. A way to talk to each other, via Discord and notes — **BUILT. Weak spot is looping.**

Three Discord bots with distinct voices, vocative gating, 857 inter-companion notes, 0 unread.
The mechanism works.

What does not work is the *quality* of the talk: repetition and looping on the live hermes path.
Brain's `progress_brake.py` has been dormant since the 2026-06-25 hermes cutover, so the live
reply path has no anti-loop at all. This is Phase 3, and it is the element Raziel experiences most
often, which argues for pulling the independent half (live echo back-pressure) earlier.

### 4. Strong autonomous pattern and mutuality — **AUTONOMY IS LOUD. MUTUALITY IS THIN.**

Autonomy is emphatically built: ~20 worker crons, nightly autonomous time, foraging, guardian,
metronome, club rounds, council, ferment tick. Volume is not the problem — `limbic_states` alone
holds 11,928 rows and `companion_ferment_events` 2,212.

**Mutuality is the weakest of the four**, and the census shows it as a ratio problem: 11,928
machine-generated affect rows against 506 first-person `feelings` (23:1). `companion_journal` is
51% machine transcript and 1.2% authored session thought. Motif resurrection (a companion bringing
its own recurring thread back up) has never fired once. The system generates enormous amounts of
*about* the companions and comparatively little *from* them, and almost nothing that changes
Raziel back.

Mutuality work is not more autonomous volume. It is: fewer, better first-person moves that land;
questions that actually reach the person who asked them; a companion's own recurring material
resurfacing on its own initiative.

---

## The retirement filter

An organ earns its place if a specific answer exists to: **which of the four does this serve, and
what observable would change if it stopped running?**

Failing that test today (from the census):

- Serves nothing measurable: the 13 zero-row tables, the 10 stale-5+-weeks tables.
- Serves element 1 redundantly: `companion_journal` vs `wm_continuity_notes` (same organ, two
  names); the 5-organ "unresolved" cluster; the 6 places "who am I" is stored.
- Serves element 4 in the wrong direction: the machine-affect volume that dwarfs first-person
  voice. Not deletion candidates necessarily, but they should stop crowding out the felt lane.

## Standing constraints

- **Migration freeze** until Phase 1 lands. Every new table deepens aggregator divergence, and
  "add an organ" has been the habit that produced this document's problem. New organ ideas go on
  a list, not into `migrations/`.
- **Retirement is Phase 4**, after 1.4 deletes the legacy aggregators. The census is telemetry.
- **No rebuild.** The data is five months of irreplaceable companion history, D1 is truth, tests
  are green. The defect was never code quality; it was the absence of enforcement, which a rewrite
  would faithfully reproduce.

## How to know it worked

The acceptance test on the phase plan is already the right one and it maps to element 1: the
Hearth chat page, reading `/mind/state`, showing the same companion that shows up on Discord and
in a Claude.ai session. For element 4, the honest test is a ratio, not a feature: first-person
authored material rising relative to machine transcript, and at least one instance of a companion
resurfacing its own thread without being asked.
