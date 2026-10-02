# Manage the stocks widget's data source from this laptop (run from the pidisplay folder).
#   .\deploy\stocks.ps1                   show the data source, credits used today and each ticker's status
#   .\deploy\stocks.ps1 -Key <apikey>     save a free Twelve Data API key (switches from Yahoo to Twelve Data)
#   .\deploy\stocks.ps1 -RemoveKey        forget the key (back to Yahoo, no key)
# The key is kept only on the Pi, in ~/pidisplay-data/stocks-key.json (readable by dan only), never in git and
# never sent to the browser. No restart needed. Tickers and alerts are set on the screen. See docs/STOCKS.md.
param([string]$Key, [switch]$RemoveKey, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$file = '~/pidisplay-data/stocks-key.json'

if ($Key) {
  $Key = $Key.Trim()
  if ($Key -notmatch '^[A-Za-z0-9]{16,64}$') { throw 'That does not look like a Twelve Data API key (letters and digits only).' }
  $json = ConvertTo-Json -InputObject ([pscustomobject]@{ apiKey = $Key })
  $json | ssh $PiHost "mkdir -p ~/pidisplay-data && umask 077 && cat > $file.tmp && mv $file.tmp $file"
  if ($LASTEXITCODE -ne 0) { throw 'Saving the key on the Pi failed' }
  Write-Host 'Key saved. Checking it with a fresh price refresh...'
} elseif ($RemoveKey) {
  ssh $PiHost "rm -f $file"
  if ($LASTEXITCODE -ne 0) { throw 'Removing the key on the Pi failed' }
  Write-Host 'Key removed; prices now come from Yahoo Finance.'
}

$method = if ($Key -or $RemoveKey) { 'POST' } else { 'GET' }
$path = if ($method -eq 'POST') { '/api/stocks/refresh' } else { '/api/stocks' }
$res = (ssh $PiHost "curl -s -X $method http://127.0.0.1:8080$path") -join "`n"
if (-not $res) { Write-Warning 'PiDisplay is not answering on the Pi; is the pidisplay service running?'; exit }
$data = $res | ConvertFrom-Json
if (-not $data.provider) { Write-Warning "Unexpected answer: $res"; exit }
Write-Host ("Data source: {0}" -f $data.providerName)
if ($data.credits) { Write-Host ("Credits used today: {0} of {1}" -f $data.credits.used, $data.credits.limit) }
if ($data.error) { Write-Host ("PROBLEM: {0}" -f $data.error) -ForegroundColor Yellow }
foreach ($s in @($data.symbols)) {
  $q = $data.quotes.$s
  if (-not $q) { Write-Host ("  {0,-8} waiting for a price" -f $s) }
  elseif ($q.error) { Write-Host ("  {0,-8} PROBLEM: {1}" -f $s, $q.error) -ForegroundColor Yellow }
  else { Write-Host ("  {0,-8} {1,10:N2} {2}  {3}" -f $s, $q.price, $q.currency, $q.name) }
}
