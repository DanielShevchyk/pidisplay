# Connect the Vacuum widget to your Dreame robot, from this laptop (run from the pidisplay folder).
#   .\deploy\vacuum.ps1 -Email you@example.com             save your Dreamehome login (asks for the password)
#   .\deploy\vacuum.ps1 -Email you@example.com -Region eu  if your Dreamehome account is on another server
#   .\deploy\vacuum.ps1 -Email you@example.com -Robot "Downstairs"   pick a robot by its app name (only with several)
#   .\deploy\vacuum.ps1                                    show whether PiDisplay can reach the robot
#   .\deploy\vacuum.ps1 -Remove                            forget the login
# The login is kept only on the Pi, in ~/pidisplay-data/dreame.json (readable by dan only), never in git and
# never sent to the browser. Regions: us, eu, cn, ru, sg (the server your Dreamehome account was made on).
# If you sign in to the Dreamehome app with Google or Apple, set a password in the app first. See docs/VACUUM.md.
param([string]$Email, [ValidateSet('us', 'eu', 'cn', 'ru', 'sg')][string]$Region = 'us', [string]$Robot, [switch]$Remove, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$file = '~/pidisplay-data/dreame.json'

if ($Email) {
  $Email = $Email.Trim()
  $secure = Read-Host "Dreamehome password for $Email" -AsSecureString
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
  if (-not $password) { throw 'No password given.' }
  $config = [ordered]@{ username = $Email; password = $password; region = $Region }
  if ($Robot) { $config.device = $Robot }
  # Sent over ssh's stdin, so the password never shows up in a command line on either machine.
  (ConvertTo-Json -InputObject ([pscustomobject]$config) -Compress) | ssh $PiHost "mkdir -p ~/pidisplay-data && umask 077 && cat > $file.tmp && mv $file.tmp $file"
  if ($LASTEXITCODE -ne 0) { throw 'Saving the login on the Pi failed' }
  $password = $null
  Write-Host 'Login saved on the Pi. Signing in to Dreame...'
} elseif ($Remove) {
  ssh $PiHost "rm -f $file ~/pidisplay-data/vacuum.json"
  if ($LASTEXITCODE -ne 0) { throw 'Removing the login on the Pi failed' }
  Write-Host 'Login removed.'
}

$path = if ($Email -or $Remove) { '/api/vacuum/reload' } else { '/api/vacuum/refresh' }
$res = (ssh $PiHost "curl -s -X POST http://127.0.0.1:8080$path") -join "`n"
if (-not $res) { Write-Warning 'PiDisplay is not answering on the Pi; is the pidisplay service running?'; exit }
$data = $res | ConvertFrom-Json
if ($data.error) { Write-Warning $data.error; exit }
switch ($data.status) {
  'unconfigured' { Write-Host 'No Dreame login saved yet. Run: .\deploy\vacuum.ps1 -Email you@example.com' }
  'signin' { Write-Host ("PROBLEM: {0}" -f $data.problem) -ForegroundColor Yellow; Write-Host 'Check the email, password and -Region, then run this again with -Email.' }
  'ok' {
    Write-Host ("Connected to {0} ({1})" -f $data.device.name, $data.device.model) -ForegroundColor Green
    if ($data.state) { Write-Host ("  {0}, battery {1}%" -f $data.state.label, $data.state.battery) }
    $rooms = @($data.rooms)
    if ($rooms.Count) { Write-Host ("  Rooms: {0}" -f (($rooms | ForEach-Object { $_.name }) -join ', ')) }
    else { Write-Host '  Rooms: not loaded yet (they appear on the tile within a minute if the robot has a saved map)' }
  }
  default { Write-Host ("PROBLEM ({0}): {1}" -f $data.status, $data.problem) -ForegroundColor Yellow }
}
