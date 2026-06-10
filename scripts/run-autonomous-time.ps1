# run-autonomous-time.ps1
# Autonomous companion time orchestrator.
# Called by Windows Task Scheduler at 12:30 PM and 1:30 AM.
# Checks idle/foreground conditions, reads autonomous_turn from Halseth,
# then dispatches autonomous-time.ahk to Claude.ai desktop.

$LogFile = "$PSScriptRoot\autonomous-time.log"

function Write-Log {
    param([string]$Msg)
    $Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$Stamp $Msg" | Tee-Object -FilePath $LogFile -Append | Write-Host
}

Write-Log "--- autonomous time start ---"

# ── Load config ────────────────────────────────────────────────────────────────

$ConfigFile = "$PSScriptRoot\personal\autonomous-time-config.ps1"
if (-not (Test-Path $ConfigFile)) {
    $ConfigFile = "$PSScriptRoot\autonomous-time-config.ps1"
}
if (-not (Test-Path $ConfigFile)) {
    Write-Log "ERROR: autonomous-time-config.ps1 not found."
    Write-Log "  Expected at: $PSScriptRoot\personal\autonomous-time-config.ps1"
    Write-Log "  Fallback:    $PSScriptRoot\autonomous-time-config.ps1"
    exit 1
}
. $ConfigFile

if (-not $HalsethSecret) {
    Write-Log "ERROR: HALSETH_SECRET is empty. Check your .env file in the scripts directory."
    exit 1
}

# ── Single-slot + once-daily guards ──────────────────────────────────────────
# Q3 decided 2026-06-09: one reliable nighttime slot. Four scheduler tasks exist on this
# machine (two stale duplicates from 03-24 + the 03-26 pair) and disabling them requires
# elevation, so the policy is enforced here instead: only run in the night window, and
# never twice in one calendar day (two tasks both fire at 1:30 AM).

$Now = Get-Date
if ($Now.Hour -ge 6) {
    Write-Log "[SKIP] outside night window (hour=$($Now.Hour), window is 00:00-05:59) -- single-slot policy"
    exit 0
}

$StampFile = "$PSScriptRoot\autonomous-time.last-run"
$Today     = $Now.ToString("yyyy-MM-dd")
if ((Test-Path $StampFile) -and ((Get-Content $StampFile -TotalCount 1) -eq $Today)) {
    Write-Log "[SKIP] already ran today ($Today) -- duplicate trigger suppressed"
    exit 0
}

# ── Idle check ────────────────────────────────────────────────────────────────
# Skip if the user has been active within the last 2 minutes.

$IdleCode = @"
using System;
using System.Runtime.InteropServices;
public class IdleTime {
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }
    public static uint GetIdleSeconds() {
        var info = new LASTINPUTINFO();
        info.cbSize = (uint)Marshal.SizeOf(info);
        GetLastInputInfo(ref info);
        // dwTime is a 32-bit GetTickCount value (wraps every ~49.7 days). Compare in the
        // same unsigned domain: take the low 32 bits of TickCount64 and subtract unsigned,
        // so a single wrap is handled by modular arithmetic. The old code used signed
        // Environment.TickCount, which goes negative after ~24.9 days uptime and produced
        // a ~4.29e9 idle reading that permanently disabled the active-user skip.
        uint nowTicks = unchecked((uint)Environment.TickCount64);
        uint idleMs   = unchecked(nowTicks - info.dwTime);
        return idleMs / 1000;
    }
}
"@

Add-Type -TypeDefinition $IdleCode -Language CSharp
$IdleSeconds = [IdleTime]::GetIdleSeconds()
Write-Log "Idle seconds: $IdleSeconds"

if ($IdleSeconds -lt 120) {
    Write-Log "[SKIP] user active (idle ${IdleSeconds}s < 120s)"
    exit 0
}

# ── Foreground check ──────────────────────────────────────────────────────────
# Skip if Claude.ai desktop is currently the foreground window.

$FgCode = @"
using System;
using System.Runtime.InteropServices;
public class ForegroundWindow {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();
}
"@

Add-Type -TypeDefinition $FgCode -Language CSharp
$FgHwnd = [ForegroundWindow]::GetForegroundWindow()

$ClaudeProc = Get-Process -Name "claude" -ErrorAction SilentlyContinue |
              Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
              Select-Object -First 1

if ($ClaudeProc -and $ClaudeProc.MainWindowHandle -eq $FgHwnd) {
    Write-Log "[SKIP] Claude.ai is foreground window -- user may be in active conversation"
    exit 0
}

# ── Read autonomous_turn from Halseth ─────────────────────────────────────────

try {
    $Headers    = @{ Authorization = "Bearer $HalsethSecret" }
    $HouseState = Invoke-RestMethod -Uri "$HalsethUrl/house" -Headers $Headers -Method Get
    $Turn       = $HouseState.autonomous_turn
    Write-Log "autonomous_turn: $Turn"
} catch {
    Write-Log "ERROR: Halseth /house call failed: $_"
    exit 1
}

if (-not $Turn) {
    Write-Log "ERROR: autonomous_turn is empty or null in Halseth response"
    exit 1
}

# ── Map companion to Claude.ai project name ───────────────────────────────────

$ProjectName = $CompanionProjects[$Turn]
if (-not $ProjectName) {
    Write-Log "ERROR: unknown companion '$Turn' -- add it to CompanionProjects in autonomous-time-config.ps1"
    exit 1
}

Write-Log "Dispatching: companion=$Turn project='$ProjectName'"

# ── Verify AHK is available ───────────────────────────────────────────────────

if (-not (Test-Path $AhkExe)) {
    Write-Log "ERROR: AutoHotkey not found at: $AhkExe"
    Write-Log "  Install AHK v2 from https://www.autohotkey.com or update AhkExe in autonomous-time-config.ps1"
    exit 1
}

# ── Dispatch AHK ──────────────────────────────────────────────────────────────
# Q2(b) decided 2026-06-09: fresh-chat-per-run. Ctrl+K with the PROJECT name opens a
# NEW chat in that project -- always lands in the right place. In-chat continuity is
# deliberately given up: continuity lives in Halseth orient (handover + threads + notes),
# which the boot protocol loads anyway. Resume-mode (Q2a) remains in the AHK for manual
# use but is no longer the scheduled path; it depended on a pinned-chat title staying
# stable and ranked first in Ctrl+K search results.

$AhkScript = "$PSScriptRoot\autonomous-time.ahk"
$Mode      = "navigate"
$NavArg    = $ProjectName
Write-Log "Dispatch: fresh chat in project '$ProjectName' for $Turn (navigate mode)"
Write-Log "Running: $AhkExe `"$AhkScript`" `"$NavArg`" `"$Mode`""

try {
    $Proc = Start-Process -FilePath $AhkExe `
                          -ArgumentList "`"$AhkScript`" `"$NavArg`" `"$Mode`"" `
                          -Wait -PassThru
    Write-Log "AHK exit code: $($Proc.ExitCode)"
    if ($Proc.ExitCode -eq 0) {
        # Stamp the once-daily lock only on successful dispatch, so a failed run
        # (claude.exe not running, focus stolen) doesn't burn the day's slot.
        $Today | Set-Content -Path $StampFile
        Write-Log "[DONE] autonomous time trigger dispatched for $Turn"
    } else {
        Write-Log "ERROR: AHK exited $($Proc.ExitCode) -- check AHK log entries above"
    }
} catch {
    Write-Log "ERROR: Failed to start AHK: $_"
    exit 1
}

Write-Log "--- autonomous time end ---"
