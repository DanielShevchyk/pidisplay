# PiDisplay

A customizable touch dashboard for a wall-mounted Raspberry Pi 4 with a 15.6" 1080p touchscreen.

- **Top bar** that never moves: clock (or any bar-capable widget), page name and dots, notifications bell, edit button.
- **Pages** of tiles that rotate on a timer, or swipe left/right. Touching pauses rotation for a while.
- **Tiles** in nine sizes on a 6×4 grid (configurable): Small 1×1, Wide 2×1, Tall 1×2, Large 2×2, Extra large 3×2, Full-width row (one row across the page), Top/bottom half (full width, half the rows; two stack top and bottom), Left/right half (full height, half the columns; two sit side by side), Full page.
- **Edit mode** (✎ in the top bar): drag tiles to reorder, ⤢ to cycle sizes, ⚙ for widget settings, size and page, ✕ to remove, plus add tiles/pages, page settings, top bar items and display settings (rotation timing, grid size). Changes save to the Pi automatically.
- **Widgets** are self-contained folders in `src/widgets/`. Adding one is dropping in a folder; see [docs/WIDGETS.md](docs/WIDGETS.md).
- **Notifications**: anything on the network path can `POST /api/notifications` to pop a toast and add to the bell.

## Stack

| Part | What | Why |
| --- | --- | --- |
| UI | Vanilla TypeScript + CSS, bundled by Vite | ~8 KB gzipped JS, no framework runtime, fast on a Pi 4 |
| Server | `server/server.js`, plain Node, zero dependencies | Serves the built UI and a small JSON API |
| Storage | JSON files in `data/` (written atomically) | Layout, widget data and notifications survive reboots and are easy to back up |
| Live updates | Server-sent events at `/api/events` | Notifications and edits from another screen show up instantly |

## Running

