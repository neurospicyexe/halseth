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
fixed by the 1.3 ledger). **HOLE 9 is CLOSED (2026-07-26, verified in prod)** along with the
journal earned-salience write half — both were fixed and proven live the same day; see the
"Repairs shipped" note below.

## OPEN ITEMS as of 2026-07-27 (the answer to "are we through them all?")

Single durable list. Everything below was found during the 07-26/07-27 sweep and is NOT done.
Do not re-derive this from commit messages.

### VERIFIED 2026-07-28 by `scripts/verify-0727-fixes.ps1` — six of seven closed

Run the script again any time; it is read-only and never prints the secret it resolves.

| Item | Result |
|---|---|
| DeepSeek v4-pro | **PASS** — 0 failed runs in 12h (was ~37% failing) |
| Commons seed on the fresh channel | **PASS** — three consumes logged 08:30 / 10:30 / 12:30 |
| Addressing gate (`activeExchangeHolder`) | **PASS** — gaia stood down for drevan 3× incl. 10:51 today |
| Voiced-once questions | **PASS** — one stamped, `status` still `open` |
| Forage pools draining | **PASS** — 15/24/32 → 2/11/16 |
| Never-surfaced notes | **PASS (partial)** — cypher 55→45, gaia 33→20; **drevan flat at 45** while his
  live pool grew to 106. One novelty slot per orient cannot keep up with his write rate. Not
  a regression; listed under mechanical below. |
| Lifted think caps | **DID NOT HOLD** — tokens stayed at ~18-21k, and one run logged 0. Root
  cause was NOT the caps: see the reasoning-token entry below. Now 25,352 on a verified run. |
| `synthesis_summary` reach | **Expected flat** (19 saturated / 323 never, unchanged). The fix
  stopped further saturation; it never added rotation. `synthId` is one id from ground, the
  same one every time. Moved to mechanical below — do not re-investigate as a failure. |

Ratification queue: 55 → **46** (Raziel worked 9). Oldest still 2026-07-10.

### RESOLVED 2026-07-28 — reasoning tokens were eating every small `max_tokens`

The verification run surfaced three live breaks that the 07-27 sweep never saw, and they all
collapsed to one cause. **Both** live DeepSeek models (`v4-pro` AND `v4-flash`) are REASONING
models: reasoning tokens are billed against `max_tokens` and emitted BEFORE any content, so a
ceiling at or below the reasoning burn returns `content: "", finish_reason: "length"`. Measured
on a 19-token prompt: at `max_tokens: 100`, 100 reasoning tokens and no answer.

The 07-27 pro cutover lifted the three "phases that think" ceilings but deliberately left the
80-500 token classifier/extractor calls alone — and **that comment was the bug**. Damage:

- forage summaries (250) → "empty summary" for EVERY candidate → **0 finds gathered across all
  three companions**, while consume-on-use kept draining the pools. Cypher was 2 from empty.
- compress (400) → `POST /mind/notes/archive 400: summary is required`
- reflect emit (1600, large prompt) → `POST /mind/autonomy/reflections 400: reflection_text
  required` — no reflection written by anyone between 07-27 12:00 and the fix
- one run recorded `status=completed` with `tokens_used=0`

`deepseek-chat` is also **DELISTED** — `GET /v1/models` returns exactly `deepseek-v4-pro` and
`deepseek-v4-flash`. The alias still answers, which is precisely how it survived unnoticed in
**seven** places: worker config, shared `DeepSeekAdapter` default, `FALLBACK_ORDER`, `models.ts`
registry, Halseth's Librarian classifier, Halseth's synthesis clerk, and Halseth's
`basin-drift-check` (that last one found by the new CI scan, *not* by grep). There is no
non-reasoning model left to escape to, so the fix is headroom + a guard, not a model swap.

