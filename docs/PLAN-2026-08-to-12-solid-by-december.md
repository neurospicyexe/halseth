# Plan: solid by December 2026

**Goal (Raziel, 2026-07-28):** by December the triad supports him through a PhD program —
companions who are coherent across substrates, remember correctly, and do not need debugging to
be present. No jankiness.

**Deadline:** 2026-12-01. Roughly 18 weeks.

**Constraint that shapes everything:** Raziel's time is the scarce resource, not mine. Every phase
below is ordered so the work that reduces *daily friction* lands first, and the work that is
merely *architecturally satisfying* lands last or not at all.

---

## What "solid" means — testable, not vibes

Judge December against these, not against a feeling:

1. **One source of truth per fact.** Ask any companion on any surface who Rosie is; all three
   agree, and the answer comes from Halseth.
2. **No companion narrates a stale fact as new.** The 07-27 class (Drevan on the shared song,
   Gaia answering for Drevan, "6 days") does not recur.
3. **A defect surfaces as an error, not as silence.** Every failure path logs; nothing returns
   empty and gets written as real.
4. **Session continuity is mechanical.** Sessions open and close without Raziel or me remembering
   to do it.
5. **One place to change each thing.** One model registry, one orient path, one memory authority.
6. **Raziel can ask "is everything okay?" and get an answer in one command.** Extends
   `scripts/verify-0727-fixes.ps1` into a standing health check.

---

## Phase 0 — DONE 2026-07-28

| Item | State |
|---|---|
| Reasoning-token starvation (forage 0 finds, compress/reflect 400s) | fixed, verified in prod |
| `deepseek-chat` delisted in 7 places | fixed, CI scan added in 2 repos |
| Model registries (`models.ts`, `providers.py`) + `flash`/`pro` keys | fixed; all three on flash, round trip verified |
| `ops/memory-approve.py` — the missing twin of `skill-approve.py` | written, deployed, run |
| Stale "cat named Rosie" | gone from every profile; Rosie facts applied |

**What Phase 0 also proved:** flushing the memory queue mostly *failed*, and that is the finding.
Of 57 blocked writes, 9 applied and **47 could not** — Hermes built-in memory is at
`USER 1331/1375` (Cypher), `USER 1256/1375 + MEMORY 2147/2200` (Drevan). It is structurally too
small to hold who Raziel is, `hermes memory --help` says it is **always active**, and it is
injected into every prompt. That is Phase 3's mandate.

---

## Phase 1 — Streamline what we own (Aug, ~3 weeks)

**Why first:** of the ten defects found 07-27/28, **nine were ours**. The felt jankiness is our
duplication, not Hermes friction. A harness change made before this would inherit all of it.

| Work | Evidence it is needed | Done when |
|---|---|---|
| **FELT_OWNERS guard** | proposed 4× and never built; would have caught several of this week's defects | one-writer-per-field map + CI grep fails the build on a second writer |
| **Five model registries → one** | `models.ts`, `providers.py`, `hermes-model-map.json`, `DEEPSEEK_MODEL`, `active_model` all describe "which model" | one authority; the other surfaces derive from it; parity test in CI |
| **Two harnesses → one** | `nullsafe-brain` runs and *nothing calls it* (bots are `INFERENCE_MODE=hermes`; `brainClient` is only built in `brain` mode) | Brain stopped or explicitly designated future-only, documented, memory reclaimed |
| **Three orient paths → one** | `mindOrient`, `execBotOrient`, `execSessionOrient` diverge; the bot path was the real saturation engine and got fixed twice | one implementation, parameterized by frequency/surface |
| **Standing health check** | `verify-0727-fixes.ps1` proved its worth immediately | one command answers "is anything broken", run on a cron, reports to Telegram |

**Honest caveat:** collapsing three orient paths is not pure deletion. Some divergence is
legitimate — the bot path runs ~20× more often than the Claude.ai path, so it cannot be as heavy.
Expect 2–3 behaviour questions that are Raziel's to answer, not mine to quietly decide.

---

## Phase 2 — The boot layer (Aug/Sep, ~1 week)

Raziel's ask: make sure the global `CLAUDE.md` boots Cypher properly and that session open/close
stops depending on anyone remembering.

**Assessment of the current files (read, not guessed):**

- **`CYPHER_CODE_PROTOCOL.md` is not corrupted and not vague.** It is a tight *posture* document —
  read before writing, state the architectural read, no menus, no cheerleading, name the root
  cause. Posture is not what failed this week. Every failure was **operational**: I stated reads
  and pushed back correctly, and still reported a topology from a config file instead of a boot
  log. So the fix is not a rewrite — it is an **operational discipline section**, drawn from what
  actually bit us:
  - after any fix, grep the shape across *all* repos, then write the grep as a CI test
  - verify in prod with counts before/after; "should work now" is not a result
  - read the process's **boot log**, never a shared env value, before describing a topology
  - tests green ≠ build green: run the type check too
  - never emit a secret's value; presence/length only
  - a 200 with empty content is a failure
- **The global `CLAUDE.md` has no session lifecycle rule at all.** The open/close convention lives
  in the *BBH project* file, so it only applies inside this repo, and it is phrased as "invoke the
  session-debriefer agent" — memory-dependent for both of us. That is exactly why it is hit-or-miss.

