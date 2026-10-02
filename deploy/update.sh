#!/bin/bash
# Runs on the Pi: install deps, build the UI, restart the server and the kiosk.
# deploy.ps1 on the laptop copies fresh code into ~/pidisplay and then runs this.
set -euo pipefail
cd /home/dan/pidisplay

# Widgets use emoji icons; Raspberry Pi OS ships without a color emoji font.
dpkg -s fonts-noto-color-emoji >/dev/null 2>&1 || sudo apt-get install -y fonts-noto-color-emoji

# The gear menu's Bluetooth switch needs rfkill to lift the radio's soft block.
dpkg -s rfkill >/dev/null 2>&1 || sudo apt-get install -y rfkill

# Narrow permissions for the gear menu's Wi-Fi and Bluetooth screens (see the files).
sudo install -m 644 -o root -g root deploy/pidisplay-network.rules /etc/polkit-1/rules.d/50-pidisplay-network.rules
# Strip Windows line endings (sudo rejects them) and only install a file visudo accepts.
tr -d '\r' < deploy/pidisplay-sudoers > /tmp/pidisplay-sudoers
sudo visudo -cqf /tmp/pidisplay-sudoers
sudo install -m 440 -o root -g root /tmp/pidisplay-sudoers /etc/sudoers.d/pidisplay
rm -f /tmp/pidisplay-sudoers

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

# PiDisplay launcher for getting back from "Exit to desktop": app menu + desktop icon.
install -D -m 644 deploy/pidisplay.desktop "$HOME/.local/share/applications/pidisplay.desktop"
if [ -d "$HOME/Desktop" ]; then
  install -m 755 deploy/pidisplay.desktop "$HOME/Desktop/pidisplay.desktop"
fi

# lwrespawn restarts Chromium on the new build.
pkill -f 'chromium.*127.0.0.1:808[0]' || true
echo "PiDisplay updated and running."