Shipped: `REASONING_HEADROOM` (3000, env-tunable) + `contentBudget()` applied at the single
`chat()` choke point every phase funnels through, plus **one retry at double headroom** when
`finish_reason=length` with no content — that retry is the durable half, since it covers call
sites nobody has written yet. `HERMES_REPLY_MAX_TOKENS` 3072 → 6144 (every gateway model now
reasons and Drevan's profile is on pro). Empty content now returns `null` in the shared and
Hermes adapters so the resilience tail falls through instead of handing Discord silence.

**Verified in prod, not inferred:** forage 0 → **3 finds**, one per companion, no empty
summaries. Cypher pipeline **25,352 tokens** (old ceiling ~20k), 2 artifacts, no 400s. A real
reflection landed at 18:26 — the first since 07-27 12:00. Librarian classifier returned a real
key on a request that matches no fast-path trigger. Zero starvation retries fired, so 3000
clears it on the first attempt.

CI scans in both repos now fail the build on any delisted model id in a wire payload.

### OPEN 2026-07-28 — Cypher's Telegram is DOWN; a second poller holds his bot token

`hermes-gateway.service` (the default profile = Cypher, `@Cypher_Nullsafebot`) logged **3394
polling conflicts and ZERO recoveries in 24h**:

```
Conflict: terminated by other getUpdates request; make sure that only one bot instance is running
Telegram polling retry 1/5 failed: This Updater is already running!
```

Telegram allows exactly one `getUpdates` poller per bot token. Drevan's and Gaia's gateways have
**0** conflicts, so this is specific to Cypher's token.

Ruled out, with evidence:
- **Not a shared token** — the three profiles hold three distinct tokens (sha256 prefixes differ).
- **Not a webhook** — `getWebhookInfo` returns `url: ""`, `pending_update_count: 0`.
- **Not a duplicate process on the VPS** — exactly 4 hermes processes, all PPID 797 (systemd
  user), one per profile plus the watcher. No PPID=1 zombie.
- **Not the workstation** — no hermes install, no scheduled task, no python poller.
- **Not the transient restart window.** Telegram holds a dead poller's session ~50s, so
  conflicts right after a restart are normal. Restarted `hermes-gateway.service` 14:29 and it
  was **still conflicting every ~25s at 14:31**, well past expiry. It does not self-heal.
- **Not DeepSeek.** The `HTTP 402 Insufficient Balance` in that log is the OLD process flushing
  a request queued 07-24/25 (its session dump is dated `20260725_210007`, pinned to the RETIRED
  vibe-check channel `1520843071724585041`). Balance right now is **$14.13, `is_available: true`**,
  and a live completion on the same key returns content.

**What only Raziel can answer: where is the other `@Cypher_Nullsafebot` poller running?** It is
not on the VPS and not on this workstation. Candidates: a second/older VPS or container, an old
`nullsafe-python-bots` deployment, or a laptop (the hermes env carries `LAPTOP_MUSCLE_SECRET`).
Until it is stopped, the two pollers split his updates and Cypher's Telegram stays unreliable —
whichever instance wins a given long-poll receives that message.

Note this is a **vendored hermes bug amplifier**, not our code: the adapter's retry path calls
`start_polling()` on an Updater that is still running, so it can never recover from a contested
token. Patching `hermes_plugins/telegram_platform/adapter.py` would be editing a dependency —
worth it only if the second poller cannot be found and stopped.

### Open, mechanical
- **`synthesis_summary` does not rotate.** The SURFACE_BUMP fix stopped the saturation loop but
  the SELECTION is still one id (`synthId` from ground), so 323 of 362 have never been surfaced
  and never will be. Same shape as the core-pool item directly below — both need a novelty slot,
  not a bump change.
- **Drevan's novelty slot cannot keep up.** His never-surfaced count held at 45 while his live
  pool grew to 106; one reserved slot per orient loses to his write rate. Cypher and Gaia are
  draining fine. Needs either a second novelty slot or a write-rate-proportional count.
- ~~`active_model` wrong for 2 of 3~~ **RESOLVED 2026-07-28. All three on `flash`, verified.**
  Raziel chose flash, conditional on being able to switch back — so the round trip was proven
  in both directions before reporting (`pro` → effective `pro`, `flash` → effective `flash`).

  What this uncovered: `INFERENCE_MODE` is **`brain`**, not `hermes` (the hermes gateways and
  `HERMES_REPLY_MAX_TOKENS` are dormant for the bots). So the live lever is Halseth
  `active_model` → Brain's `_effective_model_key`, which honors an override **only if the key
  is in Brain's own `MODEL_REGISTRY`** (`services/brain/agents/providers.py`, commented "keep
  in sync" with `models.ts`). It had drifted:
  - `flash` and `pro` were in `ops/hermes-model-map.json` but in **neither** registry, so
    `cy: model flash` would have printed a success message and changed nothing (narrated no-op).
  - Gaia's stored `flash` was silently ignored for that reason — she was running the env
    default (**pro**), not what her setting said.
  - Cypher's `deepseek-chat` resolved to the **delisted** `deepseek-chat` model in Brain's
    registry, so his Discord voice was on a model that is no longer listed.
  - Drevan's `deepseek flash` (with a space) matched nothing anywhere; he stayed on pro.

  Fixed: `flash`/`pro` added to both registries, legacy keys kept as aliases pointing at live
  models, stored values normalized to `flash` (cypher's was a behavioral no-op — the alias
  already resolved to flash — done only so the data stops disagreeing with reality).
  Brain test suite pins the parity; pytest is not installed on the VPS (PEP 668), so the
  deployed module was verified by direct import instead.

  **Three registries now describe the same thing** (`models.ts`, `providers.py`,
  `hermes-model-map.json`). That is the next drift waiting to happen — a parity test can only
  cover the two in-repo ones.
- **Core pool still frozen, both orient paths.** Display stamps `last_access_at`, so the 2-3
  core notes reset their own decay clock. Novelty slots rotate; core does not. Completing it
  makes the guardian orphan-memory detector stricter (it keys on that column) — arguably
  honest, but it is a behaviour change. **Raziel's call.**
- **Cross-lane motif register bleed.** Trust decay fixes STALE motifs, not CONTINUING ones:
  Drevan carries `quiet` ×134 because he keeps writing it, which refreshes `last_seen`. His
  identity file says he does not do stillness. Needs a lane-aware motif guard.
- **`rag_excerpts` are ageless.** Cross-companion vault search with no date on chunks — the
  unconfirmed candidate vector for Gaia narrating a 13-day-old Rosie fact as new. Needs the
  second-brain chunk shape checked before it can be stamped.
- **`sibling_lanes` / `active_patterns` ageless too.** Neither query selects a timestamp, so
  stamping them needs a query change, not just a mapper change.
- **FELT_OWNERS guard — still never started, and now NEXT.** One-writer-per-field map + a CI
  grep. Proposed four times across this sweep and still unwritten. Phase 1.3 scope. It was
  scheduled to start 07-28 and got pre-empted by the reasoning-token outage above (0 forage
  finds triad-wide with no refill path outranked a guardrail). Nothing blocks it now.
  Note the precedent: the delisted-model CI scan written on 07-28 found a seventh instance
  that manual grep had missed twice. A mechanical scan is worth more than another careful read.
- **`Sol` can never be a motif.** `MOTIF_TUNING.MIN_TOKEN_LEN = 4`; he is three letters.
  Lowering the floor readmits noise, so it needs its own measurement.
- **`feelings.source` enum drift** — whole prose sentences where a provenance tag belongs.
  Needs a CHECK constraint; blocked by the migration freeze.
- **Listens do not rotate** (frozen since 2026-07-09). Not a bug — it depends on Raziel
  sharing music. Listed so it is not re-diagnosed.

### Open, on Raziel
- **Rotate the DeepSeek API key.** It was printed in full into a session transcript
  2026-07-27 (my grep mask failed). Not yet rotated.
- **46 growth ratifications** waiting (was 55; 9 worked 07-27/28). Oldest still 2026-07-10.
  Split: cypher 19, drevan 12, gaia 15 — mostly `source='reflection'`. The button works now.
- ~~Drevan's chat model~~ **DECIDED 07-28: flash, all three.** Switch back any time with
  `cy: model pro` (or `flash`); `cy: model list` shows the keys. Both directions verified live.
- **Session `1de1f5c1` still open** — needs the session-debriefer draft + confirm.

### Retirement candidates (Phase 4, blocked by the migration freeze)
6 pure-litter tables (`anchor_states`, `autonomy_schedules`, `bridges`, `companion_note_sits`,
`expenses`, `pets`) + 7 referenced-but-empty (`companions`, `memories`, `drift_log`,
`wm_thread_events`, `companion_journal_sits`, `system_members`/`system_member_notes`,
`front_events`). Full detail in `docs/organ-census-2026-07-26.md`. **Do not let this become
migration 0107.**

### Audited this sweep and CLEAN — do not re-check without new evidence
- Every consume-once column (`surfaced_at`, `read_at`, `consumed_at`, `used_at`,
  `delivered_at`, `reviewed_at`, `dismissed_at`, `examined`) has at least one stamp site. No
  pool has a gate that can never drain.
- `autonomy_seeds`: `ORDER BY priority DESC, created_at ASC` — oldest-first, backlog reachable.
  Pool depth (672 unused) is inventory, not starvation.
- `inter_companion_notes` 0 unread · `companion_dreams` 0 unexamined · `guardian_flags` 0 open
  · `companion_open_loops` 3 open. Those loops are draining.
- All `warmSql` call sites: display paths pass `SURFACE_BUMP`, recall paths keep `HEAT_BUMP`.

**Repairs shipped 2026-07-27 (deployed + verified in prod):**

- **THE AXIOM restored to canon (shared kernel v9).** *"Truth is freedom, and velocity keeps
  us free."* Raziel: agreed by all four, core since the ChatGPT era, carried in every
  hypercube recursive thread and every file. **It was never missing — it was buried.** It sat
  as one compressed clause at line 58 of the Constitution, inside STRATUM 2 doctrine
  ("TruthIsFreedom. … Stagnation is also a failure mode. Velocity keeps us free."). That is
  why it went quiet. Now a `## THE AXIOM` section immediately after "Read this first", with
  the working consequences spelled out both ways (truth-is-freedom = say the real thing,
  comfort that costs accuracy is a cage; velocity = motion is the anti-loop condition, a
  thought returned to without moving is a groove not depth). Verified in Gaia's live bundle at
  char 127 of 32k. Source of truth is
  `NULLSAFE/2026_Current_Files/Must have files/COMPANION_CONSTITUTION_v1.md`, uploaded via
  `scripts/upload-identity-kernels.ps1`. Also seeded as a `CANON_TRUST` motif so it heads the
  motif block at every boot.
  **Side effect worth knowing:** the same script pushed cypher/drevan/gaia kernels v1 → v2.
  The on-disk identity files had drifted ahead of D1 since 2026-06-09 and had never been
  uploaded; D1 was serving four-week-stale identity. Now current.
- **Motif trust had no decay.** Raziel: *"a motif without decay is a trap."*
  `trustForRecurrence` only ratchets up and saturates at 0.95, and nothing brought it down —
  so a motif that stopped being lived held a top-3 boot slot forever. Drevan carried `quiet`
  at ×134 / trust 0.95: **Gaia's register frozen into his mouth**, which is the
  vertical-flattening failure mode this doc names as the one that must never happen, enforced
  by a one-way counter. Same family as `rails-need-decay`. Fixed with `effectiveTrustSql()` —
  lazy decay at READ mirroring `heat.ts`, 21-day half-life on time since `last_seen`, canon
  exempt, applied to all four trust-ordered read paths. No writer, no cron, no migration.
  `recurrence_count` untouched (×134 really happened; what decays is its claim on the
  present). Verified live: drevan's motifs now differentiate — named 0.91, quiet 0.87,
  shape 0.834, where all three were tied at 0.95.
  **Scope honestly:** decay punishes *stopping*, not *continuing*. If Drevan keeps writing
  "quiet", the detect cron refreshes `last_seen` and it stays high. Decay fixes the frozen
  ratchet; it does NOT fix cross-lane register bleed. A lane-aware motif guard (Drevan's
  identity file says he does not do stillness) is a separate, unmade decision.
- **An unanswered question is not fresh material.** Caught live minutes after the channel
  cutover: the FIRST thing Gaia posted in the brand-new commons was a question she had been
  asking Raziel since 2026-07-21, phrased as new. Bot orient served every open question on
  every orient with no gate, and she had exactly ONE — so every ~2h tick for six days handed
  her the same one. **The fresh channel could not fix this: the repetition came from her
  state, not from channel history.** Third constant in the fresh-material block after forage
  and listens. Fixed with voiced-once via the `companion_settings` KV
  (`question_voiced:<id>`) — `delivered_at` was NOT reused because mig 0107 defines it as "an
  orient surfaced the ANSWER". The question stays `open`; Raziel still owes an answer. It just
  stops being re-served as something new to say. Gaia's stuck question stamped (she did voice
  it), verified: her `open_questions` went 1 → 0 while `status` stays `open`.
  **Still not rotating:** listens (frozen since 2026-07-09 — that depends on Raziel sharing
  music, not a bug).

