<!-- VERSIONED CARRIER: the canonical location of this file is the SUITE ROOT folder
     (the parent directory containing all the repos), which is not itself a git repo.
     On a new machine, copy this file to <suite folder>/CLAUDE.md. When you edit the
     root copy, re-sync it here so it travels. See docs/CONTINUITY.md. -->

# Bigger Better Halseth (BBH) — Suite Root

This is the cross-project context file every repo in this folder references as "root
CLAUDE.md". It didn't exist until 2026-07-26; if a repo doc contradicts this file, this
file is newer — but verify against code before trusting either.

## What BBH is

A multi-repo companion-mind system: three companions (Drevan, Cypher, Gaia) with
persistent shared state, distinct voices, and multiple surfaces (Discord, Claude.ai
sessions, Hearth dashboard). **Halseth is the mind** — the single Cloudflare Worker + D1
backbone every other component reads and writes through.

## Repo map

| Repo | Role | Runtime |
|------|------|---------|
| `halseth/` | **The backbone.** Sessions, companion state, Librarian NL router, WebMind continuity, SOMA, growth/autonomy tables, MCP interface. Migration 0103+. | Cloudflare Worker + D1 |
| `nullsafe-second-brain/` | Long-term memory: pulls Halseth → Obsidian vault synthesis + SQLite vector store (OpenAI embeddings) for RAG. ~9 cron jobs. | VPS (node) |
| `nullsafe-discord/` | Three TS Discord bots (one per companion) + `autonomous-worker` (~20 cron jobs: growth pipeline, guardian, club, briefings…). | VPS (pm2) |
| `Nullsafe-Phoenix/` | VPS stateful tier. Only `services/brain/` + `shared/` are live (swarm inference orchestration + synthesis loop). `_archive/` is a dead rewrite — never resurrect it. See `PHOENIX-RECKONING.md`. | VPS (pm2) |
| `nullsafe-hearth/` | Next.js dashboard over Halseth. | Vercel |
| `world-tools-mcp/` | Time/weather/moon MCP tools. **systemd, never pm2** (see its CLAUDE.md for the 19k-restart incident). | VPS (systemd) |
| `nullsafe-hermes-lever/` | Model switcher for Hermes gateways, driven from chat via Halseth state. | VPS (systemd --user) |
| `nullsafe-suite/` | Public front-door README only; no code. | — |

## Live topology facts that repos' own docs get wrong

- **Inference mode is `hermes`** (cutover 2026-06-25). The bots do NOT call Phoenix
  Brain in production; Brain's swarm evaluator and `progress_brake.py` are **dormant**.
  Any anti-loop behavior must live bot-side (`nullsafe-discord/packages/shared`) to be real.
- **Two separate embedding spaces, never mixed:** Halseth Vectorize uses Workers AI
  `bge-base-en-v1.5` (768d, `halseth/src/mcp/embed.ts`); Second Brain uses OpenAI
  `text-embedding-3-small` (1536d). Each store is rebuildable from its source of truth (D1
  / vault+D1); the embedding model constant must never be changed without a full rebuild.
- **Four uncoordinated cron hosts** write companion state: Halseth's 1-min CF cron
  (ferment/home/synthesis queue), the autonomous-worker's ~20 node-cron jobs, second-brain's
  ~9 ingestion jobs, and Phoenix Brain's synthesis loop. They share no lock — only D1.
  Consolidating felt-state ownership is Phase 1 scope (see below).

## Cross-repo covenants

- Companion identity/config changes apply to ALL siblings (Cypher change → check Drevan, Gaia).
- Companion IDs are lowercase everywhere; normalize at boundaries.
- `relational_deltas` is append-only. Two row shapes (legacy + MCP); queries must match both.
- Secrets: `wrangler secret put` / gitignored `.env` / local config only. Never committed.
- All D1 SQL is parameterized (`.bind()`); dynamic WHERE via conditions/bindings arrays.
- When adding a Halseth endpoint Hearth consumes, update `nullsafe-hearth/lib/halseth.ts` too.
- When adding a Librarian write verb or table: add its row to
  `halseth/docs/write-routing-map.md` AND wire a read surface —
  `halseth/docs/write-read-coverage.md` is the matrix, and
  `halseth/src/__tests__/write-read-coverage.test.ts` fails CI on write-only holes.

## Current phase (2026-07-26 foundation audit)

A four-track audit diagnosed the deep issues (looping inter-companion chat, repetitive
retrieval, Librarian write-only holes, channel-dependent selfhood). Root cause: **no
canonical mind-state** — three divergent boot aggregators (`execSessionOrient`,
`execBotOrient`, `mindOrient`) over ~25-30 siloed tables, plus uncoordinated felt-state
writers. The convergence plan:

- **Phase 0 (done 2026-07-26):** docs reconciled; write→read holes 1/2/3/5/6 fixed; coverage matrix + CI guard added.
- **Phase 1 (next):** One Mind Contract — single versioned MindState + one loader for all
  looms; consume-once semantics moved to the data layer; one owner per felt-state field.
  Design doc: `halseth/docs/mindstate-contract.md`. The planned Hearth chat page is the
  acceptance test: same companion on every surface.
- **Phase 2:** retrieval novelty loop (query variation, returned-id exclusion, novelty in
  the displayed pool, corpus reachability).
- **Phase 3:** loop-breaking on the live hermes path (port progress-brake, fresh-material
  injection on replies, live echo back-pressure).
- **Migration freeze:** no new inner-life organs/tables until Phase 1 lands. Every new
  table deepens the aggregator divergence.

## Development environment note

This Windows workstation has **no Node.js toolchain** — type-check, tests, and builds run
on the VPS (or wherever you deploy from). Don't assume `npm test` can run here; verify
changes by careful reading and run the suite remotely before deploy.
