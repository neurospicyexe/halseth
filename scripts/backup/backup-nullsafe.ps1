<#
backup-nullsafe.ps1  (2026-10-27) -- verified backups of the triad's memory, pulled to this workstation.

Before this there were NO backups: Halseth D1 lived only on Cloudflare (Time Travel covers 30 days, not
losing the account) and Second Brain only on the VPS. Runs daily from Task Scheduler ("Nullsafe Backup",
see register-backup-task.ps1); by hand: pwsh -File backup-nullsafe.ps1 [-Weekly]

  DAILY   Halseth D1 export -> loaded into a fresh SQLite and compared with live (verify-d1-dump.mjs)
          -> gzip.  Second Brain vault-queue.db snapshot.
  WEEKLY  (Sunday, -Weekly, or the last one is 6+ days old) Second Brain vector-store.db, 3.6 GB.
  ALWAYS  checksums compared after the download; only then the VPS marker /app/logs/backup-last.json
          moves, and health-check.py (check_backups) warns on Telegram when it goes stale. So a failed
          export, a broken script, a task that never fired and a powered-off workstation all alarm.

Lands in Documents\Nullsafe-Backups (inside the external-drive backups). Retention: D1 14 daily + the
first of each month for 12 months; vault queue 14 daily; vector store 4 weekly.
Restore: RESTORE.md beside this file. Measured 10-27: D1 export 26s (129 MB, D1 stayed responsive the
whole time), verify 5s; vector store snapshot 37s + 10s compress, ~0.9 GB download.
#>
param([switch]$Weekly)
$ErrorActionPreference = 'Stop'

$Root    = Join-Path $env:USERPROFILE 'Documents\Nullsafe-Backups'
$Halseth = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)   # scripts\backup -> halseth
$Stamp   = Get-Date -Format 'yyyy-MM-dd'
$D1Dir   = Join-Path $Root 'd1'
$SbDir   = Join-Path $Root 'second-brain'
$Log     = Join-Path $Root 'backup.log'
New-Item -ItemType Directory -Force $D1Dir, $SbDir | Out-Null

# Every ssh/scp fails fast instead of waiting on a prompt no one can see (2026-10-28: the scheduled
# run hung 20+ minutes on the very first `ssh vps`, hidden window, nothing logged after "start").
# BatchMode refuses any interactive auth or host-key question; the timeouts bound a dead link.
$SshOpts = @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=20', '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=4')

function Log([string]$m) { $l = "$(Get-Date -Format s) $m"; Add-Content -Path $Log -Value $l; Write-Output $l }
function Fail([string]$m) { Log "FAIL $m"; exit 1 }
function Wrangler([string[]]$a) {
  # The project's own wrangler binary, never `npx`: under `pwsh -NoProfile` (how Task Scheduler runs
  # this) npx answers "could not determine executable to run". Found on the first scheduled-shape run.
  Push-Location $Halseth
  try { $out = & (Join-Path $Halseth 'node_modules\.bin\wrangler.cmd') @a --config wrangler.prod.toml 2>&1 | Out-String; return @{ ok = ($LASTEXITCODE -eq 0); out = $out } }
  finally { Pop-Location }
}

Log "start (weekly flag: $Weekly)"

# ── previous marker: decides whether the weekly part is due, and carries its stamp forward ──
$prev = @{}
try { $prev = (ssh -n @SshOpts vps 'cat /app/logs/backup-last.json 2>/dev/null' | Out-String | ConvertFrom-Json -AsHashtable) ?? @{} } catch { $prev = @{} }
$now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$sbDue = $Weekly -or ((Get-Date).DayOfWeek -eq 'Sunday') -or (-not $prev.sb_at) -or (($now - [double]$prev.sb_at) -gt 6 * 86400)