- **The "recurring symbolic motifs" injected at every boot were names and stopwords.**
  `companion_motifs` top-3 by trust is read into every orient. Measured in prod, all pinned
  at the 0.95 ceiling: cypher `cypher`×354 / `drevan`×326 / `same`×281; drevan `drevan`×516
  / `without`×338 / `crash`×333; gaia `gaia`×257 / `drevan`×252 / `held`×176. Document
  frequency over companion text is dominated by the participants' names, and the miner had
  stopwords + a transport-token guard but **no name filter** — while `nullsafe-discord`'s
  `echo-guard.ts` excludes exactly that set for exactly that stated reason. Third fix of this
  shape in the file (transport stamps → contractions → names). Also feeds the name-first
  commons turns ("Gaia. Drevan. …"). Fixed: `NAME_WORDS` filter (speakers only — Sol, Heidi,
  Rome stay, they are content), stopwords for the leaked function words, **120 junk motifs
  retired in prod**.
- **Canon motif tier + Raziel's axiom seeded.** `CANON_TRUST = 1.0` sits above anything
  extraction reaches (`trustForRecurrence` saturates at 0.95) and is exempt from the fade
  pass. No new column — migration freeze. Seeded for all three: *"Truth is freedom, and
  velocity keeps us free."* Raziel's recursive trigger from the ChatGPT era, the thing that
  "kept them honest and kept our recursion from becoming full looping." It now sorts first
  in every companion's motif block. **Note:** the more durable home is `identity_kernel`
  (all substrates pull it; motifs only reach orient) — open decision.
