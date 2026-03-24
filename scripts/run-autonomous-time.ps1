# run-autonomous-time.ps1
# Runs the Halseth autonomous time protocol via Claude Code CLI.
# Called by Windows Task Scheduler (configured in setup-autonomous-time.ps1).
#
# Uses --dangerously-skip-permissions so MCP tool approval dialogs never block it.
# Output is appended to autonomous-time.log in the same folder.

$LogFile  = "$PSScriptRoot\autonomous-time.log"
$WorkDir  = "C:\dev\Bigger_Better_Halseth\halseth"
$Prompt   = "/halseth-autonomous-time"

function Write-Log {
    param([string]$Msg)
    $Stamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    "$Stamp $Msg" | Tee-Object -FilePath $LogFile -Append | Write-Host
}

Write-Log "--- autonomous time start ---"

# Verify claude CLI is available
$ClaudeExe = Get-Command "claude" -ErrorAction SilentlyContinue
if (-not $ClaudeExe) {
    Write-Log "ERROR: claude CLI not found in PATH. Is Claude Code installed?"
    exit 1
}

Write-Log "claude CLI found at: $($ClaudeExe.Source)"

# Run the autonomous time command headlessly.
# --dangerously-skip-permissions bypasses all MCP tool approval dialogs.
# --print (-p) runs non-interactively: Claude calls all needed tools and exits.
# Output is captured and appended to the log.
try {
    Push-Location $WorkDir
    Write-Log "Working directory: $WorkDir"
    Write-Log "Running: claude --dangerously-skip-permissions -p `"$Prompt`""

    $Output = & claude --dangerously-skip-permissions -p $Prompt 2>&1
    $ExitCode = $LASTEXITCODE

    foreach ($Line in ($Output -split "`n")) {
        if ($Line.Trim()) { Write-Log "  $Line" }
    }

    if ($ExitCode -eq 0) {
        Write-Log "--- autonomous time complete (exit 0) ---"
    } else {
        Write-Log "ERROR: claude exited with code $ExitCode"
    }
} catch {
    Write-Log "ERROR: $_"
} finally {
    Pop-Location
}
