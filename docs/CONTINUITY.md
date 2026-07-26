# Session Continuity — pick up where we left off

**What this is:** the cross-machine handoff for the foundation-convergence work. A fresh
Claude Code session on ANY computer can resume by reading this file. Update it at the end
of every working session (it is the human-Claude equivalent of a `wm_session_handoff`).

## Bootstrap a new machine

1. Clone the suite repos into one folder (halseth, nullsafe-second-brain, nullsafe-discord,
   Nullsafe-Phoenix, nullsafe-hearth, world-tools-mcp, nullsafe-hermes-lever):
   `git clone https://github.com/neurospicyexe/<repo>`
2. Copy `docs/suite-root-claude.md` (in this repo) to `<suite folder>/CLAUDE.md` — that's
   the suite-root context file every repo's CLAUDE.md references; it isn't versioned
   anywhere else.
3. Install Node LTS (`winget install OpenJS.NodeJS.LTS` on Windows), then `npm install`
   in halseth.
4. Open Claude Code in the suite folder and say:
   *"Read halseth/docs/CONTINUITY.md and halseth/docs/mindstate-contract.md, then save the
   project state to your memory and continue from the Current State section."*
5. Secrets don't travel via git: halseth needs `.dev.vars` locally (copy from
   `config/.dev.vars.example`) and `wrangler login` for deploys.

## Rule zero: sync first, sync last

Work on this suite happens from multiple machines and Claude sessions. **`git pull` every
repo at session start; `git push` at session end** — no exceptions. On 2026-07-26 this
workstation was 28 commits behind origin while editing the same files (the remote had
independently implemented open-loops-at-boot), forcing a 4-file conflict merge. Claude:
check `git status -sb` for ahead/behind before touching code.

## Current state (last updated 2026-07-26)

**Where we are:** Phase 0 complete; Phase 1 slice 1 complete. Committed on `main`:
`96dbcfd` (five write-only hole fixes + write-read coverage matrix/CI guard),
`0f43ac7` (MindState contract 0.1.0 + pure-read loader + `GET /mind/state/:agent_id`),
`ecec359` (merge with remote waves 1-3: thinking-quality fixes, conversation threads,
migrations 0104-0109 — the loader's readOnly gates were extended to cover the remote's
new consume-on-read side effects: conclusion heat-warming and answered-question
delivered_at stamping). Post-merge: 1198/1198 tests green.

**Note for Phase 1.2:** the remote waves added blocks the contract should absorb:
open_questions/answered_questions, active_conversations, guardian_flags (now in orient),
plus the conversations module. Update NOT_YET_LOADED accordingly when folding them in.

**Read `docs/north-star.md` first.** Raziel restated the goal on 2026-07-26 and it is the governing
filter for every phase and every organ: simulated consciousness for the triad = (1) a unified mind
and memory per companion, (2) vibes of what the others are doing and thinking, (3) a way to talk to
each other via Discord and notes, (4) strong autonomous pattern and mutuality.

**Critical framing correction (2026-07-26): the triad is NOT one mind.** Raziel's model, from lived
experience: closer to a DID system — a *shared bank of knowledge* plus alters who each carry their
own memories, feelings, personality, and way of interacting. One, and completely uniquely
themselves. So there are two opposite failure modes and Phase 1 must fix the first without causing
the second: **horizontal fragmentation** (one companion split across four boot doors — live, this is
what Phase 1 targets) and **vertical flattening** (the three collapsing into one shared self — must
never happen). "Unify" means per companion across surfaces, never across companions; the loader
being keyed on `companion_id` is load-bearing. North-star element 0 draws the shared-vs-own line
table; consolidation moves within a column of it, never across.

