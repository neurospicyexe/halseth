<#
register-backup-task.ps1 (2026-10-27) -- schedule backup-nullsafe.ps1 daily at 04:40 as the current user.

Runs only while this user is signed in (Interactive): that is what gives the task this profile's
wrangler OAuth login and ~/.ssh keys. "Run whether logged on or not" would run without them and fail
silently at 4am. StartWhenAvailable catches a run missed while the PC was asleep or off. If it still
does not run, the VPS health check warns on Telegram after 36h (check_backups).
Re-running this replaces the task.
#>
$ErrorActionPreference = 'Stop'
$script = Join-Path $PSScriptRoot 'backup-nullsafe.ps1'
$pwsh = (Get-Command pwsh).Source
$action = New-ScheduledTaskAction -Execute $pwsh -Argument "-NoProfile -NonInteractive -WindowStyle Hidden -File `"$script`""
$trigger = New-ScheduledTaskTrigger -Daily -At 4:40am
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName 'Nullsafe Backup' -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Verified backups of Halseth D1 + Second Brain to Documents\Nullsafe-Backups (halseth/scripts/backup).' -Force | Out-Null
Get-ScheduledTask -TaskName 'Nullsafe Backup' | Select-Object TaskName, State
