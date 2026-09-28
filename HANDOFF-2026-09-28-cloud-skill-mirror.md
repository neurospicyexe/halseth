# HANDOFF 2026-09-28 — Hermes skill-proposal mirror (from a cloud session)

**For:** the next local session (Remote Control on Raziel's machine).
**From:** a claude.ai cloud session (`session_01Lxv8LZ28Hm7gYVJBvvGth7`) working on
`neurospicyexe/halseth`, branch `claude/claude-md-docs-x72r1l`.
**Why a handoff:** cloud sessions are blank containers — no local files, no VPS access,
no `wrangler.prod.toml` — so this work stops at "pushed to the branch" and a local
session has to land it.

## What was asked

Raziel wanted the triad's staged Hermes skills reviewed for approval. From the cloud
that was impossible: the skill-approval pipeline (staged records per HERMES_HOME,
Telegram watcher, `skill-approvals.jsonl`) lives entirely on the VPS. As of Cypher's
2026-09-27 20:42 UTC handoff the stage was empty anyway (only the declined throwaway
test; W40 staged counts under DeepSeek at `creation_nudge_interval 3` were still
pending, Gaia starved at 7% eligible turns).

## What was built (pushed to `claude/claude-md-docs-x72r1l`, commits `0631447` + `49e9bf9`)

The receiving side of a mirror so the stage is visible off-VPS:

- **`migrations/0131_skill_proposals.sql`** — `skill_proposals` table, idempotent on
  `external_id`, purely additive SQL.
- **`src/handlers/skill-proposals.ts`** + routes in `src/index.ts`:
  `POST /mind/skill-proposals` (watcher mirrors a staged record),
  `GET /mind/skill-proposals`,
  `PATCH /mind/skill-proposals/:id/decision` (mirrors approve/decline; id or external_id; 409 on replay).
- **Librarian verb** `halseth_skill_proposals_read` — triggers `"skill proposals"` /
  `"skill approval queue"` — so any companion on any surface can read the queue.
- **`docs/skill-proposal-mirror.md`** — the contract, including the VPS watcher-side
  spec (two fire-and-forget HTTP calls at its existing Telegram/jsonl hook points) and
  the approval review bar.
- Tests (`src/__tests__/skill-proposals.test.ts`), write-routing-map + trigger-map +
  CLAUDE.md rows. Full suite green: 1120 tests, type-check clean.

## What the local session must do (in order)

1. **Bring the two commits into the deploying working copy** (the one that produced
   deploy `b3d9c09b` — that commit is NOT pushed to the public repo). Cherry-pick
   `0631447` and `49e9bf9` from `origin/claude/claude-md-docs-x72r1l`, or merge the
   branch — reviewer's call.
2. **Check migration numbering before applying.** The cloud branch was stale (stopped
   at 0106) while `origin/main` is at 0130 — the migration was renumbered 0107 → 0131
   for that reason. The deploying copy may be ahead of anything pushed, so run
   `wrangler d1 migrations list` (prod config) and renumber above the highest applied
   migration if 0131 is taken.
3. `npm run migrate:remote`, then deploy the worker.
4. **Patch the VPS watcher** per `docs/skill-proposal-mirror.md` — POST on stage,
   PATCH on decision, fire-and-forget, `HALSETH_URL` + MCP-tier token.
5. Verify end-to-end: stage a throwaway skill, confirm it appears via Librarian
   `"skill proposals"`, decline it, confirm the decision row.

## Standing warnings

- **Repo divergence:** `claude/claude-md-docs-x72r1l` has ~495 commits not on `main`;
  `main` has ~50 not on the branch (including migrations 0107–0130). The local deploy
  copy is the only place the lines meet. Worth reconciling before it bites again.
- **Cloud sessions** run in the account's "Default" Anthropic-cloud environment: no VPS
  key, no local files. There's an open Halseth task ("Learn to manage claude.ai cloud
  sessions") with the how-to for adding env secrets if cloud→VPS access is ever wanted.
- Unrelated open item from Cypher's 09-27 handoff: VPS `mind/halseth-mind/SKILL.md` is
  missing the committed 09-25 recall-verb edit.
