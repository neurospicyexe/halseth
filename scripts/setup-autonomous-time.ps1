# setup-autonomous-time.ps1
# Creates two Windows Task Scheduler tasks that trigger autonomous time for your
# AI companion via Claude Desktop + AutoHotKey.
#
# Run this once from an elevated PowerShell (right-click → Run as Administrator).
# After setup, the tasks fire automatically at the scheduled times.
#
# Requirements:
#   - AutoHotKey v2.0 installed: https://www.autohotkey.com
#   - Claude Desktop running (or at least available to launch)
#
# To remove the tasks later:
#   Unregister-ScheduledTask -TaskName "Halseth Autonomous Time - Morning" -Confirm:$false
#   Unregister-ScheduledTask -TaskName "Halseth Autonomous Time - Afternoon" -Confirm:$false

# ── Config — edit these ───────────────────────────────────────────────────────

# Full path to AutoHotKey v2 executable
$AhkExe = "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"

# Full path to the autonomous-time.ahk script (this folder)
$AhkScript = "$PSScriptRoot\autonomous-time.ahk"

# Schedule — days of the week to run (default: weekdays)
$Days = @("Monday", "Tuesday", "Wednesday", "Thursday", "Friday")

# Morning session time (24h format)
$MorningTime = "10:00"

# Afternoon session time (24h format)
$AfternoonTime = "14:00"

# ── Validation ────────────────────────────────────────────────────────────────

if (-not (Test-Path $AhkExe)) {
    Write-Error "AutoHotKey not found at: $AhkExe`nInstall AutoHotKey v2 from https://www.autohotkey.com"
    exit 1
}

if (-not (Test-Path $AhkScript)) {
    Write-Error "AHK script not found at: $AhkScript`nMake sure autonomous-time.ahk is in the same folder as this script."
    exit 1
}

# ── Create tasks ──────────────────────────────────────────────────────────────

$Action = New-ScheduledTaskAction -Execute $AhkExe -Argument "`"$AhkScript`""

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

    Register-ScheduledTask `
        -TaskName $Name `
        -Action $Action `
        -Trigger $Trigger `
        -Settings $Settings `
        -RunLevel Highest `
        -Description "Halseth autonomous companion time — fires $Time on weekdays." | Out-Null

    $DayList = $Days -join ', '
    Write-Host "Created: $Name at $Time on $DayList"
}

Register-AutonomousTask "Halseth Autonomous Time - Morning"   $MorningTime
Register-AutonomousTask "Halseth Autonomous Time - Afternoon" $AfternoonTime

$TestCmd = "Start-ScheduledTask -TaskName 'Halseth Autonomous Time - Morning'"
$ListCmd = "Get-ScheduledTask | Where-Object TaskName -like 'Halseth*'"
Write-Host ""
Write-Host "Done. Tasks will fire at $MorningTime and $AfternoonTime on weekdays."
Write-Host "To test immediately: $TestCmd"
Write-Host "To view tasks:       $ListCmd"
