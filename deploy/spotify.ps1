# Connect the Spotify widget to your Spotify account, from this laptop (run from the pidisplay folder).
#   .\deploy\spotify.ps1 -ClientId <id>   save your Spotify app's Client ID on the Pi, then sign in
#   .\deploy\spotify.ps1                  sign in again (or check the status) with the saved Client ID
#   .\deploy\spotify.ps1 -Logout          sign the display out of Spotify
# Sign-in opens in this laptop's browser through an SSH tunnel to the Pi, because Spotify only
# returns to http://127.0.0.1:8080/api/spotify/callback. Tokens are stored only on the Pi, in
# ~/pidisplay-data/spotify.json (readable by dan only). See docs/SPOTIFY.md.
param([string]$ClientId, [switch]$Logout, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$api = 'http://127.0.0.1:8080/api/spotify'

function Get-Status {
  $raw = (ssh $PiHost "curl -s $api") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Could not reach $PiHost over SSH" }
  if (-not $raw) { throw 'PiDisplay is not answering on the Pi; is the pidisplay service running?' }
  return $raw | ConvertFrom-Json
}

if ($Logout) {
  ssh $PiHost "curl -fsS -X POST $api/logout" | Out-Null
  Write-Host 'Signed the display out of Spotify.'
  exit
}

if ($ClientId) {
  $ClientId = $ClientId.Trim()
  if ($ClientId -notmatch '^[0-9a-fA-F]{32}$') { throw 'The Client ID is 32 letters and numbers, shown on your app''s page in the Spotify developer dashboard.' }
  ssh $PiHost "curl -fsS -X POST '$api/client?clientId=$ClientId'" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Saving the Client ID on the Pi failed. Is PiDisplay deployed with the Spotify widget?' }
  Write-Host 'Client ID saved on the Pi.'
}

$status = Get-Status
if (-not $status.configured) { throw 'No Client ID saved yet. Run: .\deploy\spotify.ps1 -ClientId <your app''s Client ID>' }

if (-not $status.connected) {
  $busy = Get-NetTCPConnection -LocalPort 8080 -State Listen -ErrorAction SilentlyContinue
  if ($busy) { throw 'Something on this laptop already uses port 8080. Close it, or sign in on the display instead.' }
  Write-Host 'Opening a tunnel to the Pi and the Spotify sign-in page...'
  $tunnel = Start-Process ssh -ArgumentList @('-N', '-o', 'ExitOnForwardFailure=yes', '-L', '8080:127.0.0.1:8080', $PiHost) -PassThru -WindowStyle Hidden
  try {
    Start-Sleep -Seconds 3
    if ($tunnel.HasExited) { throw 'The SSH tunnel to the Pi did not start.' }
    Start-Process "$api/login"
    Write-Host 'Sign in to Spotify in the browser and tap Agree.'
    for ($i = 0; $i -lt 150 -and -not $status.connected; $i++) {
      Start-Sleep -Seconds 2
      $status = Get-Status
    }
  } finally {
    Stop-Process -Id $tunnel.Id -ErrorAction SilentlyContinue
  }
  if (-not $status.connected) { throw 'Timed out waiting for the Spotify sign-in. Run the script again to retry.' }
}

Write-Host 'Spotify is connected.' -ForegroundColor Green
if ($status.receiver.signedIn) {
  Write-Host "The $($status.receiver.name) speaker is linked too, so music can start from the display."
} else {
  Write-Host "Last step, once: open Spotify on your phone (same Wi-Fi as the Pi), tap the speaker icon and pick $($status.receiver.name)."
}
