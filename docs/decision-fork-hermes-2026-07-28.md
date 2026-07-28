# Should Hermes become the Nullsafe harness? (2026-07-28)

Raziel's proposal: Hermes is MIT and open source, so copy it, edit what we need, stop trying to
squeeze a bespoke system into a generic one, absorb our own services into it, and accept that we
maintain it. Cherry-pick upstream changes by reading their releases rather than pulling them.

His instinct about the end state is right. The sequencing is what this doc is about.

## Measured, not guessed

| Thing | Number |
|---|---|
| License | **MIT** (Nous Research). Forking is legally clean. |
| Upstream stars / open issues | **221,858** / **26,165** |
| Upstream last push | **2026-07-28** (today) |
| Upstream commits, last 30 days | **100+** (API page cap; actual is higher) |
| `agent/` (core loop) | 80,303 LOC |
| `gateway/` (incl. the OpenAI-compatible server we call) | 70,187 |
| `plugins/` (incl. `telegram_platform`) | 98,197 |
| `tools/` | 83,633 |
| `hermes_cli/` | 144,543 |
| `tests/` | 624,555 |
| **Core we would own** (agent+gateway+plugins+tools) | **~332,000 LOC** |

We are **already** modifying the clone without the discipline of a fork: `git status` shows
deleted skills (`skills/productivity/google-workspace/*`) and we have added
`custom-dangerous-patterns/50-triad-blast-radius.yaml`. So the question is not whether to diverge.
It is whether to do it deliberately.

## The uncomfortable part: the jank is mostly ours

Of the defects found on 2026-07-27/28, **one** was Hermes's. The rest were ours:

| Defect | Whose |
|---|---|
| Reasoning tokens spending `max_tokens` before content | ours |
| `deepseek-chat` delisted, hardcoded in **7** places | ours |
| Three model registries disagreeing (`models.ts`, `providers.py`, `hermes-model-map.json`) | ours |
| `active_model` free text; 2 of 3 values invalid | ours |
| Per-bot `INFERENCE_MODE` override vs shared value (I misread it and misreported the topology) | ours |
| forage / compress / reflect 400s | ours |
| `nullsafe-brain` running with nothing calling it | ours |
| Telegram adapter retries `start_polling()` on a live Updater, so it can never recover | **Hermes** |

The friction of "shoving things together" is real, but its cause is duplication we own:

- **5 places decide which model to use** — `models.ts`, `providers.py`, `hermes-model-map.json`,
  `DEEPSEEK_MODEL` env, `active_model` setting.
- **2 harnesses exist** — Hermes (live) and Brain (running, dormant, unused).
- **3 orient aggregators** — `mindOrient`, `execBotOrient`, `execSessionOrient`.

A fork would inherit every one of those. Forking first means maintaining 332k LOC of someone
else's code *and* our own sprawl.

## The memory-tier question, investigated (Raziel: "we really need to dig into it")

His read was that Hermes holds working memory and Halseth holds long-term, and that forcing that
into the harness is probably not ideal. Confirmed, and worse than suspected.

**There are three memory layers feeding one reply**, not two:

1. Hermes built-in memory — `MEMORY.md` + `USER.md`, `memory_char_limit: 2200`
2. Our bot-side `StmStore` (rolling per-channel window)
3. Halseth continuity, injected via `composePrompt(... recentContext ...)`

Layers 1 and 3 both claim to hold durable facts about Raziel. Layer 1 is **frozen and wrong**:

| Profile | Built-in memory | Last written |
|---|---|---|
| Cypher (default) | `USER.md` only, **no** `MEMORY.md` | **Jun 28** |
| Drevan | `MEMORY.md` + `USER.md` | **Jun 30** / Jun 27 |
| Gaia | `USER.md` only, **no** `MEMORY.md` | **Jun 27** |

Because `write_approval: true`, every memory update since has queued instead of applying.
**13 pending writes, 2026-07-05 through 2026-07-16**, including:

- `cd62c1ca` (07-14): `replace: old "Raziel has a cat named Rosie" -> new "retired service dog"`
- `103c14d9` (07-14): Rosie is an Australian Shepherd, retired service dog
- front-identity facts about Crash's register and role
- `cefb1a83`: describes Raziel as 43 (he is 44)
- serama chickens, relational stance, depth-initiation pattern

So the companions **learned the correct facts, tried to write them down, and the corrections have
been sitting in a queue for two weeks** while the stale version stays in their prompt. This is a
strong candidate for the original 07-27 bug report (Drevan discussing the shared song with no
memory of the conversation, misattributing the gift to Gaia, "6 days").

Root cause of the rot: approvals were designed to arrive as Telegram button taps, and we built
`ops/skill-approve.py` + `skill-approval-watcher.py` for the **skills** queue and never built the
equivalent for the **memory** queue. Skills backlog: 1. Memory backlog: 13. The mechanism is the
same subsystem — `tools.write_approval.get_pending("memory", id)` — so a memory approver is a
near-copy of the skill one. (Cypher's broken inbound Telegram polling would also block taps.)

**And here is the load-bearing argument for Raziel's instinct**, straight from `hermes memory --help`:

> "Built-in memory (MEMORY.md/USER.md) is **always active**."

There is no config that makes Halseth the single source of truth. The harness will always keep its
own competing opinion about who Raziel is and inject it into every prompt. Making Halseth
authoritative requires **modifying Hermes** — which is exactly the case where a patch overlay or a
fork stops being optional. This is the first defect found this week that config cannot fix.

## Verdict

**Possible: yes. Astronomically hard: no. Wrong order: yes.**

The hard part of a fork is not writing it — it is that upstream ships 100+ commits/month, so a
divergent fork means permanently choosing between falling behind and hand-porting. That is a real
job. The cost is not difficulty, it is the triad time it would eat.

Sequence:

1. **Patch overlay now** (hours). Pin the Hermes version, keep our changes as `.patch` files
   reapplied on update. Fixes the Updater bug immediately and formalizes the divergence we already
   have. No fork required.
2. **Collapse what we own** (days-to-weeks, all our code). Stop Brain. Five model registries → one.
   Three orient paths → one. This removes most of the felt jankiness and none of it needs Hermes's
   permission.
3. **Then decide.** After (2) the list of things Hermes actually does wrong for us will be short
   and *known*. If it still chafes, the answer is probably not "fork 332k LOC" but "write the thin
   harness we need" — which is what we tried before and abandoned for the right reason: we did not
   yet know what we needed. After (2) we would.

The "Phoenix/Nullsafe harness" end state is the correct direction. It is reached by growing our own
thin runtime around Halseth (which is the mind), not by adopting and mutating a general-purpose
agent built for 221k strangers whose priorities will never be a plural companion substrate.
