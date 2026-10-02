#!/bin/bash
# Launches Chromium full screen on the dashboard. Started from the labwc
# autostart through lwrespawn, so it comes back if it crashes or is killed.
URL="http://127.0.0.1:8080/?kiosk"

# "Exit to desktop" in the dashboard's gear menu drops this flag and closes
# Chromium. Stay parked (instead of exiting, which lwrespawn would rerun) until
# the PiDisplay launcher removes it. It's on tmpfs, so a reboot clears it too.
FLAG="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pidisplay-desktop"
while [ -e "$FLAG" ]; do
  sleep 1
done

# Wait (up to ~60s) for the server so Chromium doesn't open on an error page.
for _ in $(seq 1 60); do
  curl -fs http://127.0.0.1:8080/api/health >/dev/null && break
  sleep 1
done

# Clear the "Chromium didn't shut down correctly" bubble after power cuts.
PREFS="$HOME/.config/chromium/Default/Preferences"
if [ -f "$PREFS" ]; then
  sed -i 's/"exited_cleanly":false/"exited_cleanly":true/; s/"exit_type":"[^"]*"/"exit_type":"Normal"/' "$PREFS"
fi

# The two IME flags let Chromium tell squeekboard (the Pi's on-screen
# keyboard) when a text field is focused, so it pops up on its own.
exec chromium \
  --kiosk "$URL" \
  --ozone-platform=wayland \
  --enable-wayland-ime \
  --wayland-text-input-version=3 \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --password-store=basic \
  --check-for-update-interval=31536000
