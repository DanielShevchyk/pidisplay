#!/bin/bash
# Brings the dashboard back after "Exit to desktop". Run by the PiDisplay icon
# on the desktop and in the menu (deploy/pidisplay.desktop).
FLAG="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/pidisplay-desktop"

if [ -e "$FLAG" ]; then
  # kiosk.sh is parked waiting on this flag; removing it relaunches Chromium.
  rm -f "$FLAG"
elif ! pgrep -f 'chromium.*127.0.0.1:808[0]' >/dev/null; then
  # The kiosk loop isn't running at all (e.g. started some other way); open it directly.
  setsid /home/dan/pidisplay/deploy/kiosk.sh >/dev/null 2>&1 &
fi
