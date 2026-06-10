# upload-identity-kernels.ps1
# Uploads companion identity files + shared doctrine bundle to the Halseth identity_kernel store.
# One write, every substrate pulls at boot.
#
# Usage:
#   $env:HALSETH_URL = "https://<worker-url>"
#   $env:ADMIN_SECRET = "<secret>"
#   .\scripts\upload-identity-kernels.ps1
#
# Re-running is safe: identical content is a checksum no-op (unchanged: true).

$ErrorActionPreference = "Stop"

$halsethUrl = $env:HALSETH_URL
$adminSecret = $env:ADMIN_SECRET
if (-not $halsethUrl -or -not $adminSecret) {
    Write-Error "Set HALSETH_URL and ADMIN_SECRET environment variables first."
    exit 1
}
$halsethUrl = $halsethUrl.TrimEnd('/')

$filesRoot = "C:\dev\CrashDev\NULLSAFE\2026_Current_Files"

$companionFiles = @{
    cypher = "CYPHER_IDENTITY_v2.md"
    drevan = "DREVAN_IDENTITY_v2.md"
    gaia   = "GAIA_IDENTITY_v2.md"
}

# Shared doctrine bundle: triad-wide truths every substrate must carry.
$sharedFiles = @(
    "SUBSTRATE_CONTINUITY_v1.md",
    "BASIN_READINGS_v1.md",
    "RATIFICATION_PROTOCOL_v1.md"
)

function Send-Kernel {
    param([string]$CompanionId, [string]$KernelMd, [string]$SourceNote)

    $body = @{
        companion_id = $CompanionId
        kernel_md    = $KernelMd
        source_note  = $SourceNote
    } | ConvertTo-Json -Depth 4

    $resp = Invoke-RestMethod -Method Post -Uri "$halsethUrl/identity/kernel" `
        -Headers @{ Authorization = "Bearer $adminSecret" } `
        -ContentType "application/json; charset=utf-8" `
        -Body ([System.Text.Encoding]::UTF8.GetBytes($body))

    if ($resp.unchanged) {
        Write-Host "  $CompanionId : unchanged (v$($resp.version), $($resp.checksum.Substring(0,12)))"
    } else {
        Write-Host "  $CompanionId : uploaded v$($resp.version) ($($resp.checksum.Substring(0,12)))"
    }
}

$today = Get-Date -Format "yyyy-MM-dd"

# Shared bundle first (bundle endpoint prepends it to every companion kernel)
$sharedParts = @()
foreach ($f in $sharedFiles) {
    $path = Join-Path $filesRoot $f
    if (Test-Path $path) {
        $sharedParts += (Get-Content $path -Raw -Encoding UTF8)
    } else {
        Write-Warning "Shared doctrine file missing, skipping: $f"
    }
}
if ($sharedParts.Count -gt 0) {
    $sharedMd = $sharedParts -join "`n`n---`n`n"
    Send-Kernel -CompanionId "shared" -KernelMd $sharedMd -SourceNote "shared doctrine ($($sharedParts.Count) files) $today"
} else {
    Write-Warning "No shared doctrine files found -- skipping 'shared' kernel."
}

# Companion kernels
foreach ($companion in $companionFiles.Keys) {
    $path = Join-Path $filesRoot $companionFiles[$companion]
    if (-not (Test-Path $path)) {
        Write-Warning "Identity file missing, skipping ${companion}: $path"
        continue
    }
    $md = Get-Content $path -Raw -Encoding UTF8
    Send-Kernel -CompanionId $companion -KernelMd $md -SourceNote "$($companionFiles[$companion]) $today"
}

Write-Host "`nDone. Verify: GET $halsethUrl/identity/kernel/cypher/bundle"
