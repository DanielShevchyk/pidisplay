# Manage the calendars shown by the calendar widget, from this laptop (run from the pidisplay folder).
#   .\deploy\calendars.ps1                                    list calendars and check each feed
#   .\deploy\calendars.ps1 -Add Dan -Url "https://calendar.google.com/calendar/ical/.../basic.ics" [-Color "#4da3ff"]
#   .\deploy\calendars.ps1 -Remove Dan
# Adding a name that already exists replaces it. Feed links are secrets: they are kept only on the Pi,
# in ~/pidisplay-data/calendars.json (readable by dan only), never in git. See docs/CALENDAR.md.
param([string]$Add, [string]$Url, [string]$Color, [string]$Remove, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$file = '~/pidisplay-data/calendars.json'

$raw = (ssh $PiHost "cat $file 2>/dev/null || true") -join "`n"
if ($LASTEXITCODE -ne 0) { throw "Could not reach $PiHost over SSH" }
$list = @()
if ($raw.Trim()) { $list = @(($raw | ConvertFrom-Json).calendars | Where-Object { $_ }) }

if ($Add -or $Remove) {
  if ($Add) {
    if ($Url -notmatch '^(https?|webcal)://') { throw 'Pass the calendar''s secret iCal address with -Url "https://..."' }
    if ($Color -and $Color -notmatch '^#[0-9a-fA-F]{3,8}$') { throw 'Color must look like #4da3ff' }
    $entry = [ordered]@{ name = $Add; url = $Url.Trim() }
    if ($Color) { $entry.color = $Color }
    $list = @($list | Where-Object { $_.name -ne $Add }) + [pscustomobject]$entry
  } else {
    $before = $list.Count
    $list = @($list | Where-Object { $_.name -ne $Remove })
    if ($list.Count -eq $before) { Write-Warning "No calendar named '$Remove'" }
  }
  $json = ConvertTo-Json -InputObject ([pscustomobject]@{ calendars = @($list) }) -Depth 5
  $json | ssh $PiHost "mkdir -p ~/pidisplay-data && umask 077 && cat > $file.tmp && mv $file.tmp $file"
  if ($LASTEXITCODE -ne 0) { throw 'Saving calendars.json on the Pi failed' }
  Write-Host 'Saved. The display picks it up on its next refresh (within 5 minutes).'
}

if (-not $list.Count) {
  Write-Host 'No calendars yet. Add one with -Add <name> -Url <secret iCal address>.'
  exit
}

# Ask the running dashboard to load the next week, which also checks every feed.
$from = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
$to = $from + 7 * 86400000
$res = (ssh $PiHost "curl -s 'http://127.0.0.1:8080/api/calendar?from=$from&to=$to'") -join "`n"
if (-not $res) { Write-Warning 'PiDisplay is not answering on the Pi; is the pidisplay service running?'; exit }
$data = $res | ConvertFrom-Json
foreach ($c in @($data.calendars)) {
  $count = @($data.events | Where-Object { $_.calendar -eq $c.id }).Count
  if ($c.error) { Write-Host ("  {0,-16} {1}  PROBLEM: {2}" -f $c.name, $c.color, $c.error) -ForegroundColor Yellow }
  else { Write-Host ("  {0,-16} {1}  ok, {2} events in the next 7 days" -f $c.name, $c.color, $count) }
}
