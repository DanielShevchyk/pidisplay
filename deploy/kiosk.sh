#!/bin/bash
# Launches Chromium full screen on the dashboard. Started from the labwc
# autostart through lwrespawn, so it comes back if it crashes or is killed.
URL="http://127.0.0.1:8080/?kiosk"

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

exec chromium \
  --kiosk "$URL" \
  --ozone-platform=wayland \
  --noerrdialogs \
  --disable-infobars \
  --no-first-run \
  --disable-session-crashed-bubble \
  --disable-features=Translate \
  --disable-pinch \
  --overscroll-history-navigation=0 \
  --password-store=basic \
  --check-for-update-interval=31536000
