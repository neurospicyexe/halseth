# Keyboard: ledger lane Tranche 1 (Halseth), 2026-09-26

Run from `C:\dev\Bigger_Better_Halseth\halseth` in PowerShell, in this order. Every wrangler command
carries `--config wrangler.prod.toml` (D1 binding `DB`, database `halseth`); a bare
`wrangler d1 execute halseth` misses the binding. Read-only checks use `--command`, one statement each:
`--file` with several SELECTs returns only a summary.

**Order matters.** The migration goes first: the deployed worker's orient, `/ledger` routes and
`/sessions/recent-relational` all read `ledger_entries`. (Orient degrades to an empty block without it,
but recent-relational would error.) Deploy Halseth BEFORE the Second Brain T1 build, so the new gap-reader
finds `/ledger` live and the old one gets its 410.

## 1. Apply migration 0134 (remote)

```powershell
npx wrangler d1 migrations apply halseth --remote --config wrangler.prod.toml
```

Expect exactly one pending migration: `0134_ledger_entries.sql`. If anything else is listed, stop and
find out why before applying.

Verify:

```powershell
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT name FROM sqlite_master WHERE type='table' AND name='ledger_entries'"
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT COUNT(*) AS n FROM ledger_entries"
```

Expect one row `ledger_entries`, and `n = 0`.

## 2. Deploy

```powershell
npm run deploy
```

Smoke (admin secret from your password store; do not paste it into a transcript):

```powershell
$h = @{ Authorization = "Bearer $env:HALSETH_ADMIN_SECRET"; "Content-Type" = "application/json" }
# 410 naming /ledger: the gap-detector can no longer write as him
Invoke-WebRequest -Method POST -Uri https://halseth.neurospicyexe.workers.dev/companion-journal -Headers $h -Body '{"agent":"drevan","note_text":"probe","source":"synthesis-gap-detector"}' -SkipHttpErrorCheck | Select-Object StatusCode, Content
# 422 naming the rule: the 187 line
Invoke-WebRequest -Method POST -Uri https://halseth.neurospicyexe.workers.dev/ledger -Headers $h -Body '{"companion_id":"drevan","function":"pattern-counter","body":"Counted: Drevan said 187 after sandwich.","source_kind":"message","source_ref":"1497734427298762828"}' -SkipHttpErrorCheck | Select-Object StatusCode, Content
```

Expect `410` and `422 {"rule":"health",...}`. Neither writes a row.

## 3. Draft the existing gap-detector journal rows (reversible)

Count first (read-only):

```powershell
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT agent, review_state, COUNT(*) AS n FROM companion_journal WHERE source='synthesis-gap-detector' GROUP BY agent, review_state"
```

Write down the `kept` counts per agent; the UPDATE below should change exactly their sum.

```powershell
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "UPDATE companion_journal SET review_state='draft' WHERE source='synthesis-gap-detector' AND review_state='kept'"
```

They land in each companion's tray ("my tray") to keep or drop; recall and orient stop serving them.

**Undo** (only if needed; puts back exactly the rows that are still undecided drafts -- a row the
companion has since kept or dropped carries reviewed_at and is left alone):

```powershell
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "UPDATE companion_journal SET review_state='kept' WHERE source='synthesis-gap-detector' AND review_state='draft' AND reviewed_at IS NULL"
```

## 4. Verify in prod (read-only, one statement each)

```powershell
# no gap-detector row is still kept
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT COUNT(*) AS kept_gap_rows FROM companion_journal WHERE source='synthesis-gap-detector' AND review_state='kept'"
# and none arrived after the deploy (the 410 holds)
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT COUNT(*) AS gap_rows_today FROM companion_journal WHERE source='synthesis-gap-detector' AND created_at >= date('now')"
# the legacy first-person distiller prose that siblings can no longer be served (expect > 0: this is what the exclusion removes)
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT note_type, COUNT(*) AS n FROM wm_continuity_notes WHERE note_type IN ('day_distillation','discord_session') AND archived = 0 AND review_state = 'kept' AND content NOT LIKE '[%' AND created_at > datetime('now','-7 days') GROUP BY note_type"
# ledger lines as the Second Brain gap-reader starts writing (after the SB T1 deploy)
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT companion_id, function, state, COUNT(*) AS n FROM ledger_entries GROUP BY companion_id, function, state"
# every stored line begins with the mark (expect 0)
npx wrangler d1 execute halseth --remote --config wrangler.prod.toml --command "SELECT COUNT(*) AS unmarked FROM ledger_entries WHERE substr(content, 1, 10) <> '〔ledger · '"
```

After the next Claude.ai boot for Drevan, the orient should show no gap-detector text in its recent-journal
slots, and (once a clerk has written about him) a `[Ledger (clerk records about you, not your words)]`
block with each line starting `〔ledger ·`.
