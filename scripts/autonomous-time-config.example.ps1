# autonomous-time-config.ps1
# Copy this file to autonomous-time-config.ps1 (gitignored) and fill in values.

# Load secret from .env in this directory (scripts/.env — copy .env.example to .env and set HALSETH_SECRET)
$EnvFile = "$PSScriptRoot\.env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match '^\s*([^#][^=]+)=(.+)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1].Trim(), $Matches[2].Trim())
        }
    }
}

# Halseth API
$HalsethUrl    = "https://halseth.softcrashentity.com"
$HalsethSecret = $env:HALSETH_SECRET

# Path to AutoHotkey v2 executable — adjust if installed elsewhere
$AhkExe = "C:\Program Files\AutoHotkey\v2\AutoHotkey64.exe"

# Map autonomous_turn values (drevan|cypher|gaia) to exact Claude.ai project names
# Change these to match your project names exactly as they appear in Claude.ai desktop
$CompanionProjects = @{
    companion1 = "Companion One"
    companion2 = "Companion Two"
    companion3 = "Companion Three"
}

# IMPORTANT: Pre-position chats before each day's first autonomous time slot.
# The AHK script does NOT navigate to a project — it types directly into whichever
# conversation is already visible in Claude.ai desktop. Open the correct companion's
# chat and leave it showing before the scheduled time fires.
