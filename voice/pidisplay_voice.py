#!/usr/bin/env python3
"""PiDisplay voice service: wake word -> speech to text -> PiDisplay -> spoken reply.

Runs on the Pi as dan's systemd user unit `pidisplay-voice` (deploy/pidisplay-voice.service),
fully offline, all open source:
  - openWakeWord (pyopen-wakeword) listens for the wake word ("Hey Jarvis" by default),
  - Vosk turns the command that follows into text,
  - the PiDisplay server (server/voice.js) works out what it means and does it,
  - Piper says the reply through the display's speakers.
While an alarm, timer or reminder is ringing, "stop" and "snooze" work without the wake word.
The dashboard's mic button (tap to talk) and the Voice sheet talk to this service through the server.

Set up by deploy/voice-setup.sh, which makes a virtualenv and downloads the models into
$PIDISPLAY_DATA/voice. Logs: journalctl --user -u pidisplay-voice

Try it without a microphone:
  ~/pidisplay-data/voice/venv/bin/python ~/pidisplay/voice/pidisplay_voice.py --command "what time is it"
"""

import argparse
import json
import math
import os
import queue
import struct
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

SERVER = os.environ.get("PIDISPLAY_URL", "http://127.0.0.1:8080").rstrip("/")
DATA = Path(os.environ.get("PIDISPLAY_DATA", str(Path.home() / "pidisplay-data")))
HOME = Path(os.environ.get("VOICE_HOME", str(DATA / "voice")))
VOSK_MODEL = Path(os.environ.get("VOICE_VOSK_MODEL", str(HOME / "vosk-model")))
PIPER_DIR = HOME / "piper"
PIPER_VOICE = os.environ.get("VOICE_PIPER_VOICE", "en_US-lessac-medium")
CUSTOM_WAKE_DIR = HOME / "wakewords"
# ALSA devices; "default" goes through PipeWire, so the mic and speakers follow
# whatever the desktop (and the dashboard's Speakers sheet) has picked.
MIC = os.environ.get("VOICE_MIC", "default")
SPEAKER = os.environ.get("VOICE_SPEAKER", "default")

RATE = 16000
CHUNK_SAMPLES = 1280  # 80 ms, what openWakeWord works in
CHUNK_BYTES = CHUNK_SAMPLES * 2

# Listening for the command after the wake word.
NO_SPEECH_SECONDS = 6.0  # give up if nothing is said
MAX_COMMAND_SECONDS = 12.0
QUIET_AFTER_SPEECH_SECONDS = 1.2  # a pause this long ends the command
WAKE_COOLDOWN_SECONDS = 2.0
HEARTBEAT_SECONDS = 20
# Without the wake word while something rings.
RINGING_PHRASES = ["stop", "snooze", "dismiss", "cancel", "stop the alarm", "stop the timer", "turn it off", "i am up", "[unk]"]
DUCK_TO = 0.3  # other sound drops to 30% while listening


def log(*args):
    print(time.strftime("%H:%M:%S"), *args, flush=True)


# ---- Talking to the PiDisplay server -------------------------------------


def api(method, path, body=None, timeout=15):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"{SERVER}/api{path}", data=data, method=method, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as err:
        try:
            message = json.loads(err.read()).get("error")
        except Exception:
            message = None
        raise RuntimeError(message or f"{method} {path} failed: {err.code}") from None


def event(kind, text=""):
    try:
        api("POST", "/voice/event", {"type": kind, "text": text}, timeout=3)
    except Exception as err:
        log("event failed:", err)


