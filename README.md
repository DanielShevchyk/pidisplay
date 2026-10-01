# PiDisplay

A customizable touch dashboard for a wall-mounted Raspberry Pi 4 with a 15.6" 1080p touchscreen.

- **Top bar** that never moves: clock (or any bar-capable widget), page name and dots, notifications bell, edit button.
- **Pages** of tiles that rotate on a timer, or swipe left/right. Touching pauses rotation for a while.
- **Tiles** in six sizes on a 6×4 grid (configurable): Small 1×1, Wide 2×1, Tall 1×2, Large 2×2, Extra large 3×2, Full page.
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
| GET | `/api/events` | SSE stream: `notification`, `notifications-cleared`, `layout`, `store`. |

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

Deploying to the Pi (kiosk autostart, screen blanking, touch setup, update script) is a separate step.
