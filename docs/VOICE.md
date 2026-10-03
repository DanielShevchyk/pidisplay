# Voice control

Say **"Hey Jarvis"** (or pick another wake word), then a command: "set a timer for 10 minutes", "add milk to the grocery list", "what's the weather tomorrow", "play Fleetwood Mac". The display shows what it heard and the answer, and says the answer out loud.

Everything runs on the Pi. Nothing is sent to a cloud speech service and no accounts or keys are needed.

## What you need

**A USB microphone.** The Raspberry Pi 4 has no microphone input, and most portable monitors don't have a microphone either (on the Pi, `arecord -l` lists any it can use). Plug one into a USB port; PipeWire picks it up on its own.

- Best for a wall display: a **USB conference microphone or speakerphone** (omnidirectional, built to hear a room). These pick you up from across the room.
- Fine if you're close to the screen: any small USB desk microphone.
- Avoid tiny USB dongle microphones; they only hear you within a meter or two.

Answers play through the display's speakers like the alarms do.

## Setting it up

`.\deploy\deploy.ps1` does it. The first deploy after this change runs `deploy/voice-setup.sh` on the Pi, which:

1. installs `python3-venv`, `alsa-utils`, `unzip` and `pulseaudio-utils` if missing,
2. makes a Python virtualenv in `~/pidisplay-data/voice/venv` with the packages in `voice/requirements.txt`,
3. downloads the Vosk speech model (40 MB) and the Piper voice (about 60 MB) into `~/pidisplay-data/voice`,
4. installs and starts the `pidisplay-voice` user service.

Later deploys skip whatever is already there. If the setup fails (no internet, say), the deploy prints a warning and the dashboard still updates; deploy again to retry.

## Using it

- **Wake word**: "Hey Jarvis", then the command. A chime plays and a card at the bottom of the screen shows the words as you speak. Music turns down while it listens.
- **Tap to talk**: tap 🎙️ in the top bar and speak.
- **Voice sheet**: hold 🎙️ (or ⚙ → Voice control). It shows whether the service and microphone are working, has a box to **type** commands (handy for testing, or from a laptop), lists things to say (tap one to try it), recent commands, and settings: wake word, sensitivity, spoken answers on or off and their volume, the chime, and turning music down while listening.
- **While an alarm, timer or reminder is ringing**, just say "stop" or "snooze"; no wake word needed.
- When it needs more ("For how long?", "Which list?"), it keeps listening for your answer.

## Things to say

| Area | Examples |
| --- | --- |
| Timers | set a timer for 10 minutes · set a pasta timer for 8 minutes · how much time is left · add 5 minutes to the timer · pause / resume / cancel the timer · cancel all timers |
| Alarms | wake me up at 6:30 · set an alarm for 7 AM every weekday · alarm in 20 minutes · what alarms do I have · turn off my 7 AM alarm · delete all alarms |
| Ringing | stop · snooze · snooze for 5 minutes |
| Reminders | remind me to call Mom at 5 PM · remind me in 20 minutes to check the oven · remind me to take out the trash every Tuesday at 7 PM · remind me tomorrow about the dentist · what are my reminders today · mark the reminder done · delete the reminder to call Mom |
| Lists | add milk and eggs to the grocery list · we're out of coffee · what's on my grocery list · what do I need from the store · cross bread off the grocery list · remove eggs from groceries · add call the dentist to my to-do list · clear checked items from groceries · clear the grocery list · create a list called Hardware store |
| Weather | what's the weather · will it rain tomorrow · do I need an umbrella · what's the weather this weekend / on Friday / in Chicago · what's the temperature · when is sunset · how's the air quality |
| Calendar | what's on my calendar today · what's my next event · do I have anything tomorrow · am I free this weekend |
| Music (Spotify) | play Fleetwood Mac · play my Chill playlist · play Hotel California by the Eagles · play the album Rumours · play some jazz · pause · resume · next song · previous song · what's playing · shuffle on · repeat this song · play music on the kitchen speaker · switch the sound to bluetooth |
| Volume | volume up · turn it down a little · set volume to 40 · volume 7 (= 70) · mute · unmute |
| Stocks, news, fares | how is Apple stock doing · how are my stocks · what are the headlines · local news · any fare deals |
| More | read my notifications · clear my notifications · what time is it · what's the date · what's the Pi's temperature · what's your IP address |
| Screen | show the weather · go to the Music page · show my grocery list · go home · next page · previous page · stay on this page · resume rotating · dark mode · light mode · close · go back · refresh the screen · what can I say |

If a "show ..." has no tile on any page, it answers out loud instead.

## How it works

```
USB mic ─► voice/pidisplay_voice.py (pidisplay-voice user service)
             openWakeWord: "Hey Jarvis"?
             Vosk: speech ─► text          ─► POST /api/voice/command
                                                server/voice.js works out what it means and does it
                                                (timers, reminders, lists, Spotify, weather...)
             Piper: says the reply  ◄──────── { reply, action, expectReply }
Screens ◄── SSE "voice" events: listening, words so far, the answer, screen actions (change page, close)
```