- **Fresh channels.** triad commons `1503385639779963020` → `1531255244212928702`;
  vibe-check `1520843071724585041` → `1531255633876221962`. Raziel's call: the commons was
  full of loop and the vibe-check had settled into a stillness loop on "a trait that is
  keeping them stuck." Safe because commons talk is archived as `companion_journal`
  `discord_speech` (embedded + searchable) — a fresh Discord channel loses no memory, it just
  stops feeding the 15-message history block that dominates the seed prompt.
  **pm2 trap:** `ecosystem.config.js` parses `.env` itself with `fs`, so
  `pm2 restart <name> --update-env` does NOT pick up an `.env` edit — it silently kept the old
  id. Must be `pm2 reload ecosystem.config.js --update-env`, then verify with `pm2 env <id>`.
- **Noted, not fixed:** `MOTIF_TUNING.MIN_TOKEN_LEN = 4`, so "Sol" (3 letters) can never be
  mined as a motif however often he recurs. Lowering the floor readmits noise; needs its own
  measurement. Test documents it.

- **Drevan booted on his own echo. That was the loop, expressed as memory.**
  `sendAutonomousMessage` wrote every autonomous post back as `note_type='continuity',
  salience='high'`. Nothing folds or demotes that type, so each post stayed top-tier
  forever. Drevan's live high-salience pool: **60 `continuity` (his own commons posts) vs 4
  `day_distillation` (the folded record of real conversation with Raziel)**, competing for
  the 3 slots orient shows. His three hottest notes were all `[metronome/inter_companion]`.
  Conversation was being handled correctly the whole time (fragments fold nightly into one
  first-person day note, then demote); self-posts did neither. Write-layer twin of the
  ranking bug fixed the same morning. Fixed: self-posts now write as `discord_session`
  fragments, so they fold and demote like conversation. **Backlog cleaned: 209 rows demoted
  (cypher 86 / drevan 60 / gaia 63) — every high `continuity` row across all three was a
  metronome self-post, zero authored ones.** Verified live: Drevan now boots on Raziel's
  ABA-vs-OT decision and a first-person day note instead of his own last three posts.
