# YouTube on the TV

The YouTube widget finds videos on the display and plays them on a smart TV's YouTube app, the way casting from the YouTube phone app does. Nothing plays on the Pi. It needs no account, API key or developer app.

## Link the TV (once)

Add the YouTube widget (or use the **TV** page), tap **Link TV**, then either:

- **TV code (any brand).** On the TV, open YouTube, go to **Settings > Link with TV code**. Type the 12-digit code on the display and tap **Link**. Codes change every few minutes, so use a fresh one.
- **Find TVs on the network.** Tap **Find TVs on the network**, then **Link** next to your TV. This uses DIAL, which most smart TVs, Fire TV, Roku and Android TV boxes support. The TV must be on. PiDisplay opens YouTube on the TV if it is closed, so this kind of link can also start the app later.

The TV shows up under **Linked TVs**. Link more than one and tap **Use** to switch. The link lasts until you tap **Forget** or unlink devices in the TV's YouTube settings.

## Using it

- **Search** with the on-screen keyboard. Tap a video to play it on the TV now, **+** to add it to the TV's queue, **☆** to save it.
- **Recently played** lists what was sent to the TV; **Saved** keeps your starred videos (shared by every screen).
- The bar under the list (or the whole tile at small sizes) is a remote for whatever the TV is playing, even if it was started from a phone: play/pause, previous (restarts after the first seconds), next, tap the progress bar to seek, and volume.
- Voice: "play cat videos on the TV", "play lofi music on YouTube", "pause the TV", "resume the TV".

Big tiles (Large, Extra large, Full page, half page) show the browser and the remote together. Small, Wide and Tall tiles show the remote; tap them to open the browser in a sheet.

## How it works

- **Search** uses YouTube's own web search endpoint (`youtubei/v1/search`), the one youtube.com uses, so no key is needed. If YouTube changes it and search breaks, update `parseSearch` in `server/youtube.js`.
- **Playback** uses the YouTube Lounge service (`youtube.com/api/lounge`), which the phone app uses to cast. A linked TV is a *screen id* plus a *lounge token*; the server renews the token from the screen id before it expires. While a screen shows the widget, the server keeps a session open to hear the TV's play state, position and volume, and closes it 30 minutes after the widget was last used (unless something is playing). The TV may briefly show "PiDisplay connected".
- Linked TVs and the history are in `$PIDISPLAY_DATA/youtube.json`. Saved videos are in the `youtube` store key.

## Troubleshooting

- **"That code didn't work"**: the code expired. Get a new one on the TV.
- **The video doesn't start**: the TV is off or its YouTube app is closed. Turn it on and open YouTube, or link it with **Find TVs on the network** so PiDisplay can open the app itself. TVs that sleep deeply drop off the network; enabling the TV's "turn on with mobile" or network standby setting helps.
- **No TVs found on the network**: the TV and Pi must be on the same network, and some routers block discovery between Wi-Fi and wired devices. The TV code always works.
