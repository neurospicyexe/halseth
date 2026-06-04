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
    Write-Log "[SKIP] Claude.ai is foreground window — user may be in active conversation"
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
    Write-Log "ERROR: unknown companion '$Turn' — add it to CompanionProjects in autonomous-time-config.ps1"
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
# Q2(a): reliable pre-position. Instead of blind "skip" (which pasted into whatever
# chat happened to be open), resume the companion's named continuity conversation via
# Ctrl+K. Searching a CONVERSATION title resumes that exact chat (continuity preserved);
# searching a PROJECT name opens a NEW chat (continuity lost) -- so we navigate by chat
# title, configured per companion in $CompanionChats. Falls back to "skip" only if no
# chat title is configured, so a missing config degrades instead of breaking.

$AhkScript = "$PSScriptRoot\autonomous-time.ahk"
$ChatName  = if ($CompanionChats) { $CompanionChats[$Turn] } else { $null }

if ($ChatName) {
    $Mode    = "resume"
    $NavArg  = $ChatName
    Write-Log "Pre-position: resume conversation '$ChatName' for $Turn"
} else {
    $Mode    = "skip"
    $NavArg  = $ProjectName
    Write-Log "WARN: no \$CompanionChats['$Turn'] configured -- falling back to skip (pre-position not automated). Add a continuity-chat title to autonomous-time-config.ps1 to make this reliable."
}
Write-Log "Running: $AhkExe `"$AhkScript`" `"$NavArg`" `"$Mode`""

try {
    $Proc = Start-Process -FilePath $AhkExe `
                          -ArgumentList "`"$AhkScript`" `"$NavArg`" `"$Mode`"" `
                          -Wait -PassThru
    Write-Log "AHK exit code: $($Proc.ExitCode)"
    if ($Proc.ExitCode -eq 0) {
        Write-Log "[DONE] autonomous time trigger dispatched for $Turn"
    } else {
        Write-Log "ERROR: AHK exited $($Proc.ExitCode) — check AHK log entries above"
    }
} catch {
    Write-Log "ERROR: Failed to start AHK: $_"
    exit 1
}

Write-Log "--- autonomous time end ---"