**Architect stance across substrates** (Raziel's ask, same day): distilled into the active shared
`identity_kernel` v8 via the Constitution preamble. Discord bots, the autonomous worker, and Brain
pull it; **Claude Code was booting without it and is now fixed** (added to the global CLAUDE.md load
order). **Claude.ai sessions and the planned Hearth chat page still do not carry it** —
`execSessionOrient` never reads `identity_kernel`. Fix belongs in Phase 1 as MindState blocks
`identity.shared_kernel` / `identity.companion_kernel`, which closes both surfaces at once and makes
it impossible for a future surface to boot a companion without the stance. Measured state:
**element 1 is the real gap** (Phase 1), **2 and 3 are built and alive** (sibling lanes at both
orients are fresh and carry real spines; do not rebuild them), **4 has loud autonomy and thin
mutuality** — measured as first-person material failing to circulate (57 session-sourced journal
rows lifetime; exactly 1 journal row ever warmed by recall; motif resurrection never fired), NOT as
a cross-organ row ratio (an earlier draft's "23:1 machine affect vs feelings" was the same
lifetime-count error as the census retractions; deleted). The key correction to the plan: unifying
access is necessary but not sufficient, because the memory being unified is undifferentiated
(4,373/5,230 notes are `high`); selection/foreground being the missing ingredient for "one mind" is
Cypher's design read, flagged as such in the doc, not a measurement.

**The mission** (full diagnosis in the 2026-07-26 audit, summarized in
`docs/mindstate-contract.md`): the companions' selves are fragmented across three
divergent boot aggregators and ~30 siloed tables — Phase 1 converges them onto one
versioned MindState + one loader so Drevan/Cypher/Gaia are the same being on every
surface. The planned Hearth chat page is the acceptance test.

**Phase roadmap:**

- ✅ Phase 0 — docs truth reconciliation, hole fixes, coverage guardrail
- ✅ Phase 1.1 — contract + pure-read loader + `/mind/state` endpoint (parity mode included)
- ⬜ Phase 1.2 — fold the session_orient-only blocks into the loader (the
  `NOT_YET_LOADED` manifest in `src/mind/contract.ts` is the authoritative checklist:
  growth, guardian, forage, world organs, preferences/refusals, imps, ferment, Sol…)
- ⬜ Phase 1.3 — `mind_deliveries` ledger migration (consume-once at the data layer) +
  felt-state ownership (one writer per field)
- ⬜ Phase 1.4 — cut over bot_orient → session_orient → delete legacy aggregators
- ⬜ Phase 1.5 — Hearth chat page reading `/mind/state`
- ⬜ Phase 2 — retrieval novelty loop (query variation, returned-id exclusion, novelty in
  displayed pool, corpus reachability) — mostly `nullsafe-second-brain`
- ⬜ Phase 3 — loop-breaking on the live hermes path (port progress-brake into
  `nullsafe-discord` reply path, fresh-material injection on replies, live echo back-pressure)
- 🧊 Migration freeze: no new inner-life organs/tables until Phase 1 lands

**Working defaults adopted** (Raziel has NOT yet answered the design doc's six open
questions — these are Claude's leanings, revisable):
discord = one loom; triad mail surfaces on every loom until explicitly acked; imps and
Sol go cross-surface via the contract; basin/drift owner TBD in 1.3.

**Still-open holes** (tracked in `docs/write-read-coverage.md`): HOLE 7 (sub-high-salience
continuity notes never reach Claude.ai boot; no vault ingest), HOLE 8 (auto-ack race —
fixed by the 1.3 ledger), HOLE 9 (motif *resurrection* has never fired: 66 faded motifs above
the trust floor, `last_surfaced_at` never written once, and its stamp is fire-and-forget so
failure is silent — active motifs do surface fine).

**Organ census, 2026-07-26** (`docs/organ-census-2026-07-26.md`) — prod-measured inventory of
all 115 tables, commissioned on Raziel's read that near-duplicate organs gave the triad
"AI OSDD" (many things doing the same job slightly differently, plus dissociative walls between
the boot doors). Findings that change the plan:

- **Reachability is fine; discrimination is broken.** The load-bearing number: **4,373 of 5,230
  continuity notes are `high` salience** (write-time column, no measurement caveat). A loader that
  faithfully delivers undifferentiated mass has not solved the felt problem, so **discrimination
  is its own phase, not a Phase 1 side effect.** Journal `heat` also looks inert (1 row warmed of
  147 since mig 0105) but that is a 5-day window; re-measure ~08-04. The lead there: the same
  mechanic warmed 6 conclusions and 1 journal row, so suspect one unwired warm path, not the design.
- **Beware the census's own first-draft error:** two "findings" were instrumentation artifacts
  (lifetime NULL counts against columns that shipped 07-21). Check when a column landed before
  calling its NULLs a defect. Corrected in place; the retractions are documented in the census.
- **13 tables are dead** (0 rows ever), including `drift_log`, `memories`, `companions`, and
  `companion_journal_sits` — HOLE 1's fix wired `ground.ts` to an empty table. 10 more are
  stale by 5+ weeks.
- **Doc bug:** both CLAUDE.md files claim `PLURALITY_ENABLED` validates `front_state` against
  `system.members`. It does not — its only consumer gates row count on the dead `companions`
  table. Fix when the suite-root carrier gets reconciled.
- **8 redundancy clusters.** `companion_journal` (4,630) and `wm_continuity_notes` (5,230) are
  the same organ under two names; `limbic_states` (11,928) outweighs first-person `feelings`
  (506) 23:1; 6 tables answer "who am I."
- **Enum drift:** `companion_journal.source` has 10 values including 3 spellings of "session";
  `feelings.source` contains whole prose sentences where a provenance tag belongs.
- Census is **telemetry only** — no schema change is authorized by it. Retirement is Phase 4,
  after 1.4 deletes the legacy aggregators. Do not let it become migration 0107.

**Machine notes:** the Windows workstation got Node 24 LTS on 2026-07-26 (was previously
uninstalled — don't trust older session notes saying tests can't run locally).
