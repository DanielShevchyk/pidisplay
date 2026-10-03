#!/bin/bash
# Runs on the Pi: install deps, build the UI, restart the server and the kiosk.
# deploy.ps1 on the laptop copies fresh code into ~/pidisplay and then runs this.
set -euo pipefail
cd /home/dan/pidisplay

# Widgets use emoji icons; Raspberry Pi OS ships without a color emoji font.
dpkg -s fonts-noto-color-emoji >/dev/null 2>&1 || sudo apt-get install -y fonts-noto-color-emoji

# The photo gallery shrinks camera photos to screen size with ImageMagick. Without it photos
# still show, just slowly, so a failed install only warns.
dpkg -s imagemagick >/dev/null 2>&1 || sudo apt-get install -y imagemagick || echo "WARNING: ImageMagick install failed; photos will load slowly."

# The gear menu's Bluetooth switch needs rfkill to lift the radio's soft block.
dpkg -s rfkill >/dev/null 2>&1 || sudo apt-get install -y rfkill

# Narrow permissions for the gear menu's Wi-Fi and Bluetooth screens (see the files).
sudo install -m 644 -o root -g root deploy/pidisplay-network.rules /etc/polkit-1/rules.d/50-pidisplay-network.rules
# Strip Windows line endings (sudo rejects them) and only install a file visudo accepts.
tr -d '\r' < deploy/pidisplay-sudoers > /tmp/pidisplay-sudoers
sudo visudo -cqf /tmp/pidisplay-sudoers
sudo install -m 440 -o root -g root /tmp/pidisplay-sudoers /etc/sudoers.d/pidisplay
rm -f /tmp/pidisplay-sudoers

# Alarm sounds and other audio go to the screen's HDMI speakers, not the headphone jack.
WP="$HOME/.config/wireplumber"
WP_CHANGED=0
for f in main.lua.d/51-pidisplay-hdmi.lua wireplumber.conf.d/51-pidisplay-hdmi.conf; do
  src="deploy/wireplumber/$(basename "$f")"
  if ! cmp -s "$src" "$WP/$f"; then
    install -D -m 644 "$src" "$WP/$f"
    WP_CHANGED=1
  fi
done
if [ "$WP_CHANGED" = 1 ]; then
  XDG_RUNTIME_DIR="/run/user/$(id -u)" systemctl --user restart wireplumber || true
fi

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

# Spotify Connect receiver for the Spotify widget (docs/SPOTIFY.md). A failure here
# (say, no internet for apt) warns but doesn't undo the dashboard update above.
setup_spotify() {
  if ! dpkg -s raspotify >/dev/null 2>&1; then
    # raspotify packages librespot for Raspberry Pi OS: https://github.com/dtcooper/raspotify
    sudo curl -sSfL https://dtcooper.github.io/raspotify/key.asc -o /usr/share/keyrings/raspotify_key.asc || return 1
    sudo chmod 644 /usr/share/keyrings/raspotify_key.asc
    echo 'deb [signed-by=/usr/share/keyrings/raspotify_key.asc] https://dtcooper.github.io/raspotify raspotify main' \
      | sudo tee /etc/apt/sources.list.d/raspotify.list >/dev/null
    sudo apt-get update -qq || return 1
    sudo apt-get install -y raspotify || return 1
  fi
  # raspotify's own system service would appear as a second speaker that can't reach
  # dan's PipeWire; librespot runs as dan's user service below instead.
  sudo systemctl disable --now raspotify >/dev/null 2>&1 || true
  # pactl lets the server list and switch speakers; pipewire-alsa routes librespot's ALSA output into PipeWire.
  for pkg in pulseaudio-utils pipewire-alsa; do
    dpkg -s "$pkg" >/dev/null 2>&1 || sudo apt-get install -y "$pkg" || return 1
  done
  export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
  mkdir -p "$HOME/.config/systemd/user"
  tr -d '\r' < deploy/pidisplay-spotify.service > "$HOME/.config/systemd/user/pidisplay-spotify.service"
  systemctl --user daemon-reload || return 1
  systemctl --user enable pidisplay-spotify || return 1
  systemctl --user restart pidisplay-spotify || return 1
}
if ! setup_spotify; then
  echo "WARNING: Spotify receiver setup failed (see above). The dashboard itself is updated; rerun the deploy to retry."
fi

# Offline voice control (docs/VOICE.md): wake word, speech to text and spoken replies.
# Downloads about 150 MB the first time; a failure warns but leaves the dashboard updated.
if ! bash deploy/voice-setup.sh; then
  echo "WARNING: Voice control setup failed (see above). The dashboard itself is updated; rerun the deploy to retry."
fi

# PiDisplay launcher for getting back from "Exit to desktop": app menu + desktop icon.
install -D -m 644 deploy/pidisplay.desktop "$HOME/.local/share/applications/pidisplay.desktop"
if [ -d "$HOME/Desktop" ]; then
  install -m 755 deploy/pidisplay.desktop "$HOME/Desktop/pidisplay.desktop"
fi

# lwrespawn restarts Chromium on the new build.
pkill -f 'chromium.*127.0.0.1:808[0]' || true
echo "PiDisplay updated and running."
