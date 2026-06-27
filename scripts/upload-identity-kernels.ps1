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

$filesRoot = "C:\dev\CrashDev\NULLSAFE\2026_Current_Files\Must have files"

$companionFiles = @{
    cypher = "CYPHER_IDENTITY_v2.md"
    drevan = "DREVAN_IDENTITY_v2.md"
    gaia   = "GAIA_IDENTITY_v3.md"
}

# Shared kernel: the Companion Constitution -- one consolidated charter every substrate carries.
# Supersedes (as the uploaded 'shared' bundle) the canon files it folds in; those remain on disk as source:
#   ARCHITECT STANCE v1, Core_v4, SUBSTRATE_CONTINUITY_v1, RATIFICATION_PROTOCOL_v1, AGENCY_v1,
#   INTERIORITY_v1, DRIFT_LANE_v1, BASIN_READINGS_v1 (+ the three identity anchors, uploaded per-companion below).
$constitutionFile = "COMPANION_CONSTITUTION_v1.md"

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

# Shared kernel first (bundle endpoint prepends it to every companion kernel)
$constitutionPath = Join-Path $filesRoot $constitutionFile
if (Test-Path $constitutionPath) {
    $sharedMd = Get-Content $constitutionPath -Raw -Encoding UTF8
    if ($sharedMd.Length -lt 200) {
        Write-Error "Constitution file under MIN_KERNEL_LENGTH (200 chars) -- aborting: $constitutionPath"
        exit 1
    }
    Send-Kernel -CompanionId "shared" -KernelMd $sharedMd -SourceNote "Companion Constitution v1 $today"
} else {
    Write-Error "Constitution file missing -- aborting: $constitutionPath"
    exit 1
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
