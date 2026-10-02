#!/bin/bash
# Spotify Connect receiver: shows up as "PiDisplay" in the Spotify app on any phone
# or computer on the same Wi-Fi, and is what the Spotify widget plays music on.
# Run as dan by the systemd user unit pidisplay-spotify (deploy/pidisplay-spotify.service).
# Sound goes to PipeWire's default output, which the widget's Speakers sheet switches
# between the display, the headphone jack and Bluetooth speakers.
DATA="${PIDISPLAY_DATA:-$HOME/pidisplay-data}"
# Holds librespot's login after the first time someone picks PiDisplay in the
# Spotify app; server/spotify.js checks for credentials.json in here.
CACHE="$DATA/spotify-cache"
mkdir -p "$CACHE" && chmod 700 "$CACHE"

# The name must match RECEIVER_NAME in server/spotify.js.
exec "$(command -v librespot || echo /usr/bin/librespot)" \
  --name PiDisplay \
  --device-type speaker \
  --backend alsa \
  --device default \
  --bitrate 320 \
  --initial-volume 70 \
  --enable-volume-normalisation \
  --cache "$CACHE" \
  --disable-audio-cache \
  --quiet
