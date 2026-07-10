# upload-books.ps1 -- bulk-load a folder of epubs/pdfs into the Library (migration 0099).
#
#   .\scripts\upload-books.ps1 -Folder "D:\books"
#   .\scripts\upload-books.ps1 -Folder "D:\books" -Replace   # overwrite duplicates
#
# Metadata (title/author/description/cover) is extracted server-side from each epub;
# no per-file arguments needed. Duplicates (same title+author) are skipped with a
# note unless -Replace is passed.
#
# Transport is curl.exe (ships with Windows 10+), NOT Invoke-RestMethod -Form:
# workerd's request.formData() rejects PowerShell 7's multipart encoding
# (quoted boundary / part-header decoration) with a 400, verified 2026-07-10.
#
# Auth: reads HALSETH_URL and HALSETH_SECRET from the environment.

param(
  [Parameter(Mandatory = $true)] [string]$Folder,
  [switch]$Replace,
  [string]$HalsethUrl = $env:HALSETH_URL,
  [string]$Secret = $env:HALSETH_SECRET
)

if (-not $HalsethUrl) { $HalsethUrl = "https://halseth.neurospicyexe.workers.dev" }
if (-not $Secret) {
  Write-Error "Set HALSETH_SECRET (or pass -Secret). Refusing to guess an auth token."
  exit 1
}
if (-not (Test-Path $Folder)) {
  Write-Error "Folder not found: $Folder"
  exit 1
}

$books = Get-ChildItem -Path $Folder -Include *.epub, *.pdf -Recurse -File
if ($books.Count -eq 0) {
  Write-Host "No .epub or .pdf files under $Folder"
  exit 0
}
Write-Host "Uploading $($books.Count) book(s) to $HalsethUrl ..." -ForegroundColor Cyan

$ok = 0; $skipped = 0; $failed = 0
$bodyFile = Join-Path ([IO.Path]::GetTempPath()) "upload-books-response.json"
foreach ($book in $books) {
  # curl -F: the @"..." quoting protects commas/semicolons in filenames (both are
  # -F metacharacters, and book filenames are full of them).
  $curlArgs = @(
    "-s", "-o", $bodyFile, "-w", "%{http_code}",
    "-X", "POST", "$HalsethUrl/mind/books",
    "-H", "Authorization: Bearer $Secret",
    "-F", ('file=@"{0}"' -f $book.FullName)
  )
  if ($Replace) { $curlArgs += @("-F", "replace=true") }
  $status = [int](curl.exe @curlArgs)
  $body = if (Test-Path $bodyFile) { Get-Content $bodyFile -Raw | ConvertFrom-Json } else { $null }
  if ($status -eq 201) {
    Write-Host ("  + {0}  ->  '{1}'{2}" -f $book.Name, $body.book.title, $(if ($body.book.replaced) { " (replaced)" } else { "" })) -ForegroundColor Green
    $ok++
  } elseif ($status -eq 409) {
    Write-Host ("  = {0}  already in the library (pass -Replace to overwrite)" -f $book.Name) -ForegroundColor Yellow
    $skipped++
  } else {
    Write-Host ("  x {0}  FAILED ({1}): {2}" -f $book.Name, $status, ($body | ConvertTo-Json -Compress)) -ForegroundColor Red
    $failed++
  }
}
Remove-Item $bodyFile -ErrorAction SilentlyContinue
Write-Host ""
Write-Host ("Done. {0} uploaded, {1} skipped as duplicates, {2} failed." -f $ok, $skipped, $failed) -ForegroundColor Cyan
if ($failed -gt 0) { exit 1 }
