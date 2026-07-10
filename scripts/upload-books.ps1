# upload-books.ps1 -- bulk-load a folder of epubs/pdfs into the Library (migration 0099).
#
#   .\scripts\upload-books.ps1 -Folder "D:\books"
#   .\scripts\upload-books.ps1 -Folder "D:\books" -Replace   # overwrite duplicates
#
# Metadata (title/author/description/cover) is extracted server-side from each epub;
# no per-file arguments needed. Duplicates (same title+author) are skipped with a
# note unless -Replace is passed. Requires PowerShell 7 (Invoke-RestMethod -Form).
#
# Auth: reads HALSETH_URL and HALSETH_SECRET from the environment, falling back to
# the halseth .dev.vars ADMIN_SECRET convention if HALSETH_SECRET is unset.

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
foreach ($book in $books) {
  $form = @{ file = $book }
  if ($Replace) { $form["replace"] = "true" }
  try {
    $res = Invoke-RestMethod -Uri "$HalsethUrl/mind/books" -Method Post `
      -Headers @{ Authorization = "Bearer $Secret" } -Form $form
    Write-Host ("  + {0}  ->  '{1}'{2}" -f $book.Name, $res.book.title, $(if ($res.book.replaced) { " (replaced)" } else { "" })) -ForegroundColor Green
    $ok++
  } catch {
    $status = $_.Exception.Response.StatusCode.value__
    if ($status -eq 409) {
      Write-Host ("  = {0}  already in the library (pass -Replace to overwrite)" -f $book.Name) -ForegroundColor Yellow
      $skipped++
    } else {
      Write-Host ("  x {0}  FAILED ({1}): {2}" -f $book.Name, $status, $_.ErrorDetails.Message) -ForegroundColor Red
      $failed++
    }
  }
}
Write-Host ""
Write-Host ("Done. {0} uploaded, {1} skipped as duplicates, {2} failed." -f $ok, $skipped, $failed) -ForegroundColor Cyan
if ($failed -gt 0) { exit 1 }
