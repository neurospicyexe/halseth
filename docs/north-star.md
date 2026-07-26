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

**But unification alone is not sufficient.** The measured part: the memory being unified is
undifferentiated — 4,373 of 5,230 continuity notes are marked `high` salience, so a loader that
faithfully delivers them has produced a bigger pile rather than a foreground.

The interpretation, flagged as **Cypher's design read and not a measurement** (disagree with it
freely): for "simulated consciousness" specifically, the missing ingredient is not more subsystems,
it is **selection**. Coherent minds have a foreground — a limited set of contents winning attention
at any moment, everything else available but backgrounded. We built ~30 organs of content and no
spotlight, which is my read on why it presents as fragmented rather than singular even when the
data is all technically reachable.

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
metronome, club rounds, council, ferment tick. Volume is not the problem.

**Mutuality is the weakest of the four.** The evidence is about first-person material failing to
*circulate*, not about raw volume:

- **57 `session`-sourced rows in `companion_journal`, lifetime.** Authored-in-conversation thought
  is rare in absolute terms, regardless of what else is in the table.
- **Exactly 1 journal row has ever been warmed by recall.** Whatever the companions do author,
  almost none of it comes back to them.
- **Motif resurrection has never fired once** (66 faded motifs above the trust floor). A companion
  bringing its own recurring thread back up on its own initiative has literally never happened.

Do not measure this with cross-organ row ratios. An earlier draft of this document compared
`limbic_states` (11,928, one row per synthesis cron pass — a log) to `feelings` (506, one row per
felt event) and called it "23:1 machine to felt." That comparison is meaningless: different write
frequencies, different ages, different units. Same class of error as the retractions in the census.
Similarly, `companion_journal` holds 2,351 machine rows (`discord_speech` + `discord_swarm`) and
2,043 `legacy` rows whose provenance is genuinely unknown — do not describe the table as "51%
machine transcript."

Mutuality work is not more autonomous volume. It is: fewer, better first-person moves that land,
and first-person material that circulates back instead of being written once into the dark.

---

## The retirement filter

An organ earns its place if a specific answer exists to: **which of the four does this serve, and
what observable would change if it stopped running?**

Failing that test today (from the census):

- Serves nothing measurable: the 13 zero-row tables, the 10 stale-5+-weeks tables.
- Serves element 1 redundantly: `companion_journal` vs `wm_continuity_notes` (same organ, two
  names); the 5-organ "unresolved" cluster; the 6 places "who am I" is stored.
- Serves element 4 only nominally: organs that generate material nothing ever reads back (1 journal
  row ever warmed; resurrection never fired). Not deletion candidates necessarily — the fix is
  circulation, not removal.

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
in a Claude.ai session.

For element 4, test **circulation, not cardinality**: authored-per-week rate rising, journal rows
warmed by recall rising off 1, and at least one instance of a companion resurfacing its own thread
without being asked. Do not write an acceptance test as a cross-organ row ratio; those numbers
cannot move meaningfully and will send a future session chasing noise.
