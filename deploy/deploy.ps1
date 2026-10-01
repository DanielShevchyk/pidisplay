# Redeploy from this laptop: .\deploy\deploy.ps1   (run from the pidisplay folder)
# Pulls the latest code from GitHub, copies the committed source to piboy and runs update.sh there.
#   -NoPull   deploy the current checkout without pulling first
param([string]$PiHost = 'dan@piboy', [switch]$NoPull)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$tarball = Join-Path $env:TEMP 'pidisplay.tgz'

if (Test-Path (Join-Path $root '.git')) {
  if (-not $NoPull) {
    git -C $root pull --ff-only
    if ($LASTEXITCODE -ne 0) { throw 'git pull failed; fix the checkout or rerun with -NoPull' }
  }
  # Ship exactly the checked-out commit, never stray or half-edited files.
  git -C $root archive --format=tar.gz -o $tarball HEAD
  if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }
  Write-Host "Deploying $(git -C $root log --oneline -1)"
} else {
  tar -czf $tarball -C $root --exclude=node_modules --exclude=dist --exclude=data --exclude=.git .
}
scp $tarball "${PiHost}:/tmp/pidisplay.tgz"
ssh $PiHost "mkdir -p ~/pidisplay && tar -xzf /tmp/pidisplay.tgz -C ~/pidisplay && sed -i 's/\r$//' ~/pidisplay/deploy/*.sh && chmod +x ~/pidisplay/deploy/*.sh && ~/pidisplay/deploy/update.sh"
Remove-Item $tarball