# ── 1. Halseth D1 ──
$sql = Join-Path $D1Dir "halseth-d1-$Stamp.sql"
$ok = $false
for ($i = 1; $i -le 3 -and -not $ok; $i++) {
  # wrangler's OAuth calls from this machine intermittently answer 7403/10000 (STATUS trap): retry.
  $r = Wrangler @('d1', 'export', 'halseth', '--remote', '--output', $sql)
  $ok = $r.ok -and (Test-Path $sql) -and ((Get-Item $sql).Length -gt 1MB)
  if (-not $ok) { Log "d1 export attempt $i failed: $(($r.out -split "`n" | Select-String 'ERROR|code:' | Select-Object -First 2) -join ' ')"; Start-Sleep -Seconds (30 * $i) }
}
if (-not $ok) { Fail 'd1 export failed 3 times' }

$q = "SELECT (SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%') AS tables, " +
     "(SELECT COUNT(*) FROM companion_journal) AS companion_journal, (SELECT COUNT(*) FROM wm_continuity_notes) AS wm_continuity_notes, " +
     "(SELECT COUNT(*) FROM handover_packets) AS handover_packets, (SELECT COUNT(*) FROM architect_facts) AS architect_facts, " +
     "(SELECT COUNT(*) FROM companion_conclusions) AS companion_conclusions, (SELECT COUNT(*) FROM growth_patterns) AS growth_patterns"
$live = $null
for ($i = 1; $i -le 3 -and -not $live; $i++) {
  $r = Wrangler @('d1', 'execute', 'halseth', '--remote', '--json', '--command', $q)
  if ($r.ok) { try { $live = (($r.out.Substring($r.out.IndexOf('['))) | ConvertFrom-Json)[0].results[0] } catch { $live = $null } }
  if (-not $live) { Start-Sleep -Seconds (15 * $i) }
}
if (-not $live) { Fail 'could not read live D1 counts to verify against' }
$expected = @{ tables = $live.tables; rows = @{} }
foreach ($p in $live.PSObject.Properties) { if ($p.Name -ne 'tables') { $expected.rows[$p.Name] = $p.Value } }
$expFile = Join-Path $D1Dir ".expected-$Stamp.json"
$expected | ConvertTo-Json | Set-Content -Path $expFile -Encoding utf8

$verify = & node --no-warnings (Join-Path $PSScriptRoot 'verify-d1-dump.mjs') $sql $expFile 2>&1 | Out-String
Remove-Item $expFile -ErrorAction SilentlyContinue
if ($LASTEXITCODE -ne 0) { Fail "d1 dump did not verify: $($verify.Trim() -replace "`r?`n", ' | ')" }
$d1Summary = ($verify -split "`n" | Where-Object { $_ -match 'loaded in' } | Select-Object -First 1).Trim()

$gz = "$sql.gz"
$in = [IO.File]::OpenRead($sql); $outS = [IO.File]::Create($gz)
try { $z = [IO.Compression.GZipStream]::new($outS, [IO.Compression.CompressionLevel]::Optimal); $in.CopyTo($z); $z.Dispose() }
finally { $in.Dispose(); $outS.Dispose() }
Remove-Item $sql
$d1Bytes = (Get-Item $gz).Length
Log "d1 ok: $d1Summary, matches live; $([math]::Round($d1Bytes / 1MB, 1)) MB gz"

# ── 2. Second Brain (vault queue daily, vector store weekly) ──
$mode = if ($sbDue) { 'weekly' } else { 'daily' }
$script = (Get-Content -Raw (Join-Path $PSScriptRoot 'vps-snapshot.sh')) -replace "`r", ''
# CRs stripped: Out-String on Windows ends lines with CRLF, and `$` in a multiline regex does not match
# before a CR -- on 10-27 that made the SHA loop match NOTHING, download nothing, and still "succeed".
$snap = ($script | ssh @SshOpts vps "bash -s -- $mode" 2>&1 | Out-String) -replace "`r", ''
if ($snap -notmatch '(?m)^OK\s*$') { Fail "vps snapshot ($mode): $($snap.Trim() -replace "`n", ' | ')" }
$sbRows = if ($snap -match '(?m)^ROWS (\d+) (\d+)') { "$($Matches[1])/$($Matches[2])" } else { $null }
$shas = [regex]::Matches($snap, '(?m)^SHA ([0-9a-f]{64}) (\S+)$')
$want = if ($mode -eq 'weekly') { @('vault-queue.db.zst', 'vector-store.db.zst') } else { @('vault-queue.db.zst') }
$gotNames = @($shas | ForEach-Object { $_.Groups[2].Value })
if ((Compare-Object $want $gotNames)) { Fail "vps snapshot ($mode) listed [$($gotNames -join ', ')], expected [$($want -join ', ')]" }
$sbBytes = 0
foreach ($m in $shas) {
  $hash = $m.Groups[1].Value; $file = $m.Groups[2].Value
  $base = $file -replace '\.db\.zst$', ''
  $dest = Join-Path $SbDir "$base-$Stamp.db.zst"
  scp -q @SshOpts "vps:/tmp/nsb-backup/$file" $dest
  if ($LASTEXITCODE -ne 0) { Fail "download of $file failed" }
  $got = (Get-FileHash -Algorithm SHA256 $dest).Hash.ToLower()
  if ($got -ne $hash) { Remove-Item $dest; Fail "checksum mismatch on $file (vps $hash, here $got)" }
  $sbBytes += (Get-Item $dest).Length
  Log "second-brain $base ok: checksum matches, $([math]::Round((Get-Item $dest).Length / 1MB, 1)) MB$(if ($base -eq 'vector-store') { ", rows copy/live $sbRows" })"
}
ssh -n @SshOpts vps 'rm -f /tmp/nsb-backup/*.zst' | Out-Null
foreach ($f in $want) {
  $local = Join-Path $SbDir (($f -replace '\.db\.zst$', '') + "-$Stamp.db.zst")
  if (-not (Test-Path $local)) { Fail "$f is not on disk after the download step" }
}

# ── 3. Retention (files only) ──
$d1Files = Get-ChildItem $D1Dir -Filter 'halseth-d1-*.sql.gz' | Sort-Object Name -Descending
$keep = @($d1Files | Select-Object -First 14)
$keep += $d1Files | Group-Object { $_.Name.Substring(11, 7) } | ForEach-Object { $_.Group | Sort-Object Name | Select-Object -First 1 } |
         Sort-Object Name -Descending | Select-Object -First 12
$d1Files | Where-Object { $keep.FullName -notcontains $_.FullName } | Remove-Item
Get-ChildItem $SbDir -Filter 'vault-queue-*.db.zst' | Sort-Object Name -Descending | Select-Object -Skip 14 | Remove-Item
Get-ChildItem $SbDir -Filter 'vector-store-*.db.zst' | Sort-Object Name -Descending | Select-Object -Skip 4 | Remove-Item

# ── 4. Marker: only now, after everything above verified ──
$marker = [ordered]@{
  d1_at = $now; d1_bytes = $d1Bytes; d1_verify = $d1Summary
  sb_at = if ($sbDue) { $now } else { $prev.sb_at }
  sb_rows = if ($sbDue) { $sbRows } else { $prev.sb_rows }
  vault_queue_at = $now
  host = $env:COMPUTERNAME; stamp = $Stamp
} | ConvertTo-Json -Compress
$marker | ssh @SshOpts vps 'cat > /app/logs/backup-last.json.tmp && mv /app/logs/backup-last.json.tmp /app/logs/backup-last.json'
if ($LASTEXITCODE -ne 0) { Fail 'backups verified but the VPS marker could not be written (health-check will warn)' }
Log "done ($mode)"
exit 0
