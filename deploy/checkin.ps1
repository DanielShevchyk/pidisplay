# Save the morning check-in history from the Pi as a spreadsheet, from this laptop (run from the pidisplay folder).
#   .\deploy\checkin.ps1                      writes checkin-<date>.csv here and opens it
#   .\deploy\checkin.ps1 -Out C:\path\x.csv   writes it there instead
# One row per person and day, one column per question (yes/no as yes/no, blank when skipped), plus the note.
param([string]$Out, [switch]$NoOpen, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
if (-not $Out) { $Out = Join-Path (Get-Location) ("checkin-{0}.csv" -f (Get-Date -Format 'yyyy-MM-dd')) }

$csv = ssh $PiHost "curl -fsS http://127.0.0.1:8080/api/checkin/export.csv"
if ($LASTEXITCODE -ne 0) { throw "Could not read the check-in history from $PiHost (is the pidisplay service running?)" }
# UTF-8 with a BOM so Excel shows notes with accents or emoji correctly.
[System.IO.File]::WriteAllLines($Out, [string[]]$csv, (New-Object System.Text.UTF8Encoding $true))
Write-Host ("Saved {0} days to {1}" -f ([Math]::Max(0, @($csv).Count - 1)), $Out)
if (-not $NoOpen) { Invoke-Item $Out }