Needs Node 20.19+ (Raspberry Pi OS's apt Node is too old; use NodeSource or nvm).

```bash
npm install
npm run build       # type-checks and builds the UI into dist/
npm start           # http://127.0.0.1:8080
```

Open `http://127.0.0.1:8080/?kiosk` on the Pi (`?kiosk` hides the mouse cursor).

Development with hot reload: `npm run dev`, then open http://localhost:5173.

Tests: `npm test` (server API).

### Environment variables

| Var | Default | Meaning |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `HOST` | `127.0.0.1` | Bind address. Set `0.0.0.0` to edit the dashboard from a phone or laptop on your LAN. The API has no login, so only do this on a trusted network. |
| `PIDISPLAY_DATA` | `./data` | Where layout and widget data are stored |

## API

| Method | Path | Body / notes |
| --- | --- | --- |
| GET / PUT / DELETE | `/api/layout` | The whole dashboard layout. DELETE resets to `server/default-layout.json`. |
| GET / PUT | `/api/store/:key` | Arbitrary JSON per key; used by widgets through `ctx.storage`. |
| GET | `/api/notifications` | Newest first, last 100 kept. |
| POST | `/api/notifications` | `{ "title": "...", "body": "...", "source": "Farewatcher", "level": "info" \| "success" \| "warning" \| "alert" }` |
| DELETE | `/api/notifications[/:id]` | Dismiss one, or all. |
| GET | `/api/weather?location=Austin, TX&units=imperial` | Forecast from Open-Meteo (no API key) for a city or `lat,lon`; `units` is `imperial` or `metric`. Cached 10 minutes. Used by the weather widget. |
| GET | `/api/news?sections=world,us,state,local&location=Sacramento, CA` | Headlines from Google News RSS (no API key): the World and U.S. top stories, the state (from a US "City, ST" location) and local news for the city (falls back to a 3-day search when a town's local feed is empty). Each story has `title`, `source`, `time` and `related` coverage from other outlets. Cached 10 minutes; a failing feed keeps its last copy (`stale`) or reports `error` without hiding the others. Used by the news widget. |
| GET | `/api/system` | Pi health for the System widget: CPU, memory, disk, temperature, clock, throttle/undervoltage flags, network. Unavailable readings are `null`. |
| GET | `/api/fares` | Farewatcher summary (`$PIDISPLAY_DATA/farewatcher.json`, written by `fare_watch.py` after each run), or `{ "available": false }`. Used by the Fares widget. |
| GET | `/api/photos?source=all\|local\|google\|<album>` | Photo gallery list: uploaded photos in `$PIDISPLAY_DATA/photos/<album>/` and Google Photos shared albums linked in `$PIDISPLAY_DATA/photos.json` (links never returned). Each photo has `album`, `src` (screen size) and `thumb`; `albums` carries counts and per-album `error`. Setup in [docs/PHOTOS.md](docs/PHOTOS.md). |
| GET | `/api/photos/image?path=<album/file>&size=full\|thumb` | An uploaded photo shrunk to 1920x1080 (or a 400px square thumbnail) by ImageMagick and cached in `$PIDISPLAY_DATA/photos-cache/`; the original if ImageMagick is missing. |
| GET | `/api/calendar?from=<ms>&to=<ms>&tz=America/Los_Angeles` | Events from the iCal feeds in `$PIDISPLAY_DATA/calendars.json` (secret, never returned), recurring events expanded, at most 62 days per call. Feeds cached 5 minutes. Used by the calendar widget; setup in [docs/CALENDAR.md](docs/CALENDAR.md). |
| GET | `/api/stocks` | Stocks widget state: watchlist, latest quotes (with a 30-day sparkline), alerts, settings, data source and credits used. The Pi polls prices itself (Twelve Data with a key in `$PIDISPLAY_DATA/stocks-key.json`, else Yahoo Finance) and fires alerts as bell notifications plus a `stocks-alert` event that plays the sound. Setup in [docs/STOCKS.md](docs/STOCKS.md). |
| PUT | `/api/stocks/symbols` · `/api/stocks/settings` | `{ "symbols": ["AAPL", ...] }` · `{ "refreshMinutes", "sound", "volume", "repeats" }`. POST `/api/stocks/refresh` fetches prices now; POST `/api/stocks/test` fires a test alert. |
| POST / PUT / DELETE | `/api/stocks/alerts[/:id]` | `{ "symbol", "kind": "above" \| "below" \| "up" \| "down", "value" (price, or percent for up/down), "repeat": "once" \| "daily", "note", "enabled" }` |
| GET | `/api/stocks/history?symbol=AAPL&range=1d` | Chart points `[[ms, close], ...]` for `1d`, `5d`, `1m`, `6m`, `1y`, `5y`, plus the previous close. Daily closes are saved in `$PIDISPLAY_DATA/stocks-history.json` and extended from live quotes, so only gaps are refetched. |
| POST | `/api/kiosk/exit` | "Exit to desktop" from the gear menu: drops `$XDG_RUNTIME_DIR/pidisplay-desktop` (which `deploy/kiosk.sh` waits on) and closes the kiosk Chromium. The PiDisplay desktop/menu launcher (`deploy/open-dashboard.sh`) or a reboot brings it back. 501 off the Pi. |
| GET | `/api/wifi[?rescan]` | Wi-Fi adapter state, current network and IP, nearby networks, saved networks (nmcli). |
| POST | `/api/wifi/connect` · `disconnect` · `forget` · `power` | `{ "ssid", "password"? }` · `{}` · `{ "uuid" }` · `{ "on" }`. A failed join removes the new profile and rejoins the previous network. |
| GET | `/api/bluetooth` | Controller power and known devices (bluetoothctl). |
| POST | `/api/bluetooth/power` · `scan` · `pair` · `connect` · `disconnect` · `forget` | `{ "on" }` · `{}` (8 s discovery) · `{ "mac" }`. |
| GET | `/api/timers` | Timers, alarms and sound settings, plus the Pi's clock (`now`). State is in `$PIDISPLAY_DATA/timers.json`; the server decides when things ring, so they ring on every screen, on any page, after reloads and reboots. Anything overdue by more than 10 minutes (the Pi was off) is reported in the bell as missed instead of ringing. |
| POST | `/api/timers` · `/api/timers/:id/pause` · `resume` · `add` · `restart` · `snooze` · `dismiss` | `{ "durationMs", "label"? }` to start one · `{}` · `{}` · `{ "ms" }` · `{}` · `{}` · `{}`. DELETE `/api/timers/:id` cancels. |
| PUT | `/api/timers/settings` | `{ "snoozeMinutes", "sound", "volume" (0-100), "ringMinutes" (stop ringing after), "fadeIn" }` |
| POST / PUT / DELETE | `/api/alarms[/:id]` | `{ "hour", "minute", "days": [0-6, 0 = Sunday; empty = once], "label", "sound", "enabled" }`, in the Pi's time zone. POST `/api/alarms/:id/snooze` · `dismiss`. |
| GET | `/api/spotify` | Spotify widget status: Client ID saved, signed in, and whether the PiDisplay receiver (librespot) has been linked. Setup in [docs/SPOTIFY.md](docs/SPOTIFY.md). |
| GET | `/api/spotify/login[?return=/path]` · `/api/spotify/callback` | Spotify sign-in (OAuth with PKCE). Redirect URI is `http://127.0.0.1:8080/api/spotify/callback`; tokens stay in `$PIDISPLAY_DATA/spotify.json`. |
| PUT / POST | `/api/spotify/client` | `{ "clientId" }` (or `?clientId=`) saves the Spotify app's Client ID; empty clears it. POST `/api/spotify/logout` signs out. |
| GET | `/api/spotify/player` · `playlists` · `search?q=` | Now playing plus Spotify Connect devices · your playlists · songs, artists, albums and playlists (10 each). |
| POST | `/api/spotify/player/play` · `pause` · `next` · `previous` · `seek` · `volume` · `shuffle` · `repeat` · `transfer` | `{ "contextUri"?, "offsetUri"?, "uris"?, "deviceId"? }` (no device: the active one, else PiDisplay) · `{}` · `{}` · `{}` · `{ "positionMs" }` · `{ "percent" }` · `{ "on" }` · `{ "mode": "off" \| "context" \| "track" }` · `{ "deviceId", "play"? }`. |
| GET | `/api/audio` | The Pi's sound outputs (PipeWire via `pactl`): display speakers over HDMI, headphone jack, connected Bluetooth speakers, with the default marked. |
| POST | `/api/audio/select` · `volume` | `{ "name" }` makes it the default and moves anything playing to it · `{ "name", "volume" }` (0-100). |
| GET | `/api/events` | SSE stream: `notification`, `notifications-cleared`, `layout`, `store`, `timers`, `spotify`. |

Example, from the Pi itself:

```bash
curl -X POST localhost:8080/api/notifications -H 'Content-Type: application/json' \
  -d '{"title":"Fare drop: NYC to LAX","body":"$148 round trip","source":"Farewatcher","level":"success"}'
```

## Layout

```
server/            Node server, default layout, API tests
src/main.ts        Boots the app (retries until the server is up)
src/core/          Shell: types (widget contract), app (pages, grid, edit mode),
                   registry (widget discovery), api, notifications, sheet (modals/forms)
src/widgets/<id>/  One folder per widget
docs/WIDGETS.md    How to write a widget
```

The gear (⚙) in the top bar holds app-wide settings: light or dark appearance (saved in the `app.settings` store key, dark by default), Wi-Fi and Bluetooth, and Exit to desktop. Because the server runs outside the desktop session, `deploy/update.sh` installs `deploy/pidisplay-network.rules` (polkit: dan may scan and manage Wi-Fi) and `deploy/pidisplay-sudoers` (only `rfkill unblock bluetooth`).

Deploying to the Pi (kiosk autostart, screen blanking, touch setup, update script) is a separate step.
