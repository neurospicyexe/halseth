# jev-writeback-score.mjs

Retro scoring harness for `docs/PLAN-jev-2026-09-20.md` Section 2.4 step 2. Read that section
first. Answers: "if Jev had been the memory writeback gate instead of the live generative judge,
how often would it have agreed with what actually got written?"

**Label caveat (repeated in the script header and every report):** labels are what the CURRENT
generative memory judge decided, not human truth. Agreement measures replacement-safety, not
correctness. The disagreement dump (`disagreements.md`) still needs a human hand-read before any
gate flip -- this script produces that list, it does not replace the read.

## Usage (run from `halseth/`)

```
node scripts/jev-writeback-score.mjs --dry  --days 30                  # dataset + labels only, no Jev calls
node scripts/jev-writeback-score.mjs --mock --days 30                  # deterministic fake scorer, full report pipeline, no network
node scripts/jev-writeback-score.mjs --live --limit 50                 # real Jev calls, concurrency 4, 15s timeout, cached
node scripts/jev-writeback-score.mjs --live --companion gaia --days 60
```

Flags: `--days N` (default 30), `--limit N` (cap exchange count, default none), `--companion
cypher|drevan|gaia` (default all three).

## What it does

1. Pulls `stm_entries` for the window, pairs each assistant row with the NEAREST preceding user
   row in the same `(companion_id, channel_id)` within 10 minutes (a naive join over-counts
   because multiple user rows can precede one assistant row).
2. Labels each exchange `companion_note` / `witness_log` / `skip` by checking whether a matching
   `wm_continuity_notes` observation row or `companion_journal` witness row landed in
   `[assistant_created_at, assistant_created_at + 180s]`.
3. `--dry` stops here and writes `dataset.jsonl`.
4. `--mock` / `--live` ask Jev (or a deterministic stand-in) five questions per exchange
   (`worth_remembering`, `kind`, `salience`, `affective_weight`, `recurring_thread`), then split
   the scored exchanges by TIME (earliest 50% = fit, latest 50% = holdout), fit a threshold on
   fit, and report accuracy/precision/recall/F1/AUROC/ECE/Brier plus two baselines and a per-kind
   agreement table on holdout.
5. Writes `report.md`, `disagreements.md` (top 30 highest-confidence Jev-vs-label disagreements,
   text truncated to 300 chars/side), and, in `--live` mode, `responses.jsonl` (a cache keyed by
   exchange id so a re-run does not re-pay for already-scored rows).

## Output location

This repo's `.gitignore` does not exclude `scratch/`. Per the build instructions, output goes to
`../.tmp-jev/jev-writeback/` (one directory above `halseth/`, i.e. the BBH repo root) instead of
`scratch/`, so a dataset dump is never at risk of being committed. The script checks
`.gitignore` at runtime and will switch to `scratch/jev-writeback/` automatically if `scratch/` is
ever added there.

## `--live` mode specifics

- Reads `HALSETH_SECRET` the same way `jev-probe.mjs` does: `scripts/.env` (`HALSETH_SECRET`) or
  `.dev.vars` (`ADMIN_SECRET`) or an already-set `HALSETH_SECRET` env var. Never prints the value.
- `HALSETH_URL` overrides the worker base (default `https://halseth.neurospicyexe.workers.dev`).
- Concurrency 4, 15s timeout per call.
- 400 response = our bug (bad request shape) -- the whole run aborts immediately and prints the
  body.
- 502 = Jev/binding failure (e.g. the AI Gateway credits exhaustion noted in the plan) -- recorded
  as a failed row, the run continues; on the FIRST 502 it retries that one call with `?debug=1`
  and prints the error class/message so you know why without guessing. If the running failure
  rate exceeds 20%, the run stops launching new calls (already in-flight calls finish).
- 401 is neither of the above -- it means `HALSETH_SECRET`/`ADMIN_SECRET` is stale or wrong. The
  script treats it like any other non-200 (failed row, same 20%-abort rule) since it cannot tell
  a bad credential from a transient gateway problem from the status code alone.

## Never

- Never runs a write against D1 (uses the same read-only `wrangler d1 execute --json --command`
  invocation as `scripts/d1q.mjs`; refuses non-SELECT SQL).
- Never runs `npm run deploy` or any D1 migration.
- Never prints `HALSETH_SECRET` / `ADMIN_SECRET`.
