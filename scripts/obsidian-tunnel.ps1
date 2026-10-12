# obsidian-tunnel.ps1
# Persistent reverse SSH tunnel exposing this workstation's Obsidian Local REST
# API (127.0.0.1:27124, HTTPS) on the VPS at 127.0.0.1:27124. Second Brain's
# obsidian-rest adapter dials https://127.0.0.1:27124 and trusts the plugin's
# self-signed cert via NODE_EXTRA_CA_CERTS (cert SAN is IP 127.0.0.1, so the
# same port on both ends keeps hostname verification passing).
#
# Replaces the obsidian.softcrashentity.com ingress that rode the lmstudio
# Cloudflare tunnel until K16 closed it (2026-10-07). See STATUS K17.
#
# Runs at logon via a Startup-folder shortcut:
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File <this file>
#
# Reconnects forever with a 15s backoff. When this machine or Obsidian is off,
# vault writes land in the adapter's SQLite queue and drain once the tunnel and
# Obsidian are both back -- absence is cheap by design.
#
# NOTE: keep this file pure ASCII. powershell.exe 5.1 misreads no-BOM UTF-8
# punctuation as string delimiters (see run-autonomous-time.ps1, 2026-06-09).

$LogFile = "$PSScriptRoot\obsidian-tunnel.log"

function Write-Log {
    param([string]$Msg)
    "$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss') $Msg" | Add-Content -Path $LogFile
}

# Trim the log when it grows past ~1MB (this loop runs for months).
if ((Test-Path $LogFile) -and ((Get-Item $LogFile).Length -gt 1MB)) {
    Get-Content $LogFile -Tail 200 | Set-Content $LogFile
}

Write-Log "--- tunnel supervisor start ---"

while ($true) {
    Write-Log "connecting: VPS 127.0.0.1:27124 -> workstation 127.0.0.1:27124"
    # -N no command; ExitOnForwardFailure makes a stale remote bind fatal so the
    # loop retries instead of holding a half-open session; ServerAlive detects
    # dead links within ~90s. BatchMode so a key prompt can never hang a hidden
    # window forever.
    ssh -N `
        -o BatchMode=yes `
        -o ExitOnForwardFailure=yes `
        -o ServerAliveInterval=30 `
        -o ServerAliveCountMax=3 `
        -o ConnectTimeout=10 `
        -R 127.0.0.1:27124:127.0.0.1:27124 `
        vps 2>&1 | Out-Null
    Write-Log "tunnel exited (code $LASTEXITCODE); retry in 15s"
    Start-Sleep -Seconds 15
}
