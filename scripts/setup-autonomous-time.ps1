# setup-autonomous-time.ps1
# Registers Windows Task Scheduler entries for autonomous companion time.
# Run once as Administrator.
# Creates two daily triggers: 12:30 PM and 1:30 AM.

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

# Triggers
$Trigger1230PM = New-ScheduledTaskTrigger -Daily -At "12:30PM"
$Trigger130AM  = New-ScheduledTaskTrigger -Daily -At "1:30AM"

# Register 12:30 PM entry
Register-ScheduledTask `
    -TaskName "${TaskNamePrefix}-1230PM" `
    -Action $Action `
    -Trigger $Trigger1230PM `
    -Settings $Settings `
    -RunLevel Limited `
    -Force | Out-Null

# Register 1:30 AM entry
Register-ScheduledTask `
    -TaskName "${TaskNamePrefix}-0130AM" `
    -Action $Action `
    -Trigger $Trigger130AM `
    -Settings $Settings `
    -RunLevel Limited `
    -Force | Out-Null

Write-Host ""
Write-Host "Tasks registered:"
Write-Host "  ${TaskNamePrefix}-1230PM  -> 12:30 PM daily"
Write-Host "  ${TaskNamePrefix}-0130AM  ->  1:30 AM daily"
Write-Host ""
Write-Host "IMPORTANT -- secret setup required before tasks will work:"
Write-Host "  The PS1 loads HALSETH_SECRET from halseth\scripts\.env"
Write-Host "  Windows Task Scheduler runs in a session that does NOT inherit your shell env vars."
Write-Host "  The .env file is read directly by run-autonomous-time.ps1 (via autonomous-time-config.ps1)."
Write-Host "  Make sure halseth\scripts\.env exists and contains: HALSETH_SECRET=<your-admin-secret>"
Write-Host ""
Write-Host "Verify tasks with:"
Write-Host "  Get-ScheduledTask -TaskName '${TaskNamePrefix}*' | Select TaskName,State"
