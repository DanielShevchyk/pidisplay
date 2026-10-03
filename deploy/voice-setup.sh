#!/bin/bash
# Runs on the Pi (from deploy/update.sh): sets up offline voice control, see docs/VOICE.md.
# Python packages go in a virtualenv and the speech models next to it, all under
# $PIDISPLAY_DATA/voice, so a redeploy only downloads what's missing or changed.
set -euo pipefail
cd "$(dirname "$0")/.."
DATA="${PIDISPLAY_DATA:-$HOME/pidisplay-data}"
VOICE="$DATA/voice"
VOSK_MODEL=vosk-model-small-en-us-0.15
PIPER_VOICE=en_US-lessac-medium
mkdir -p "$VOICE/piper" "$VOICE/wakewords"

# arecord/aplay for the microphone and speakers, pactl to turn music down while listening.
for pkg in python3-venv alsa-utils unzip pulseaudio-utils; do
  dpkg -s "$pkg" >/dev/null 2>&1 || sudo apt-get install -y "$pkg"
done

if [ ! -x "$VOICE/venv/bin/python" ]; then
  python3 -m venv "$VOICE/venv"
fi
# Only reinstall when requirements.txt changed.
REQS_HASH="$(sha256sum voice/requirements.txt | cut -d' ' -f1)"
if [ "$(cat "$VOICE/.requirements" 2>/dev/null)" != "$REQS_HASH" ]; then
  "$VOICE/venv/bin/pip" install --quiet --upgrade pip
  "$VOICE/venv/bin/pip" install --quiet -r voice/requirements.txt
  echo "$REQS_HASH" > "$VOICE/.requirements"
fi

# Vosk's small English model (40 MB): fast enough on a Pi 4 to keep up with speech.
# To try the bigger, more accurate one, unzip vosk-model-en-us-0.22-lgraph into $VOICE
# and point the vosk-model link at it.
if [ ! -d "$VOICE/$VOSK_MODEL" ]; then
  curl -fsSL -o "/tmp/$VOSK_MODEL.zip" "https://alphacephei.com/vosk/models/$VOSK_MODEL.zip"
  unzip -q -o "/tmp/$VOSK_MODEL.zip" -d "$VOICE"
  rm -f "/tmp/$VOSK_MODEL.zip"
fi
[ -e "$VOICE/vosk-model" ] || ln -s "$VOICE/$VOSK_MODEL" "$VOICE/vosk-model"

# Piper voice for spoken replies (about 60 MB, from Hugging Face).
if [ ! -f "$VOICE/piper/$PIPER_VOICE.onnx" ]; then
  "$VOICE/venv/bin/python" -m piper.download_voices --download-dir "$VOICE/piper" "$PIPER_VOICE"
fi

export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
mkdir -p "$HOME/.config/systemd/user"
tr -d '\r' < deploy/pidisplay-voice.service > "$HOME/.config/systemd/user/pidisplay-voice.service"
systemctl --user daemon-reload
systemctl --user enable pidisplay-voice
systemctl --user restart pidisplay-voice
echo "Voice control is running (journalctl --user -u pidisplay-voice -f)."
