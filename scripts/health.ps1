# health.ps1 -- "is everything okay?" in one command.
#
# December criterion 6 (docs/PLAN-2026-08-to-12-solid-by-december.md): "Raziel can ask 'is everything
# okay?' and get an answer in one command."
#
#   pwsh -File scripts/health.ps1           # the failures only
#   pwsh -File scripts/health.ps1 -All      # every check
#   pwsh -File scripts/health.ps1 -Json     # machine-readable
#
# This is a THIN WRAPPER on purpose. The check itself lives at nullsafe-discord/ops/health-check.py on
# the VPS, because that is the only place that can see pm2, systemd, the hermes user units AND reach
# Halseth from outside -- a liveness check inside its own subject is theater. Reimplementing any of it
# here would create a second authority that disagrees with the cron's answer at 3am.
#
# Exit code passes through: 0 ok/notice, 1 warning, 2 red, 3 the check itself broke.
#
# Prints no secrets. It never handles any -- the script on the VPS reads them from env files there.

param(
    [switch]$All,
    [switch]$Json,
    [switch]$Verbose
)

$flags = @()
if ($All)     { $flags += "--all" }
if ($Json)    { $flags += "--json" }
if ($Verbose) { $flags += "--verbose" }

$remote = "cd /app/nullsafe-discord && /usr/bin/python3 ops/health-check.py $($flags -join ' ')"

# `ssh vps` (user nullsafe) is pre-configured in ~/.ssh/config. PowerShell, not Bash, on Windows --
# the Git-Bash ssh hits "error in libcrypto" against these keys.
ssh vps $remote
$code = $LASTEXITCODE

if (-not $Json) {
    Write-Host ""
    switch ($code) {
        0 { Write-Host "verdict: OK (nothing needs you)" -ForegroundColor Green }
        1 { Write-Host "verdict: WARNING (something wants attention, nothing is down)" -ForegroundColor Yellow }
        2 { Write-Host "verdict: RED (something is down)" -ForegroundColor Red }
        3 { Write-Host "verdict: the health check itself failed -- treat as unknown, not as healthy" -ForegroundColor Magenta }
        default { Write-Host "verdict: unexpected exit code $code" -ForegroundColor Magenta }
    }
    Write-Host "the same check runs every 15m on the VPS and posts to Telegram on change / recovery / every 12h." -ForegroundColor DarkGray
}

exit $code
