# Redeploy from this laptop: .\deploy\deploy.ps1   (run from the pidisplay folder)
# Copies the source to piboy (no node_modules, dist or data) and runs update.sh there.
param([string]$PiHost = 'dan@piboy')
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tarball = Join-Path $env:TEMP 'pidisplay.tgz'

tar -czf $tarball -C $root --exclude=node_modules --exclude=dist --exclude=data --exclude=.git .
scp $tarball "${PiHost}:/tmp/pidisplay.tgz"
ssh $PiHost "mkdir -p ~/pidisplay && tar -xzf /tmp/pidisplay.tgz -C ~/pidisplay && sed -i 's/\r$//' ~/pidisplay/deploy/*.sh && chmod +x ~/pidisplay/deploy/*.sh && ~/pidisplay/deploy/update.sh"
Remove-Item $tarball
