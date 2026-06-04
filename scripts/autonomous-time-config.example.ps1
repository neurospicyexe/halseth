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
$HalsethUrl    = "https://halseth.example.com"
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

# Map autonomous_turn values to each companion's pinned CONTINUITY CONVERSATION title
# (NOT the project name). The orchestrator passes this to the AHK in "resume" mode:
# Ctrl+K searches the title and Enter resumes that exact chat, so autonomous time lands
# in the same ongoing conversation every run (continuity preserved) without you having to
# pre-position anything by hand.
#
# Requirements for reliable resume:
#   - Give each companion's continuity chat a DISTINCT title that ranks #1 in Ctrl+K
#     search for the string below (rename the chat in Claude.ai if needed).
#   - If a companion is omitted here, that run falls back to "skip" mode (pastes into
#     whatever chat is open — the old fragile behavior).
$CompanionChats = @{
    companion1 = "Companion One — continuity"
    companion2 = "Companion Two — continuity"
    companion3 = "Companion Three — continuity"
}
