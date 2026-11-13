# Spotify

The Spotify widget shows what's playing and controls it: play/pause, skip, seek, shuffle,
repeat, volume, your playlists and search. Music can play on:

- **The display itself.** The Pi runs a Spotify Connect receiver (librespot, from the
  [raspotify](https://github.com/dtcooper/raspotify) package) called **PiDisplay**. Its
  sound goes to whichever output is picked under **Speakers**: the display's speakers
  (HDMI), the headphone jack, or a connected Bluetooth speaker.
- **Any other Spotify Connect speaker** (phones, computers, smart speakers, TVs) that has
  Spotify open on your account. Pick it under **Speakers** to move the music there.

Needs Spotify Premium (both for Spotify Connect receivers and for the Web API).

## Setup (once)

1. **Deploy.** `.\deploy\deploy.ps1` installs raspotify, `pactl` and `pipewire-alsa`, and
   starts the receiver as dan's user service `pidisplay-spotify`.
2. **Create a Spotify app** (free). On the laptop, open
   <https://developer.spotify.com/dashboard>, log in with your Spotify account and click
   **Create app**:
   - App name and description: anything, e.g. "PiDisplay".
   - Redirect URI: `http://127.0.0.1:8080/api/spotify/callback` (exactly; click **Add**).
   - Which API/SDKs: tick **Web API**.
   - Agree to the terms and **Save**. Copy the **Client ID** from the app's page.

   Spotify only lets an app in development mode be used by its owner plus up to 5 people
   you add under **User Management**. The owner needs Premium.
3. **Sign in.** From the pidisplay folder on the laptop:
   ```powershell
   .\deploy\spotify.ps1 -ClientId <the Client ID>
   ```
   This saves the Client ID on the Pi, opens an SSH tunnel and opens Spotify's sign-in
   page in the laptop's browser. Sign in and tap **Agree**; the script notices and closes
   the tunnel. (Or tap **Set up Spotify** on the widget, paste the Client ID there and use
   **Log in on this screen**.)
4. **Link the PiDisplay speaker.** Open Spotify on your phone on the same Wi-Fi, tap the
   speakers icon and pick **PiDisplay**. This logs the receiver in; it remembers the login
   (in `~/pidisplay-data/spotify-cache`) so from then on the widget can start music on the
   display by itself, also after reboots.

Run `.\deploy\spotify.ps1` with no arguments to check the status or sign in again, and
`.\deploy\spotify.ps1 -Logout` to sign the display out.

## Speakers

**Speakers** on the widget has three parts:

- **Play Spotify on**: Spotify Connect devices. Tap one to move the music there.
- **PiDisplay plays through**: where the display's own sound goes. Switching moves Spotify
  and anything else playing (alarms too) and becomes the default for the Pi. The slider
  sets that output's volume (separate from Spotify's own volume on the player).
- **Bluetooth speakers**: paired speakers that aren't connected. Tap to connect; the
  display switches to it once its sound output appears. **Pair a Bluetooth speaker** opens
  the same Bluetooth screen as the gear menu (put the speaker in pairing mode first).

## Playing on the TV

If the TV has the Spotify app (or a Chromecast, Fire TV, Roku, Apple TV or game console
plugged into it does), it is a Spotify Connect device like any other:

1. Open Spotify on the TV once and sign in with the same account as the display.
2. On the display, open **Speakers**. The TV is listed under **Play Spotify on**; tap it to
   move the music there. The TV shows the song and its own speakers (or the soundbar
   plugged into it) play it. The display keeps working as the remote.
3. To make that the default, pick the TV under **Start new music on**. Songs chosen on the
   display then start on the TV whenever Spotify can see it, and on the display otherwise.
   Music that is already playing stays where it is.

Spotify only lists a TV while it is reachable: on, or in a standby that keeps its network
connection (often called "quick start" or "wake on network" in the TV's settings).
Chromecast-type devices may only appear after the Spotify app has been opened on them.

### LG webOS TVs: the display turns the TV on and opens Spotify

An LG TV only shows up in Spotify while its Spotify app is open, so the display can do that
part for you:

1. On the TV: **Settings > General > Devices > External Devices > TV On With Mobile >
   Turn on via Wi-Fi** (on). Without it the display can open Spotify while the TV is on,
   but can't switch it on.
2. With the TV on, open **Speakers** on the display and tap **Link my LG TV**. Pick the TV
   (or type its address), then choose **Accept** on the TV's prompt. The pairing key is
   saved in `$PIDISPLAY_DATA/lgtv.json` on the Pi.
3. **Open Spotify on (TV name)** now switches the TV on if needed, opens its Spotify app and
   waits for it to appear. The first time, sign in to Spotify on the TV with the same
   account. If no default speaker is set yet, the TV becomes the default.

With the TV set under **Start new music on**, picking a song while the TV is off turns it
on, opens Spotify and plays there (this can take up to a minute). If it can't, the music
plays on the display and the widget says why.

Give the TV a fixed address in the router (DHCP reservation) so the link keeps working.

## Library

**Library** has four tabs: **Playlists**, **Liked Songs** (newest 100, with Play all and
Shuffle; tapping a song plays the list from there), **Recent** (recently played songs) and
**Search**. Recent needs a permission added after the first version: if it says so, open
**Speakers > Spotify account**, tap **Log out of Spotify** and sign in again once.

The other route skips the TV: pair the speakers with the Pi over Bluetooth (**Speakers** >
**Pair a Bluetooth speaker**) and the display plays through them directly.

## Troubleshooting (on the Pi, over SSH)

```bash
systemctl --user status pidisplay-spotify          # receiver running?
journalctl --user -u pidisplay-spotify -n 50       # its log
pactl list short sinks; pactl get-default-sink     # outputs and the current default
ls ~/pidisplay-data/spotify-cache                   # credentials.json = PiDisplay is linked
```

- PiDisplay missing from the Spotify app: phone and Pi must be on the same network
  (discovery uses mDNS). Check the receiver is running.
- Sign-in page says "INVALID_CLIENT: Invalid redirect URI": the Redirect URI in the Spotify
  app doesn't match `http://127.0.0.1:8080/api/spotify/callback` exactly.
- "This Spotify account is not on the app's user list": add the account under User
  Management in the developer dashboard.
