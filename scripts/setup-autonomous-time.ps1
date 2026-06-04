# setup-autonomous-time.ps1
# Registers Windows Task Scheduler entries for autonomous companion time.
# Run once as Administrator.
# Creates ONE daily trigger: 1:30 AM (single night slot, Q3 2026-06-04).
# The old 12:30 PM daytime slot was removed -- it skipped on any active workday once the
# idle guard was fixed, so a single reliable nighttime run is cleaner. The prefix cleanup
# below removes the old 1230PM task on next run.

#Requires -RunAsAdministrator

$TaskNamePrefix = "Halseth-AutonomousTime"
$ScriptPath     = "$PSScriptRoot\run-autonomous-time.ps1"
$PsExe          = "powershell.exe"
$PsArgs         = "-NonInteractive -WindowStyle Hidden -File `"$ScriptPath`""

# Remove existing tasks with this prefix
Get-ScheduledTask -TaskName "$TaskNamePrefix*" -ErrorAction SilentlyContinue |
    ForEach-Object {
        Write-Host "Removing existing task: $($_.TaskName)"
        Unregister-ScheduledTask -TaskName $_.TaskName -Confirm:$false
    }

# Task action: run the PS1
$Action = New-ScheduledTaskAction `
    -Execute $PsExe `
    -Argument $PsArgs `
    -WorkingDirectory $PSScriptRoot

# Settings: run when logged on, battery-friendly, start if missed
$Settings = New-ScheduledTaskSettingsSet `
    -ExecutionTimeLimit (New-TimeSpan -Hours 1) `
    -StartWhenAvailable `
    -DontStopIfGoingOnBatteries `
    -AllowStartIfOnBatteries

# Trigger: single nightly slot
$Trigger130AM = New-ScheduledTaskTrigger -Daily -At "1:30AM"

# Register 1:30 AM entry
Register-ScheduledTask `
    -TaskName "${TaskNamePrefix}-0130AM" `
    -Action $Action `
    -Trigger $Trigger130AM `
    -Settings $Settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host ""
Write-Host "Task registered:"
Write-Host "  ${TaskNamePrefix}-0130AM  ->  1:30 AM daily (single night slot)"
Write-Host ""
Write-Host "IMPORTANT -- secret setup required before tasks will work:"
Write-Host "  The PS1 loads HALSETH_SECRET from halseth\scripts\.env"
Write-Host "  Windows Task Scheduler runs in a session that does NOT inherit your shell env vars."
Write-Host "  The .env file is read directly by run-autonomous-time.ps1 (via autonomous-time-config.ps1)."
Write-Host "  Make sure halseth\scripts\.env exists and contains: HALSETH_SECRET=<your-admin-secret>"
Write-Host ""
Write-Host "Verify tasks with:"
Write-Host "  Get-ScheduledTask -TaskName '${TaskNamePrefix}*' | Select TaskName,State"