- `voice/pidisplay_voice.py`: the microphone loop. Wake word, recording until you pause, transcription, spoken reply, turning other sound down while listening, "stop"/"snooze" while something rings. It reads its settings from the server and follows changes live.
- `server/voice.js` (with `server/voice-parse.js` for numbers, times, days and repeats): one phrase book for every widget. It calls the same modules the tiles use, so a voice timer is a normal timer and a voice grocery item shows up on every screen at once. Typed commands go through the same code.
- `src/core/voice.ts`: the 🎙️ button, the card at the bottom of the screen and the Voice sheet.

## Why these projects

All are open source and run offline on a Pi 4.

| Job | Picked | Also looked at |
| --- | --- | --- |
| Wake word | **openWakeWord** through `pyopen-wakeword` (Apache-2.0), Home Assistant's maintained build. Uses little CPU, ships "Hey Jarvis", "Alexa", "Hey Mycroft", "Okay Nabu" and "Hey Rhasspy", and takes custom models. | The upstream `openwakeword` pip package doesn't install on 64-bit Pi OS (its `tflite-runtime` dependency has no arm64 wheel). Porcupine (Picovoice) is accurate but needs an account key and isn't open source. microWakeWord targets ESP32 speakers. Mycroft Precise is unmaintained. |
| Speech to text | **Vosk** small English model (Apache-2.0). Streams in real time on a Pi 4, so words appear while you speak and a command finishes as soon as you stop; also does the "stop"/"snooze" listening cheaply. | whisper.cpp and faster-whisper are more accurate on free text, but even the tiny and base models take seconds per command on a Pi 4 and don't stream. sherpa-onnx is a good streaming option with a heavier setup. Home Assistant's Speech-to-Phrase is fast but only knows fixed sentences, so it can't take grocery items or reminder text. |
| Understanding | **Our own phrase book** in `server/voice.js`, with tests. It talks straight to the widgets' modules. | Rhasspy and Home Assistant Assist (Hassil) are built around Home Assistant; Rasa is far heavier than this needs. |
| Spoken replies | **Piper** (GPL-3.0, run as its own program), `en_US-lessac-medium`. Natural, and faster than real time on a Pi 4. | espeak-ng is instant but robotic. |
| Whole assistants | (none) | OpenVoiceOS and Neon bring their own skills system and screen; they'd duplicate the dashboard rather than drive it. |

## Custom wake words

Put an openWakeWord `.tflite` model in `~/pidisplay-data/voice/wakewords/` (for example `hey_pi.tflite`; community-trained models are shared online, or train your own with openWakeWord's notebook). It appears in the Voice sheet's wake word list within a minute.

## A more accurate speech model

The small Vosk model is fast but makes more mistakes on unusual words. The larger `vosk-model-en-us-0.22-lgraph` (128 MB) is more accurate and still runs on a Pi 4, a bit slower:

```bash
cd ~/pidisplay-data/voice
curl -LO https://alphacephei.com/vosk/models/vosk-model-en-us-0.22-lgraph.zip && unzip vosk-model-en-us-0.22-lgraph.zip
ln -sfn ~/pidisplay-data/voice/vosk-model-en-us-0.22-lgraph vosk-model
systemctl --user restart pidisplay-voice
```

## Troubleshooting

| Problem | Try |
| --- | --- |
| 🎙️ is dimmed / "Voice service is not running" | `systemctl --user status pidisplay-voice` and `journalctl --user -u pidisplay-voice -n 50`. Deploy again if the setup didn't finish. |
| "No microphone" | Plug in a USB microphone. `arecord -l` should list it; `pactl list short sources` should show an `alsa_input...` source. |
| It wakes up by itself | Voice sheet → Wake word sensitivity → Strict. |
| It doesn't hear the wake word | Move the microphone closer or pick "Easy to wake". Try "Alexa" or "Hey Mycroft", which some voices trigger more reliably. |
| Hears the words wrong | Speak after the chime, or try the larger speech model above. Typed commands in the Voice sheet show whether the problem is hearing or understanding. |
| No spoken answers | Voice sheet → Say answers out loud. Test the voice and speakers: `~/pidisplay-data/voice/venv/bin/python ~/pidisplay/voice/pidisplay_voice.py --speak "hello"` |
| Test without a microphone | `~/pidisplay-data/voice/venv/bin/python ~/pidisplay/voice/pidisplay_voice.py --command "what time is it"` |

## API

| Method | Path | Body / notes |
| --- | --- | --- |
| GET | `/api/voice` | Settings, voice service status (running, microphone, models), wake word choices, example phrases, recent commands. |
| PUT | `/api/voice/settings` | `{ "enabled", "wakeWord", "sensitivity" (0.1-0.95), "speak", "speechVolume" (0-100), "chime", "duck" }`; saved in `$PIDISPLAY_DATA/voice.json`. |
| POST | `/api/voice/command` | `{ "text", "source": "voice" \| "typed" }` → `{ ok, heard, reply, action?, expectReply }`. |
| POST | `/api/voice/listen` · `cancel` | Tap to talk (409 when the voice service isn't running) · stop listening. |
| GET / POST | `/api/voice/config` · `status` · `event` | Used by the voice service: its settings, its heartbeat, and listening events for the screens. |
