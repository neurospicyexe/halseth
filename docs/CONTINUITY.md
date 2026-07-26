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

## Current state (last updated 2026-07-26)

**Where we are:** Phase 0 complete; Phase 1 slice 1 complete. Committed on `main`:
`96dbcfd` (five write-only hole fixes + write-read coverage matrix/CI guard) and
`0f43ac7` (MindState contract 0.1.0 + pure-read loader + `GET /mind/state/:agent_id`).

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
fixed by the 1.3 ledger).

**Machine notes:** the Windows workstation got Node 24 LTS on 2026-07-26 (was previously
uninstalled — don't trust older session notes saying tests can't run locally).