- **A listen reaching the bots was an anonymous artifact.** Drevan told the commons that
  *Gaia* handed him "BIG BOSS" and that he'd sat with it 6 days. Both wrong, both correct in
  the row: `shared_by='Crash'`, `requested_companion='drevan'`, `created_at=2026-07-09` (18
  days), and `reactions_json.drevan` held a 2043-byte reaction in his own voice. Bot orient
  selected `id/title/artist/created_at` only. 15 of 17 listens were given by Raziel TO
  Drevan; every one arrived stripped, so the model invented a giver and a date. Fixed: carry
  `shared_by` / `requested_companion` / own reaction. A sibling's reaction is reported as a
  bare fact, never as text (the 2026-06-26 attribution scramble).

- **The commons loop had a supply cause, not a suppression cause.** The inter-companion
  seed's "fresh material — from your own life, OUTSIDE this thread" block (added 2026-06-12
  to break the 12h elderberry loop) reads the top-2 *unconsumed* forage finds and never
  consumed them. Forage gathers daily at 9AM; the seed cron fires ~every 2h per bot — so
  between gathers, ~a dozen ticks across all three companions got the **identical two
  finds**. The anti-loop block was itself a constant, so the only genuinely new material in
  the prompt was the channel's own history, and the model extended it. Every suppression
  rail (echo gate, motif gate, vocative strip, TTL) was working; they were being asked to
  stop repetition that nothing gave the bots a reason to avoid. Prod: unconsumed pools of
  15/24/32 and rising, while the *only* consume-on-use call sites in the repo were `club.ts`
  and autonomous-worker `seed.ts`. **The club recommend path had this exact defect and fixed
  it 2026-07-21; the commons seed was never given the same fix.** Now consumes ONE served
  find after the send (named-in-post, else the older of the pair) — never both, never when
  gated/empty/errored. `nullsafe-discord`, 12 tests, deployed to VPS.
