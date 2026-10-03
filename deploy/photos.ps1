# Manage the photo gallery's photos from this laptop (run from the pidisplay folder).
#   .\deploy\photos.ps1                                           list albums and check Google links
#   .\deploy\photos.ps1 -Upload "C:\Users\Laptop\Pictures\Beach" [-Album Beach]
#                                                                 copy a folder's photos to the Pi (skips ones already there)
#   .\deploy\photos.ps1 -Album Family -Url "https://photos.app.goo.gl/..."
#                                                                 show a Google Photos shared album
#   .\deploy\photos.ps1 -Remove Beach                             delete an uploaded album, or unlink a Google album
# Uploaded photos live in ~/pidisplay-data/photos/<album>/ on the Pi, which redeploys never touch.
# Google album links are kept in ~/pidisplay-data/photos.json (readable by dan only). See docs/PHOTOS.md.
param([string]$Upload, [string]$Album, [string]$Url, [string]$Remove, [string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$OutputEncoding = New-Object System.Text.UTF8Encoding $false
$data = 'pidisplay-data'
$config = "~/$data/photos.json"
$extensions = '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif'

function Test-AlbumName([string]$name) {
  if ($name -notmatch '^[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}$' -or $name -match '\.\.') {
    throw "Album names may use letters, digits, spaces, '-', '_' and '.' (got '$name')"
  }
}

function Get-GoogleAlbums {
  $raw = (ssh $PiHost "cat $config 2>/dev/null || true") -join "`n"
  if ($LASTEXITCODE -ne 0) { throw "Could not reach $PiHost over SSH" }
  if ($raw.Trim()) { return @(($raw | ConvertFrom-Json).albums | Where-Object { $_ }) }
  return @()
}

function Save-GoogleAlbums($list) {
  $json = ConvertTo-Json -InputObject ([pscustomobject]@{ albums = @($list) }) -Depth 5
  $json | ssh $PiHost "mkdir -p ~/$data && umask 077 && cat > $config.tmp && mv $config.tmp $config"
  if ($LASTEXITCODE -ne 0) { throw 'Saving photos.json on the Pi failed' }
}

if ($Upload) {
  $item = Get-Item -LiteralPath $Upload
  $files = if ($item.PSIsContainer) { @(Get-ChildItem -LiteralPath $item.FullName -File) } else { @($item) }
  $files = @($files | Where-Object { $extensions -contains $_.Extension.ToLower() })
  if (-not $files.Count) { throw "No photos (.jpg, .png, .heic, ...) in $Upload" }
  if (-not $Album) { $Album = if ($item.PSIsContainer) { $item.Name } else { $item.Directory.Name } }
  Test-AlbumName $Album

  # Skip photos already on the Pi with the same name and size, so re-running after adding a few is quick.
  $existing = @{}
  $remote = ssh $PiHost "find ~/$data/photos/'$Album' -maxdepth 1 -type f -printf '%f\t%s\n' 2>/dev/null || true"
  if ($LASTEXITCODE -ne 0) { throw "Could not reach $PiHost over SSH" }
  foreach ($line in @($remote)) { if ($line) { $name, $size = $line -split "`t"; $existing[$name] = [long]$size } }
  $todo = @($files | Where-Object { $existing[$_.Name] -ne $_.Length })
  $mb = [math]::Round((($todo | Measure-Object Length -Sum).Sum) / 1MB, 1)
  Write-Host "$($files.Count) photos in '$Album': $($files.Count - $todo.Count) already on the Pi, uploading $($todo.Count) ($mb MB)."

  if ($todo.Count) {
    # Upload into a folder without spaces, then move: works with every scp version's path quoting.
    $staging = "$data/photos-upload"
    ssh $PiHost "rm -rf ~/$staging && mkdir -p ~/$staging"
    if ($LASTEXITCODE -ne 0) { throw 'Preparing the upload on the Pi failed' }
    $done = 0
    for ($i = 0; $i -lt $todo.Count; $i += 25) {
      $batch = @($todo[$i..([math]::Min($i + 24, $todo.Count - 1))] | ForEach-Object { $_.FullName })
      scp -q $batch "${PiHost}:$staging/"
      if ($LASTEXITCODE -ne 0) { throw 'Copying photos to the Pi failed' }
      $done += $batch.Count
      Write-Progress -Activity "Uploading to $Album" -Status "$done of $($todo.Count)" -PercentComplete ($done * 100 / $todo.Count)
    }
    Write-Progress -Activity "Uploading to $Album" -Completed
    ssh $PiHost "mkdir -p ~/$data/photos/'$Album' && mv -f ~/$staging/* ~/$data/photos/'$Album'/ && rmdir ~/$staging"
    if ($LASTEXITCODE -ne 0) { throw 'Moving the photos into place on the Pi failed' }
  }
  Write-Host 'Done. The display shows new photos within 10 minutes; the Pi shrinks them to screen size in the background.'
}
elseif ($Album -or $Url) {
  if (-not ($Album -and $Url)) { throw 'Link a Google Photos album with both -Album <name> and -Url <shared album link>' }
  Test-AlbumName $Album
  if ($Url -notmatch '^https://(photos\.app\.goo\.gl|photos\.google\.com)/') {
    throw 'Use the album''s share link: in Google Photos open the album, tap Share, then "Create link" (looks like https://photos.app.goo.gl/...)'
  }
  $list = @(Get-GoogleAlbums | Where-Object { $_.name -ne $Album }) + [pscustomobject][ordered]@{ name = $Album; url = $Url.Trim() }
  Save-GoogleAlbums $list
  Write-Host "Linked '$Album'."
}
elseif ($Remove) {
  Test-AlbumName $Remove
  $hasFolder = (ssh $PiHost "test -d ~/$data/photos/'$Remove' && echo yes") -eq 'yes'
  $google = @(Get-GoogleAlbums)
  if ($google.name -contains $Remove) {
    Save-GoogleAlbums @($google | Where-Object { $_.name -ne $Remove })
    Write-Host "Unlinked Google album '$Remove'."
  }
  elseif ($hasFolder) {
    $answer = Read-Host "Delete the uploaded album '$Remove' and its photos from the Pi? (y/n)"
    if ($answer -ne 'y') { exit }
    ssh $PiHost "rm -rf ~/$data/photos/'$Remove'"
    Write-Host "Deleted '$Remove' from the Pi. (The originals on this laptop are untouched.)"
  }
  else { Write-Warning "No album named '$Remove'" }
}

# What the dashboard sees now, which also checks every Google link.
$res = (ssh $PiHost "curl -s 'http://127.0.0.1:8080/api/photos'") -join "`n"
if (-not $res) { Write-Warning 'PiDisplay is not answering on the Pi; is the pidisplay service running?'; exit }
$listing = $res | ConvertFrom-Json
if ($listing.error) { Write-Warning "PiDisplay: $($listing.error)"; exit }
if (-not @($listing.albums).Count) {
  Write-Host 'No albums yet. Upload a folder with -Upload <folder>, or link a Google album with -Album <name> -Url <link>.'
}
foreach ($a in @($listing.albums)) {
  $where = if ($a.source -eq 'google') { 'Google' } else { 'on Pi' }
  if ($a.error) { Write-Host ("  {0,-24} {1,-7} PROBLEM: {2}" -f $a.name, $where, $a.error) -ForegroundColor Yellow }
  else { Write-Host ("  {0,-24} {1,-7} {2} photos" -f $a.name, $where, $a.count) }
}
if (-not $listing.resizing) {
  Write-Warning 'ImageMagick is missing on the Pi, so photos are shown full size (slow). Redeploy to install it.'
}
if ($Upload -and -not $listing.heic -and @($files | Where-Object { $_.Extension -match '^\.hei[cf]$' }).Count) {
  Write-Warning 'The Pi''s ImageMagick cannot read HEIC, so the .heic photos are skipped. Export them as JPEG and upload again.'
}
$used = (ssh $PiHost "du -sh ~/$data/photos 2>/dev/null | cut -f1") -join ''
if ($used) { Write-Host "Uploaded photos use $used on the Pi's SD card." }