def follow_events(on_event, stop):
    """Follows the server's SSE stream, calling on_event(name, data) for voice events. Reconnects."""
    while not stop.is_set():
        try:
            req = urllib.request.Request(f"{SERVER}/api/events", headers={"Accept": "text/event-stream"})
            with urllib.request.urlopen(req, timeout=60) as res:
                name, data = None, []
                for raw in res:
                    if stop.is_set():
                        return
                    line = raw.decode("utf-8", "replace").rstrip("\r\n")
                    if line.startswith("event:"):
                        name = line[6:].strip()
                    elif line.startswith("data:"):
                        data.append(line[5:].strip())
                    elif line == "":
                        if name in ("voice-control", "voice-settings") and data:
                            try:
                                on_event(name, json.loads("\n".join(data)))
                            except Exception as err:
                                log("event handler failed:", err)
                        name, data = None, []
        except Exception as err:
            log("event stream:", err)
        stop.wait(3)


# ---- Sound in and out ------------------------------------------------------


def pactl_json(*args):
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    out = subprocess.run(["pactl", "-f", "json", *args], capture_output=True, text=True, timeout=5, env=env)
    return json.loads(out.stdout or "[]") if out.returncode == 0 else []


def pactl(*args):
    env = dict(os.environ)
    env.setdefault("XDG_RUNTIME_DIR", f"/run/user/{os.getuid()}")
    subprocess.run(["pactl", *args], capture_output=True, timeout=5, env=env)


def find_mic():
    """The name of a real microphone PipeWire can see (not a speaker's monitor), or None."""
    try:
        sources = [
            s
            for s in pactl_json("list", "sources")
            if not s.get("name", "").endswith(".monitor") and s.get("monitor_of_sink") in (None, "", "n/a")
        ]
        return (sources[0].get("description") or sources[0].get("name")) if sources else None
    except Exception:
        # No pactl: trust ALSA.
        out = subprocess.run(["arecord", "-l"], capture_output=True, text=True)
        cards = [l for l in out.stdout.splitlines() if l.startswith("card ")]
        return cards[0] if cards else None


class Mic:
    """arecord streaming 16 kHz mono 16-bit audio into a queue of 80 ms chunks."""

    def __init__(self):
        self.chunks = queue.Queue(maxsize=200)
        self.proc = None
        self.alive = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()

    def _run(self):
        while True:
            cmd = ["arecord", "-q", "-D", MIC, "-f", "S16_LE", "-r", str(RATE), "-c", "1", "-t", "raw"]
            try:
                self.proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                self.alive = True
                while True:
                    data = self.proc.stdout.read(CHUNK_BYTES)
                    if not data or len(data) < CHUNK_BYTES:
                        break
                    if self.chunks.full():
                        try:
                            self.chunks.get_nowait()
                        except queue.Empty:
                            pass
                    self.chunks.put(data)
            except Exception as err:
                log("microphone:", err)
            self.alive = False
            log("microphone stopped; retrying in 10 s")
            time.sleep(10)

    def read(self, timeout=1.0):
        try:
            return self.chunks.get(timeout=timeout)
        except queue.Empty:
            return None

    def drain(self):
        while True:
            try:
                self.chunks.get_nowait()
            except queue.Empty:
                return


def tone(freqs, ms=110, rate=22050, volume=0.35):
    """A short soft beep per frequency, as raw 16-bit mono audio."""
    out = bytearray()
    for f in freqs:
        n = int(rate * ms / 1000)
        for i in range(n):
            env = min(1.0, i / (rate * 0.01), (n - i) / (rate * 0.03))
            out += struct.pack("<h", int(32767 * volume * env * math.sin(2 * math.pi * f * i / rate)))
    return bytes(out)


class Speaker:
    """Plays raw audio with aplay; one sound at a time, can be cut off."""

    def __init__(self):
        self.proc = None
        self.lock = threading.Lock()

    def play(self, audio, rate, wait=True):
        cmd = ["aplay", "-q", "-D", SPEAKER, "-t", "raw", "-f", "S16_LE", "-r", str(rate), "-c", "1"]
        with self.lock:
            self.stop()
            self.proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
            proc = self.proc
        try:
            proc.stdin.write(audio)
            proc.stdin.close()
        except BrokenPipeError:
            pass
        if wait:
            proc.wait()

    def stop(self):
        if self.proc and self.proc.poll() is None:
            self.proc.kill()