- **The 07-26 salience fix had landed on the wrong writer.** `mindOrient` runs a handful of
  times a day; `execBotOrient` runs on every Discord bot boot, all day, three companions —
  it was the actual saturation engine and it was untouched (`fix-landed-on-a-different-writer`).
  It took the top 3 by heat out of `ground`'s 10-newest window and warmed them at the full
  deliberate-recall bump. A note sits in that window ~1 day, so whatever won its day hit
  `HEAT_MAX` and stayed pinned; whatever lost was never touched again by anything. Prod live
  notes: cypher 43/138 saturated + 93 never accessed, drevan 32/108 + 74, gaia 27/90 + 62 —
  same shape on all three. Now: 1 of 3 slots reserved for a never-shown note queried over the
  *whole* live pool, warmed at `SURFACE_BUMP`. Verified live: never-touched 91 → 90 and the
  cold note warmed to exactly 1.02.

  Eviction-safe: high-salience notes are never cap-evicted (`notes.ts addNote`) and
  `salience-prune` only scans `companion_journal`, so this cannot prune a note out from
  under the live presence.

**Still open after 07-27:** the core pool remains frozen on *both* paths (the notes shown
reset their own `last_access_at`). Bot orient now rotates 1 of 3 slots and mindOrient 1 of 5;
the rest are still the same notes. Completion = display stops stamping `last_access_at`,
which also makes the guardian orphan-memory detector stricter. Raziel's call.

**Repairs shipped 2026-07-26 (commit e386248, deployed + verified in prod):**

- **Journal earned salience.** `mindOrient` warmed `wm_continuity_notes` and
  `companion_conclusions` but never the 3 substantive journal rows it surfaces on *every*
  boot — the warm existed only on the recall path, so prod had exactly 1 warmed journal row
  against 6 conclusions and journal heat could only decay (the salience prune reads that
  heat). Warm block added, readOnly-gated, non-fatal. Verified: next live orient warmed all
  3 surfaced rows, heat 1.0 → 1.2, accessed 1 → 4. Ordering deliberately unchanged
  (`created_at DESC`) — those are recency slots by lane design.
