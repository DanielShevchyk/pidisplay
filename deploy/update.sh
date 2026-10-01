#!/bin/bash
# Runs on the Pi: install deps, build the UI, restart the server and the kiosk.
# deploy.ps1 on the laptop copies fresh code into ~/pidisplay and then runs this.
set -euo pipefail
cd /home/dan/pidisplay

# Widgets use emoji icons; Raspberry Pi OS ships without a color emoji font.
dpkg -s fonts-noto-color-emoji >/dev/null 2>&1 || sudo apt-get install -y fonts-noto-color-emoji

npm ci --no-audit --no-fund
npm run build

sudo install -m 644 deploy/pidisplay.service /etc/systemd/system/pidisplay.service
sudo systemctl daemon-reload
sudo systemctl enable pidisplay
sudo systemctl restart pidisplay

for _ in $(seq 1 30); do
  curl -fs http://127.0.0.1:8080/api/health >/dev/null && break
  sleep 1
done
curl -fs http://127.0.0.1:8080/api/health >/dev/null || { echo "Server did not come up"; exit 1; }

# lwrespawn restarts Chromium on the new build.
pkill -f 'chromium.*127.0.0.1:808[0]' || true
echo "PiDisplay updated and running."
