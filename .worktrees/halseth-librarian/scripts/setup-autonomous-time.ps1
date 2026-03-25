# setup-autonomous-time.ps1
# Creates two Windows Task Scheduler tasks that trigger autonomous time for your
# AI companion.
#
# Run this once from an elevated PowerShell (right-click, Run as Administrator).
# After setup, the tasks fire automatically at the scheduled times.
#
# Mode: "cli" (default, recommended) — runs via Claude Code CLI headlessly.
#       "desktop" — uses AutoHotKey to type into Claude Desktop.
#
# CLI mode requires the claude CLI in PATH. It uses --dangerously-skip-permissions
# so MCP tool approval dialogs never block an unattended session.
#
# Desktop mode requires AutoHotKey v2 and Claude Desktop running.
# Note: Desktop mode can silently fail if new MCP tools haven't had "Always allow"
# clicked yet. If sessions stall with "No approval received", use CLI mode instead.
#
# To remove the tasks later:
#   Unregister-ScheduledTask -TaskName "Halseth Autonomous Time - Morning" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Halseth Autonomous Time - Afternoon" -Confirm:$false

# --- Config (edit these) ---------------------------------------------------

# "cli" = Claude Code CLI (recommended, no approval dialogs)
# "desktop" = AutoHotKey + Claude Desktop
$Mode = "cli"

# Days of the week to run
$Days = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

# Night session time (24h format)
$MorningTime = "01:30"

# Midday session time (24h format)
$AfternoonTime = "12:30"

# CLI mode: path to the run-autonomous-time.ps1 runner
$CliRunner = "$PSScriptRoot\run-autonomous-time.ps1"

# Desktop mode: paths to AutoHotKey and the AHK script
$AhkExe    = "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"
$AhkScript = "$PSScriptRoot\autonomous-time.ahk"

# --- Validation -------------------------------------------------------------

if ($Mode -eq "cli") {
    $ClaudeExe = Get-Command "claude" -ErrorAction SilentlyContinue
    if (-not $ClaudeExe) {
        Write-Error "claude CLI not found in PATH. Install Claude Code or switch to Mode=desktop."
        exit 1
    }
    if (-not (Test-Path $CliRunner)) {
        Write-Error "CLI runner not found at: $CliRunner"
        exit 1
    }
    Write-Host "Mode: CLI (claude at $($ClaudeExe.Source))"
} else {
    if (-not (Test-Path $AhkExe)) {
        Write-Error "AutoHotKey not found at: $AhkExe"
        Write-Error "Install AutoHotKey v2 from https://www.autohotkey.com or switch to Mode=cli."
        exit 1
    }
    if (-not (Test-Path $AhkScript)) {
        Write-Error "AHK script not found at: $AhkScript"
        exit 1
    }
    Write-Host "Mode: Desktop (AHK at $AhkExe)"
}

# --- Create tasks -----------------------------------------------------------

if ($Mode -eq "cli") {
    $PwshExe = (Get-Command "pwsh" -ErrorAction SilentlyContinue)?.Source
    if (-not $PwshExe) { $PwshExe = "powershell.exe" }
    $Action = New-ScheduledTaskAction -Execute $PwshExe -Argument "-NonInteractive -File `"$CliRunner`""
} else {
    $Action = New-ScheduledTaskAction -Execute $AhkExe -Argument "`"$AhkScript`""
}

$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries

function Register-AutonomousTask {
    param($Name, $Time)

    $Trigger = New-ScheduledTaskTrigger -Weekly -DaysOfWeek $Days -At $Time

    $existing = Get-ScheduledTask -TaskName $Name -ErrorAction SilentlyContinue
    if ($existing) {
        Unregister-ScheduledTask -TaskName $Name -Confirm:$false
        Write-Host "Replaced existing task: $Name"
    }

    $Desc = "Halseth autonomous companion time, fires at $Time daily."

    Register-ScheduledTask `
        -TaskName $Name `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -RunLevel Highest `
        -Description $Desc | Out-Null

    $DayList = $Days -join ', '
    Write-Host "Created: $Name at $Time on $DayList"
}

Register-AutonomousTask "Halseth Autonomous Time - Morning"   $MorningTime
Register-AutonomousTask "Halseth Autonomous Time - Afternoon" $AfternoonTime

Write-Host ""
Write-Host "Done. Tasks will fire at $MorningTime and $AfternoonTime daily."
Write-Host "To test now:     Start-ScheduledTask -TaskName 'Halseth Autonomous Time - Morning'"
Write-Host "To list tasks:   Get-ScheduledTask | Where-Object { `$_.TaskName -like 'Halseth*' }"