class Ducker:
    """Turns everything already playing down while listening, then back up."""

    def __init__(self):
        self.saved = {}

    def duck(self):
        if self.saved:
            return
        try:
            for s in pactl_json("list", "sink-inputs"):
                vol = s.get("volume") or {}
                pct = [int(str(v.get("value_percent", "100%")).rstrip("%")) for v in vol.values()] or [100]
                level = max(pct)
                if level <= 5:
                    continue
                self.saved[s["index"]] = level
                pactl("set-sink-input-volume", str(s["index"]), f"{max(1, int(level * DUCK_TO))}%")
        except Exception as err:
            log("duck:", err)

    def restore(self):
        for index, level in self.saved.items():
            try:
                pactl("set-sink-input-volume", str(index), f"{level}%")
            except Exception:
                pass
        self.saved = {}


# ---- Models -----------------------------------------------------------------


class WakeWord:
    def __init__(self, name, threshold):
        from pyopen_wakeword import Model, OpenWakeWord, OpenWakeWordFeatures

        custom = CUSTOM_WAKE_DIR / f"{name}.tflite"
        if custom.exists():
            self.model = OpenWakeWord.from_model(custom)
        else:
            self.model = OpenWakeWord.from_builtin(Model(name))
        self.features = OpenWakeWordFeatures.from_builtin()
        self.name = name
        self.threshold = threshold

    def heard(self, chunk):
        hit = False
        for feats in self.features.process_streaming(chunk):
            for prob in self.model.process_streaming(feats):
                if prob >= self.threshold:
                    hit = True
        return hit

    def reset(self):
        self.model.reset()
        self.features.reset()


def custom_wake_words():
    return sorted(p.stem for p in CUSTOM_WAKE_DIR.glob("*.tflite")) if CUSTOM_WAKE_DIR.exists() else []


class Recognizer:
    """Vosk speech to text; one model shared by every utterance."""

    def __init__(self):
        import vosk

        vosk.SetLogLevel(-1)
        self.vosk = vosk
        self.model = vosk.Model(str(VOSK_MODEL))
        self.name = VOSK_MODEL.resolve().name

    def stream(self, grammar=None):
        if grammar:
            return self.vosk.KaldiRecognizer(self.model, RATE, json.dumps(grammar))
        return self.vosk.KaldiRecognizer(self.model, RATE)


class Voice:
    """Piper text to speech."""

    def __init__(self):
        from piper import PiperVoice

        path = PIPER_DIR / f"{PIPER_VOICE}.onnx"
        self.voice = PiperVoice.load(str(path))
        self.rate = self.voice.config.sample_rate
        self.name = PIPER_VOICE

    def synthesize(self, text, volume):
        from piper import SynthesisConfig

        config = SynthesisConfig(volume=max(0.05, volume / 100))
        return b"".join(chunk.audio_int16_bytes for chunk in self.voice.synthesize(text, syn_config=config))


def for_speech(text):
    """Small fixes so Piper reads replies naturally."""
    return text.replace("PiDisplay", "Pi Display").replace(" AM", " A M").replace(" PM", " P M")


# ---- The service -------------------------------------------------------------


