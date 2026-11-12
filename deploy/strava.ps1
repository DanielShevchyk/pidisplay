# Connect the Strava widget to your Strava account, from this laptop (run from the pidisplay folder).
#   .\deploy\strava.ps1 -ClientId 12345     save your Strava app's Client ID and secret on the Pi (asks for the
#                                           secret), then sign in once in this laptop's browser
#   .\deploy\strava.ps1                     show the status; signs in again if the display isn't connected
#   .\deploy\strava.ps1 -Reconnect          sign in again anyway (e.g. to fix permissions)
#   .\deploy\strava.ps1 -Logout             disconnect the display from Strava
# Both numbers are on https://www.strava.com/settings/api. The secret and tokens are kept only on the Pi, in
# ~/pidisplay-data/strava.json (readable by dan only), never in git and never sent to the browser. The Pi
# refreshes the 6-hour access token by itself. See docs/STRAVA.md.
param([string]$ClientId, [string]$ClientSecret, [switch]$Reconnect, [switch]$Logout, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$api = 'http://127.0.0.1:8080/api/strava'

function Get-Status {
  $raw = (ssh $PiHost "curl -s $api/status") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Could not reach $PiHost over SSH" }
  if (-not $raw) { throw 'PiDisplay is not answering on the Pi; is the pidisplay service running?' }
  $s = $raw | ConvertFrom-Json
  if ($null -eq $s.configured) { throw "Unexpected answer (is PiDisplay deployed with the Strava widget?): $raw" }
  return $s
}

if ($Logout) {
  ssh $PiHost "curl -fsS -X POST $api/logout" | Out-Null
  Write-Host 'Disconnected the display from Strava. Run .\deploy\strava.ps1 to connect again.'
  exit
}

if ($ClientId) {
  $ClientId = $ClientId.Trim()
  if ($ClientId -notmatch '^\d{1,10}$') { throw 'The Client ID is a number, shown on https://www.strava.com/settings/api.' }
  if (-not $ClientSecret) {
    $secure = Read-Host 'Client Secret (from https://www.strava.com/settings/api)' -AsSecureString
    $ClientSecret = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
  }
  $ClientSecret = $ClientSecret.Trim()
  if ($ClientSecret -notmatch '^[0-9a-fA-F]{40}$') { throw 'The Client Secret is 40 letters and numbers.' }
  # Sent through SSH's stdin, so the secret never shows up in a command line on either machine.
  $json = ConvertTo-Json -Compress -InputObject ([pscustomobject]@{ clientId = $ClientId; clientSecret = $ClientSecret })
  $res = ($json | ssh $PiHost "curl -s -X POST -H 'Content-Type: application/json' --data-binary @- $api/client") -join "`n"
  if ($LASTEXITCODE -ne 0 -or $res -notmatch '"configured":true') { throw "Saving the app details on the Pi failed: $res" }
  Write-Host 'Client ID and secret saved on the Pi.'
}

$status = Get-Status
if (-not $status.configured) { throw 'No Strava app saved yet. Run: .\deploy\strava.ps1 -ClientId <your Client ID>' }

if (-not $status.connected -or $Reconnect) {
  $busy = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
  if ($busy) { throw 'Something on this laptop already uses port 8080. Close it, or use "Connect on this screen" on the display.' }
  Write-Host 'Opening a tunnel to the Pi and the Strava sign-in page...'
  $tunnel = Start-Process ssh -ArgumentList @('-N', '-o', 'ExitOnForwardFailure=yes', '-L', '8080:127.0.0.1:8080', $PiHost) -PassThru -WindowStyle Hidden
  $before = $status.connected
  try {
    Start-Sleep -Seconds 3
    if ($tunnel.HasExited) { throw 'The SSH tunnel to the Pi did not start.' }
    Start-Process "$api/login"
    Write-Host 'Sign in to Strava in the browser and tap Authorize. Leave "View data about your activities" ticked.'
    if ($Reconnect -and $before) {
      Write-Host 'Press Enter here once the browser says "Strava connected".'
      Read-Host | Out-Null
    } else {
      for ($i = 0; $i -lt 150 -and -not $status.connected; $i++) {
        Start-Sleep -Seconds 2
        $status = Get-Status
      }
    }
  } finally {
    Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  }
  $status = Get-Status
  if (-not $status.connected) { throw 'Timed out waiting for the Strava sign-in. Run the script again to retry.' }
}

Write-Host 'Strava is connected.' -ForegroundColor Green
Start-Sleep -Seconds 3
$snap = (ssh $PiHost "curl -s $api") -join "`n" | ConvertFrom-Json
if ($snap.athlete) { Write-Host ("Athlete: {0} {1}" -f $snap.athlete.name, $(if ($snap.athlete.city) { "($($snap.athlete.city))" } else { '' })) }
Write-Host ("Activities on the Pi: {0}{1}" -f $snap.count, $(if ($snap.backfilled) { '' } else { ' so far; older ones keep downloading every couple of minutes' }))
Write-Host ("Strava requests used: {0} of {1} this 15 minutes, {2} of {3} today" -f $snap.usage.short, $snap.usage.limits.short, $snap.usage.daily, $snap.usage.limits.daily)
if ($snap.error) { Write-Host ("PROBLEM: {0}" -f $snap.error) -ForegroundColor Yellow }
