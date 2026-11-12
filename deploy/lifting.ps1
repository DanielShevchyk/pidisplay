# Lifting tracker helpers, run from the pidisplay folder on this laptop (docs/LIFTING.md).
#   .\deploy\lifting.ps1 -Import C:\path\lifting_backfill.json   import a JSON export (safe to repeat)
#   .\deploy\lifting.ps1 -Backup                                  run the nightly backup now
#   .\deploy\lifting.ps1 -Fetch                                   copy the newest backup here
param([string]$Import, [switch]$Backup, [switch]$Fetch, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'

if ($Import) {
  if (-not (Test-Path $Import)) { throw "No file at $Import" }
  scp $Import "${PiHost}:/tmp/lifting-import.json"
  if ($LASTEXITCODE -ne 0) { throw "Could not copy the file to $PiHost" }
  ssh $PiHost "curl -sS -X POST -H 'Content-Type: application/json' --data-binary @/tmp/lifting-import.json http://127.0.0.1:8090/import; echo; rm -f /tmp/lifting-import.json"
}
if ($Backup) {
  ssh $PiHost "cd ~/pidisplay && LIFTING_DB=~/pidisplay-data/lifting.db python3 -m lifting.backup"
}
if ($Fetch) {
  $name = ssh $PiHost "ls -1 ~/pidisplay-data/lifting-backups | tail -1"
  if (-not $name) { throw "No backups on $PiHost yet" }
  scp "${PiHost}:pidisplay-data/lifting-backups/$name" .
  Write-Host "Saved $name"
}
if (-not ($Import -or $Backup -or $Fetch)) { Get-Help $MyInvocation.MyCommand.Path; Write-Host 'Pass -Import <file>, -Backup or -Fetch.' }