class Service:
    def __init__(self):
        self.settings = {"enabled": True, "wakeWord": "hey_jarvis", "sensitivity": 0.5, "speak": True, "speechVolume": 80, "chime": True, "duck": True}
        self.ringing = False
        self.listen_now = threading.Event()
        self.cancel = threading.Event()
        self.reload_wake = threading.Event()
        self.stop = threading.Event()
        self.error = None
        self.wake = None
        self.recognizer = None
        self.tts = None
        self.speaker = Speaker()
        self.ducker = Ducker()
        self.mic = None
        self.mic_name = None
        self.status_changed = True
        self.last_wake = 0.0

    # -- setup --

    def load_models(self):
        errors = []
        try:
            self.recognizer = Recognizer()
            log("speech model:", self.recognizer.name)
        except Exception as err:
            errors.append(f"Speech model missing ({VOSK_MODEL}); rerun the deploy to download it")
            log("vosk:", err)
        try:
            self.tts = Voice()
            log("voice:", self.tts.name)
        except Exception as err:
            log("piper:", err)
            errors.append("Spoken replies are off: the Piper voice is missing")
        self.load_wake()
        self.error = "; ".join(errors) or None

    def load_wake(self):
        name = self.settings.get("wakeWord") or "hey_jarvis"
        try:
            self.wake = WakeWord(name, float(self.settings.get("sensitivity", 0.5)))
            log("wake word:", name, "at", self.wake.threshold)
        except Exception as err:
            log("wake word", name, "failed:", err)
            self.wake = None
            try:
                self.wake = WakeWord("hey_jarvis", float(self.settings.get("sensitivity", 0.5)))
            except Exception as err2:
                log("wake word fallback failed:", err2)
        self.status_changed = True

    def fetch_settings(self):
        for _ in range(60):
            try:
                config = api("GET", "/voice/config")
                self.settings.update(config.get("settings") or {})
                self.ringing = bool(config.get("ringing"))
                return
            except Exception as err:
                log("waiting for the PiDisplay server:", err)
                time.sleep(5)

    def on_event(self, name, data):
        if name == "voice-settings":
            old = (self.settings.get("wakeWord"), self.settings.get("sensitivity"))
            self.settings.update(data)
            if old != (self.settings.get("wakeWord"), self.settings.get("sensitivity")):
                self.reload_wake.set()
            return
        if "ringing" in data:
            self.ringing = bool(data["ringing"])
        action = data.get("action")
        if action == "listen":
            self.listen_now.set()
        elif action == "cancel":
            self.cancel.set()
            self.speaker.stop()

    def heartbeat(self):
        while not self.stop.is_set():
            mic = find_mic()
            changed = self.status_changed or mic != self.mic_name
            self.mic_name = mic
            self.status_changed = False
            body = {
                "mic": bool(mic) and bool(self.mic and self.mic.alive),
                "micName": mic,
                "wakeWord": self.wake.name if self.wake else None,
                "stt": self.recognizer.name if self.recognizer else None,
                "tts": self.tts.name if self.tts else None,
                "error": self.error if mic else (self.error or "No microphone found. Plug in a USB microphone."),
                "customWakeWords": custom_wake_words(),
                "changed": changed,
            }
            try:
                config = api("POST", "/voice/status", body, timeout=5)
                self.ringing = bool(config.get("ringing", self.ringing))
            except Exception as err:
                log("heartbeat:", err)
            self.stop.wait(HEARTBEAT_SECONDS)

    # -- talking --

    def say(self, text):
        if not text or not self.tts or not self.settings.get("speak", True):
            return
        try:
            audio = self.tts.synthesize(for_speech(text), self.settings.get("speechVolume", 80))
            self.speaker.play(audio, self.tts.rate)
        except Exception as err:
            log("speak:", err)

    def chime(self, up=True):
        if self.settings.get("chime", True):
            self.speaker.play(tone([660, 990] if up else [880, 590]), 22050, wait=False)

    def run_command(self, text):
        """Sends text to the server, says the reply. Returns whether a follow-up answer is expected."""
        log("heard:", repr(text))
        event("thinking", text)
        try:
            result = api("POST", "/voice/command", {"text": text, "source": "voice"}, timeout=30)
        except Exception as err:
            log("command failed:", err)
            self.say("Sorry, I couldn't reach the dashboard.")
            return False
        reply = (result or {}).get("reply") or ""
        log("reply:", repr(reply))
        if reply:
            event("speaking", reply)
            self.say(reply)
        return bool((result or {}).get("expectReply"))

    # -- listening --

    def listen_for_command(self):
        """After the wake word: transcribe until the speaker pauses. Returns the text or ''."""
        if not self.recognizer:
            event("error", "The speech model is missing. Rerun the deploy.")
            return ""
        rec = self.recognizer.stream()
        started = time.monotonic()
        last_change = started
        partial = ""
        sent_partial = 0.0
        self.cancel.clear()
        while not self.cancel.is_set():
            chunk = self.mic.read(timeout=1.0)
            now = time.monotonic()
            if chunk is None:
                if not self.mic.alive:
                    return ""
                continue
            if rec.AcceptWaveform(chunk):
                text = json.loads(rec.Result()).get("text", "").strip()
                if text:
                    return text
            else:
                p = json.loads(rec.PartialResult()).get("partial", "").strip()
                if p != partial:
                    partial = p
                    last_change = now
                    if now - sent_partial > 0.25:
                        sent_partial = now
                        threading.Thread(target=event, args=("partial", p), daemon=True).start()
            if not partial and now - started > NO_SPEECH_SECONDS:
                return ""
            if partial and now - last_change > QUIET_AFTER_SPEECH_SECONDS:
                break
            if now - started > MAX_COMMAND_SECONDS:
                break
        if self.cancel.is_set():
            return ""
        return json.loads(rec.FinalResult()).get("text", "").strip()

    def conversation(self):
        """One wake: listen, act, answer; keeps listening while the server asks a question."""
        if self.settings.get("duck", True):
            self.ducker.duck()
        try:
            follow_up = True
            while follow_up:
                self.chime(True)
                event("wake")
                self.mic.drain()
                text = self.listen_for_command()
                if not text:
                    event("idle", "")
                    return
                self.speaker.stop()
                follow_up = self.run_command(text)
                self.mic.drain()
        finally:
            self.ducker.restore()
            event("idle", "")
            if self.wake:
                self.wake.reset()
            self.mic.drain()

    def ringing_recognizer(self):
        return self.recognizer.stream(RINGING_PHRASES) if self.recognizer else None

    def run(self):
        self.fetch_settings()
        self.load_models()
        self.mic = Mic()
        threading.Thread(target=follow_events, args=(self.on_event, self.stop), daemon=True).start()
        threading.Thread(target=self.heartbeat, daemon=True).start()
        ring_rec = None
        log("listening")
        while not self.stop.is_set():
            if self.reload_wake.is_set():
                self.reload_wake.clear()
                self.load_wake()
            if self.listen_now.is_set():
                self.listen_now.clear()
                self.conversation()
                continue
            chunk = self.mic.read(timeout=1.0)
            if chunk is None:
                continue
            if self.ringing and self.recognizer:
                ring_rec = ring_rec or self.ringing_recognizer()
                if ring_rec.AcceptWaveform(chunk):
                    text = json.loads(ring_rec.Result()).get("text", "").strip()
                    ring_rec = None
                    if text and text != "[unk]":
                        self.run_command(text)
                        self.mic.drain()
                        continue
            else:
                ring_rec = None
            if self.wake and self.settings.get("enabled", True) and self.wake.heard(chunk):
                now = time.monotonic()
                if now - self.last_wake < WAKE_COOLDOWN_SECONDS:
                    continue
                self.last_wake = now
                log("wake word")
                self.conversation()


def main():
    parser = argparse.ArgumentParser(description="PiDisplay voice control")
    parser.add_argument("--command", help="send this text as a command, say the reply, and exit")
    parser.add_argument("--speak", help="say this text and exit (tests the voice and speakers)")
    args = parser.parse_args()

    if args.speak or args.command:
        service = Service()
        service.fetch_settings()
        try:
            service.tts = Voice()
        except Exception as err:
            print("No Piper voice:", err, file=sys.stderr)
        if args.speak:
            service.say(args.speak)
        else:
            result = api("POST", "/voice/command", {"text": args.command, "source": "typed"})
            print(result.get("reply") or "(no reply)")
            service.say(result.get("reply") or "")
        return
    Service().run()


if __name__ == "__main__":
    main()
