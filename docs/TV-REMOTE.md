# TV remote (LG webOS)

The **TV remote** widget turns the display into a remote for an LG webOS TV. It shares the
TV link with the Spotify widget (`server/lgtv.js`), so a TV linked under Spotify's
**Speakers** works here straight away, and the other way round.

## Setup

1. On the TV: **Settings > General > Devices > External Devices > TV On With Mobile >
   Turn on via Wi-Fi** (on). Without it the remote works while the TV is on, but its power
   button can't switch the TV on.
2. Give the TV a fixed address in the router (a DHCP reservation), so the link keeps working.
3. Add the **TV remote** tile (✎ edit mode, then +). With no TV linked yet it shows
   **Link my LG TV**: pick the TV from the list (or type its address), then choose
   **Accept** on the TV. The pairing key is saved in `$PIDISPLAY_DATA/lgtv.json` on the Pi.
4. Switch the TV on with its own remote once while linked. The Pi learns the TV's network
   card address then, which it needs to wake the TV later.

## What each size shows

| Size | Controls |
| --- | --- |
| Small | Power, volume − / mute / +. Tap anywhere else for the full remote. |
| Wide | D-pad and OK, back / home / settings, volume, power, ⋯ for the full remote. |
| Tall | The same plus channel up/down. |
| Large | D-pad, volume and channel rockers, rewind / play / pause / fast forward, and buttons for apps, number pad, touchpad and typing. |
| Extra large / Full page | All of that with the TV's apps beside it (the one on screen is outlined) and an **Inputs** button. |

The **full remote** sheet has pages for the buttons, **Apps & inputs**, **Numbers**
(0-9, dash, the four colour buttons, Guide, List, Info, Exit), **Touchpad** (drag to move
the TV's pointer, tap to click, the strip on the right scrolls) and **Type** (sends text
into whatever search box is open on the TV, optionally pressing Enter).

Arrows, volume and channel buttons repeat while held, like a real remote.

## Volume through a soundbar

When the TV's sound goes to a soundbar or receiver (HDMI ARC, optical, Bluetooth), the TV
accepts a "set volume to N" command but ignores it, and its own volume number doesn't
follow the soundbar. So on those outputs the remote only sends volume up/down steps, the
same as the TV's own remote, and doesn't show a number. Mute is passed on the same way.

## How it talks to the TV

- Commands go over LG's SSAP WebSocket (wss port 3001, or ws 3000 on older sets). Arrow
  keys, OK, back, home, numbers and the pointer go over the TV's separate pointer socket
  (`getPointerInputSocket`).
- The server keeps one session (and the pointer socket) open while buttons are being
  pressed and closes both after 20 seconds without a press, so presses don't each pay
  for a TLS handshake.
- The tile only asks the TV for its state (on/off, app, volume) while it is on screen:
  every 4 s while the TV is on, every 12 s while it's off. It never wakes the TV for that.
- Power off is `system/turnOff`; power on is Wake-on-LAN, then up to 30 s of waiting for
  the TV to answer.

## When something doesn't work

- **"The TV won't let PiDisplay do that yet"**: newer firmware wanted a permission the
  link didn't ask for. Unlink the TV (Spotify > Speakers) and link it again. If it still
  happens, compare `MANIFEST` in `server/lgtv.js` with aiowebostv's current one.
- **"... is off or not answering"**: the TV is off, or its address changed. Check the
  DHCP reservation.
- **Power doesn't switch it on**: check step 1 above, and that the TV was once switched
  on while linked (step 4).
- App icons are loaded straight from the TV. If they don't show, the tiles fall back to
  the app's first letter; tapping them still works.
