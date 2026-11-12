# Strava

The Strava widget shows your own Strava activities. The Pi keeps a copy of your whole activity list and talks
to Strava itself; the screen never sees your secret or tokens.

## What it shows

| Size | Shows |
| --- | --- |
| Top bar | This week's distance (or time, or climbing) |
| Small | This week's total, or a ring filling toward your weekly goal |
| Wide | This week, change against last week by the same day, and a bar per day |
| Tall | This week, the day bars and the latest activity |
| Large | The latest activity's route map and numbers, plus this week |
| Extra large / Full page | All of that, plus this month and year, the last 12–16 weeks, recent activities and a 26-week calendar |

Tap a tile for the dashboard sheet:

* **Overview**: week, month, year (with "vs this point last year") and all-time totals; weekly bars (16 weeks or a year,
  with the goal line); this year's running total against last year's; the last 12 months. Tap a bar or drag across a
  line to read its numbers.
* **Activities**: every activity, newest first. Tap one for its route, pace or speed, heart rate, power, description,
  gear, elevation / heart rate / pace charts, splits, laps, best efforts (with PR medals) and segment PRs.
* **Calendar**: the past year as a heatmap, plus when in the day and which weekdays you usually go.
* **Heatmap**: every route you've recorded on one map, around home or everywhere.
* **Records**: longest, longest time, most climbing, fastest average pace or speed, biggest week and month, streaks.

The sport chips (Runs, Rides, Walks & hikes, Swims) and Distance / Time / Elevation switch everything at once. The
tile's ⚙ sets its sport, what it counts, a weekly goal, units, and whether weeks start on Monday or Sunday.

## Setup (once)

You need your Strava API app's **Client ID** and **Client Secret** from
<https://www.strava.com/settings/api>. The "Your Access Token" shown on that page only has `read` permission, which
can't see activities, so the display signs in once itself to get `activity:read_all` (which also covers private
activities).

From the laptop, in the pidisplay folder, after deploying:

```powershell
.\deploy\strava.ps1 -ClientId 12345
```

It asks for the Client Secret, saves both on the Pi, opens a tunnel to the Pi and the Strava sign-in page in your
browser. Tap **Authorize** with "View data about your activities" ticked. The Pi then downloads your history (200
activities per request) and shows it within a minute or two.

If Strava says the redirect URI is invalid, set **Authorization Callback Domain** on
<https://www.strava.com/settings/api> to `127.0.0.1`.

Other commands:

```powershell
.\deploy\strava.ps1              # status, and sign in again if needed
.\deploy\strava.ps1 -Reconnect   # sign in again anyway
.\deploy\strava.ps1 -Logout      # disconnect (also revokes the app on Strava)
```

A tile that isn't connected also has **Connect on this screen**, which runs the same sign-in in the kiosk browser.

## Rate limits and caching

Strava allows this app 100 reads every 15 minutes and 1,000 a day (200 / 2,000 overall). The Pi:

* reads the limits and current use from Strava's response headers, and keeps background syncs under **half** of both;
  opening an activity may use up to 85%. After a 429 it waits for the next 15-minute window (or UTC midnight).
* syncs every **15 minutes** with one request (the last 7 days, which also picks up renamed and deleted activities),
  once a day looks back 45 days for late uploads, and refreshes the athlete profile once a day. That's about 100
  requests a day.
* downloads older history 8 pages per run, every 2 minutes, until it reaches your first activity.
* fetches an activity's details and streams (2 requests) only when you open it, and keeps the last 150 opened.
* refreshes the 6-hour access token by itself and saves the new refresh token.

"Sync now" in the sheet works at most once a minute. The sheet's footer shows requests used.

## Files on the Pi

| File | Holds |
| --- | --- |
| `~/pidisplay-data/strava.json` | Client ID, secret, tokens, granted scope (mode 600) |
| `~/pidisplay-data/strava-data.json` | Athlete profile and every activity summary |
| `~/pidisplay-data/strava-details.json` | Details and streams of opened activities |

Deleting `strava-data.json` and `strava-details.json` makes the Pi download everything again.

New activities also post a bell notification ("New run: Morning Run · 5.0 mi · 42 min").

Map tiles © OpenStreetMap contributors © CARTO. Data from Strava.
