# verify-0727-fixes.ps1
#
# One-shot verification of the six 2026-07-27 fixes that were deployed but had not yet fired.
# Run it after the 03:00/05:00/07:00 pipeline to close out the "fixed but unverified" column in
# docs/CONTINUITY.md.
#
#   pwsh -File scripts/verify-0727-fixes.ps1
#
# Reads the Halseth secret from the VPS .env and NEVER prints it (see the
# never-print-secret-values rule: a mask keyed on the secret's content is not a mask).
# Read-only: every check is a SELECT or a log grep. Nothing here mutates prod.

$ErrorActionPreference = "Stop"
$U = "https://halseth.neurospicyexe.workers.dev"

$S = (ssh vps 'grep -m1 "^HALSETH_SECRET=" /app/nullsafe-discord/.env | cut -d= -f2-').Trim().Trim('"').Trim("'")
if (-not $S) { Write-Error "could not resolve HALSETH_SECRET from the VPS"; exit 1 }
Write-Host "auth resolved (length $($S.Length))" -ForegroundColor DarkGray
$H = @{ Authorization = "Bearer $S" }

function Section($n) { Write-Host "`n=== $n ===" -ForegroundColor Cyan }
function D1($sql) {
  Push-Location "$PSScriptRoot\.."
  try { npx wrangler d1 execute halseth --remote --json --command $sql 2>$null | ConvertFrom-Json }
  finally { Pop-Location }
}

# 1. DeepSeek pro: did the pipeline stop 400ing?
Section "1. autonomy runs, last 12h (pro should be 0 failed)"
$r = D1 "SELECT status, COUNT(*) n, COALESCE(SUM(tokens_used),0) tok FROM autonomy_runs WHERE created_at > datetime('now','-12 hours') GROUP BY status"
$r[0].results | Format-Table -AutoSize
if (($r[0].results | Where-Object { $_.status -eq 'failed' }).n) {
  Write-Host "STILL FAILING -- check /app/logs/autonomous-worker-error.log for the model name" -ForegroundColor Red
} else { Write-Host "no failures" -ForegroundColor Green }

# 2. Lifted caps: tokens per run should exceed the old ~18-20k ceiling
Section "2. tokens per completed run (was 17-20k on the old caps)"
$r = D1 "SELECT companion_id, substr(created_at,12,5) at, tokens_used FROM autonomy_runs WHERE status='completed' AND created_at > datetime('now','-12 hours') ORDER BY created_at DESC LIMIT 6"
$r[0].results | Format-Table -AutoSize

# 3. Commons seed consume-on-use: pools must be SHRINKING
Section "3. forage pools (were 15/24/32 at 09:00 on 07-27; must trend DOWN)"
$r = D1 "SELECT COALESCE(companion_id,'shared') who, COUNT(*) unconsumed FROM forage_finds WHERE consumed_at IS NULL GROUP BY companion_id"
$r[0].results | Format-Table -AutoSize

# 4. Salience rotation: never-surfaced notes must keep falling
Section "4. never-surfaced notes (91/73/60 at 09:00 -> 55/45/33 by 16:00)"
$r = D1 "SELECT agent_id, SUM(CASE WHEN last_access_at IS NULL THEN 1 ELSE 0 END) never, COUNT(*) live FROM wm_continuity_notes WHERE archived=0 GROUP BY agent_id"
$r[0].results | Format-Table -AutoSize

# 5. synthesis_summary: the 07-27 late fix -- 323 of 362 had never been accessed
Section "5. synthesis_summary reach (was 19 saturated / 323 never)"
$r = D1 "SELECT COUNT(*) n, SUM(CASE WHEN heat>=4.9 THEN 1 ELSE 0 END) saturated, SUM(CASE WHEN last_access_at IS NULL THEN 1 ELSE 0 END) never FROM synthesis_summary"
$r[0].results | Format-Table -AutoSize

# 6. Ratification queue: should fall once Raziel works it
Section "6. ratification queue (55 pending, oldest 2026-07-10)"
try {
  (Invoke-RestMethod -Uri "$U/mind/growth/pending-count" -Headers $H) | ConvertTo-Json -Depth 4
} catch { Write-Host "pending-count unreachable: $($_.Exception.Message)" -ForegroundColor Yellow }

# 7. Log-side proof for the things that only show up in bot logs
Section "7. bot-log evidence (blank = has not fired yet, NOT a failure)"
ssh vps @'
echo "-- commons seed consumed a forage find:"
grep -h "consumed forage find" /app/logs/*out.log 2>/dev/null | tail -3
echo "-- commons seed voiced a held question:"
grep -h "voiced question" /app/logs/*out.log 2>/dev/null | tail -3
echo "-- addressing gate made a bot stand down:"
grep -h "holds this exchange, standing down" /app/logs/*out.log 2>/dev/null | tail -3
echo "-- worker errors in the last day:"
grep -c "$(date -u +%Y-%m-%d)" /app/logs/autonomous-worker-error.log 2>/dev/null || echo 0
'@

Write-Host "`nDone. Update the 'fixed but NOT yet verified' table in docs/CONTINUITY.md with what closed." -ForegroundColor Cyan