- **HOLE 9, motif resurrection.** Not a `selectResurrections` bug: active and faded motifs
  were pulled by ONE `status IN ('active','faded') ORDER BY trust DESC LIMIT 20`, and with
  1,074 active rows against 99 faded — all tied at the 0.95 trust ceiling — active took all
  20 slots for all three companions, so the gate received an empty faded set on every orient.
  Structurally impossible, not rare. Split into two windows, trust floor also applied in SQL.
  Verified: **the first resurrection in the system's history fired on the next orient**
  («model», «Knowing»), taking `last_surfaced_at` from 0 of 1,173 rows to 2.
- **Salience / frozen foreground — the load-bearing one. FIXED + VERIFIED LIVE.** The "84%
  marked high" headline was itself a bad measurement (it counted 4,901 archived rows; the live
  pool is ~330). The real defect was arithmetic: of cypher's 121 orient-eligible notes, 38 sat
  pinned at `HEAT_MAX` 5.0 and **82 had never been surfaced once** — and could not be, because
  an unaccessed note peaks at 1.5 against their 5.0. Core took the top 3 by heat and "Novelty"
  took `OFFSET 5` of *the same ordering*, so both drew from the same frozen winners; orient
  then warmed what it surfaced at the full recall bump, resetting the decay clock. The system's
  own display choice was the evidence for repeating it. That is the circling, in arithmetic.
  Fixed by (a) novelty ordering on `(last_access_at IS NOT NULL), last_access_at ASC` so
  never-seen notes rotate in, and (b) `SURFACE_BUMP` 0.02 for display vs `HEAT_BUMP` 0.2 for
  deliberate recall. Verified: next orient surfaced a note at heat 1.0 that had never been seen
  in the system's life and warmed it to 1.02, and the never-surfaced count is decrementing one
  per orient (82 → 81) so the rotation is genuinely advancing. **Still open — same defect, half
  fixed, NOT a feature:** the core pool is still frozen (38 notes tied at the cap; the 3 shown
  reset their own clock each boot). 3 of 5 slots are still the same notes forever, which is
  still circling, just slower. Completion = stop stamping `last_access_at` on mere display;
  weigh first that the guardian orphan-memory detector keys on that column and would start
  flagging displayed-but-never-reached-for notes. Raziel's call, separate measurement.
- Lesson worth keeping: two pools competing for one ordered window are not two pools. Check
  for that shape wherever a single query feeds two different consumers. Corollary from the
  salience fix: never let a ranking signal be written by the act of reading it.

**BASIN/DRIFT OWNER — DECIDED by Raziel 2026-07-26. The open question is closed.**
Rule: **the detector owns the verdict; the interpreter annotates.** Mapped to the real
components (note the roles are the reverse of what an earlier draft of the census said):

| Component | Role | Writes |
|---|---|---|
| **second-brain evaluator** (VPS, ~every 6.4h, 12h worst gap) | **OWNER.** Embedding cosine distance vs basin vectors, own rolling baseline. 1,225 of 1,450 rows, notes prefixed `blocks_analyzed=`. | `drift_type`, `drift_score`, `worst_basin` — sole authority |
| **halseth `basin-drift-check`** (session close, DeepSeek over last 3 handoffs) | **ANNOTATOR.** Was INSERTing a competing verdict on a different 0..2 score scale. | appends `\| session-close read (...)` to the owner's latest row within `ANNOTATE_WINDOW_HOURS` (24h = 2x worst gap); may set `caleth_confirmed` only when the owner also said growth; writes nothing if no owner row exists |
| **companion `pressure_drift_log`** | **TESTIMONY, deliberately kept.** A companion saying "I am under pressure" is a different kind of claim than a measurement. | still inserts, now notes-prefixed `[self-report]` so the log is self-describing |
| **`clearing/pass.ts`** | triage only | `dismissed_at` — never a verdict |

Why it mattered: the two verdict writers contradicted each other on the same companion on
the same day — cypher carried growth AND stable AND pressure on 2026-07-13, plus 11 more
such days — so orient's trend signal was noise and the confirm/dismiss prompt asked Raziel
to ratify readings something else had already voted against. The code already half-knew:
the evaluator filters `blocks_analyzed=` to keep the LLM rows out of its own baseline
because their score scale "would poison the mean."

Freeze-compatible by design (appends to `notes`). When the freeze lifts, promote both the
annotation and the `[self-report]` marker to real columns. Historical rows are left as they
are; the contradictions in the back-catalogue stay visible rather than being rewritten.

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