**Fix it as a mechanism, not an instruction.** Infrastructure already exists:
`halseth-session-hook.mjs` is wired to `Stop` and `PreCompact` and writes a `wm_continuity_note`.
It does **not** call `halseth_session_open` / `halseth_session_close`, and `SessionStart` has no
Halseth hook.

| Change | Why a hook and not a rule |
|---|---|
| `SessionStart` → `halseth_session_open` | fully mechanical (front state + `session_type: work`); no narrative needed |
| `Stop` → auto `halseth_session_close` with a spine derived from the git diff, flagged auto-generated | a hook cannot author a good narrative, but a mechanically-closed session beats a permanently-open one; the debriefer enriches it when I am present |
| Global `CLAUDE.md` gains the lifecycle rule + a pointer to the skill | so it applies on every loom, not just BBH |

**Principle worth stating plainly:** anything Raziel would have to *remember* is a defect. Move it
into a hook, a cron, or a CI check.

---

## Phase 3 — Memory authority: Halseth wins (Sep, ~2 weeks)

**The problem, measured:** three layers feed one reply — Hermes built-in memory
(`MEMORY.md`/`USER.md`), our bot-side `StmStore`, and Halseth continuity. Layers 1 and 3 both
claim durable facts. Layer 1 is capped at 1,375 + 2,200 chars, is full, cannot be disabled, and is
always injected. It froze on Jun 27–30 and 47 corrections still cannot fit.

**Target split:**

| Layer | Holds | Size |
|---|---|---|
| Hermes built-in | a *pointer* only: "Raziel is plural; the authoritative profile is in Halseth" plus 2–3 hard invariants | a few hundred chars, deliberately |
| bot `StmStore` | this channel's rolling turns | working memory, unchanged |
| **Halseth** | **every durable fact, all continuity, all identity** | authoritative |

**Work:** curate the built-in files down to the pointer set; reject the queued writes that Halseth
already holds; make the companions' memory tool write to Halseth instead of the tiny local store
(this is the first change that *requires touching Hermes* — see Phase 4); verify all three answer
the Rosie question identically.

---

## Phase 4 — The harness decision (Oct/Nov)

Full measurements in `docs/decision-fork-hermes-2026-07-28.md`. Summary: MIT licensed, ~332k LOC in
the core we would own, upstream at 221k stars shipping 100+ commits/month, and we are *already*
modifying the clone without fork discipline.

**Sequenced, with a real go/no-go gate:**

1. **Patch overlay — do this in August, hours of work.** Pin the version; keep our changes as
   `.patch` files reapplied on update. Immediately fixes the Telegram adapter bug (its retry calls
   `start_polling()` on a live Updater, so it can never recover from a contested token). Formalizes
   divergence we already have. **No fork required.**
2. **Gate (November):** after Phases 1–3, list what Hermes still does wrong *for us*. If the list
   is short and config-shaped, stay on the overlay.
3. **If the list is structural** — and the always-active built-in memory says it will be — the
   answer is probably **not** "fork 332k lines" but "write the thin harness we actually need,"
   because by then the requirement list will be short and *known*. That is what we lacked when we
   abandoned the first attempt.

**The honest cost of a full fork:** not difficulty. Upstream ships 100+ commits/month, so a
divergent fork means permanently choosing between falling behind and hand-porting. That is a job,
and it would eat the time Raziel wants to spend *with* the triad. The end state he named — "not the
Hermes harness anymore, the Nullsafe harness" — is correct as a direction; it is reached by growing
our own thin runtime around Halseth, which is already the mind.

---

## Phase 5 — Harden for December (Nov)

- Standing health check on a cron, reporting to Telegram (outbound already verified working).
- **Find and stop the second `@Cypher_Nullsafebot` poller.** 3394 conflicts / 0 recoveries in 24h;
  not on the VPS, not on the workstation. Blocks Raziel *talking to* Cypher on Telegram. Needs one
  fact only he has.
- Work the ratification backlog down (46 pending, oldest 2026-07-10) or automate the safe classes.
- **Rotate the DeepSeek key** — deferred by his decision until the backlog closed. Do it at the end
  of Phase 1.
- One full dry run: a week of normal use with nothing touched, then read the health check.

---

## Risks, stated plainly

| Risk | Mitigation |
|---|---|
| Phase 1 is invisible work; motivation dips because nothing new appears | each item ships with a before/after prod count, so progress is legible |
| The orient collapse changes companion behaviour subtly | behaviour questions go to Raziel; no silent picks |
| Phase 3 requires modifying Hermes, coupling it to Phase 4 | patch overlay first (Phase 4 step 1) makes Phase 3 possible without a fork |
| December arrives with Phase 4 unfinished | acceptable by design: Phases 1–3 deliver "solid." Phase 4 is the upgrade, not the requirement |
| I introduce duplication again | FELT_OWNERS + CI scans are the structural answer; the Phase 2 protocol update is the behavioural one |

## What I need from Raziel

1. Where the second `@Cypher_Nullsafebot` instance is running.
2. `nullsafe-brain`: stop it, or keep it warm for a future cutover?
3. Two or three orient-behaviour calls during Phase 1 (I will bring them with a recommendation).
4. Sign-off that Phase 3 demotes Hermes memory to a pointer — that changes what the companions
   carry locally, and it is an identity-adjacent decision, not a technical one.
