# lmstudio-tunnel.ps1
# Persistent reverse SSH tunnel exposing this workstation's LM Studio server
# (127.0.0.1:1234) on the VPS at 127.0.0.1:11435. The Discord bots and Brain
# read LMSTUDIO_URL=http://127.0.0.1:11435 -- no public exposure, no auth surface.
#
# Runs at logon via a Startup-folder shortcut (created 2026-06-10):
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <this file>
#
# Reconnects forever with a 15s backoff. When this machine or LM Studio is off,
# the VPS side gets connection-refused instantly and the inference fallback
# chain moves to the next rung -- absence is cheap by design.
#
# NOTE: keep this file pure ASCII. powershell.exe 5.1 misreads no-BOM UTF-8
# punctuation as string delimiters (see run-autonomous-time.ps1, 2026-06-09).

$LogFile = "$PSScriptRoot\lmstudio-tunnel.log"

function Write-Log {
    param([string]$Msg)
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Msg" | Add-Content -Path $LogFile
}

# Trim the log when it grows past ~1MB (this loop runs for months).
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
    Get-Content $LogFile -Tail 200 | Set-Content $LogFile
}

Write-Log "--- tunnel supervisor start ---"

# Bring the LM Studio server up at logon (idempotent if already running).
# JIT model loading means any downloaded model id is servable on request.
$Lms = "$env:USERPROFILE\.lmstudio\bin\lms.exe"
if (Test-Path $Lms) {
    try {
        & $Lms server start 2>&1 | ForEach-Object { Write-Log "lms: $_" }
    } catch {
        Write-Log "lms server start failed: $_ (LM Studio may need a manual launch)"
    }
}

while ($true) {
    Write-Log "connecting: VPS 127.0.0.1:11435 -> workstation 127.0.0.1:1234"
    # -N no command; ExitOnForwardFailure makes a stale remote bind fatal so the
    # loop retries instead of holding a half-open session; ServerAlive detects
    # dead links within ~90s.
    ssh -N `
        -o ExitOnForwardFailure=yes `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ConnectTimeout=10 `
        -R 127.0.0.1:11435:127.0.0.1:1234 `
        vps 2>&1 | Out-Null
    Write-Log "tunnel exited (code $LASTEXITCODE); retry in 15s"
    Start-Sleep -Seconds 15
}
