# Calendar setup

The calendar widget shows any number of Google calendars (or any other iCal feed: iCloud, Outlook, a sports
schedule), each in its own color. Every person in the house can have their own calendar on the display, and
tapping a name on the widget hides or shows that person's events.

It is read-only: it uses each calendar's private iCal link, so nothing needs signing in on the Pi.

## 1. Copy a calendar's secret address (on a computer, not the phone app)

1. Open [calendar.google.com](https://calendar.google.com) signed in as the calendar's owner.
2. Click the gear (top right), then **Settings**.
3. On the left under **Settings for my calendars**, click the calendar.
4. Scroll to **Integrate calendar** and copy **Secret address in iCal format** (ends in `basic.ics`).

Repeat for every calendar you want: your own, a shared "Family" calendar you own, and so on. For someone
else's account, they do these steps signed in as themselves and send you the link privately. Treat these links
like passwords: anyone with one can read that calendar. If one leaks, **Reset** next to it in Google makes a new
one. Work or school (Google Workspace) accounts may have the secret address turned off by their admin.

## 2. Add it to the Pi

From the laptop, in the pidisplay folder:

```powershell
.\deploy\calendars.ps1 -Add Dan -Url "https://calendar.google.com/calendar/ical/.../basic.ics"
.\deploy\calendars.ps1 -Add Family -Color "#ffb443" -Url "https://..."
.\deploy\calendars.ps1                 # list them and check each feed
.\deploy\calendars.ps1 -Remove Family
```

Colors are optional (a palette is used otherwise). The links are stored only on the Pi in
`~/pidisplay-data/calendars.json` (mode 600), never in git, and are never sent to the browser. You can also edit
that file directly over SSH; it looks like this, and changes apply on the next refresh without a restart:

```json
{
  "calendars": [
    { "name": "Dan", "color": "#4da3ff", "url": "https://calendar.google.com/calendar/ical/.../basic.ics" },
    { "name": "Family", "color": "#ffb443", "url": "https://..." }
  ]
}
```

## How it behaves

- **Views fit the tile**: small shows today's date and what's next, wide/tall/large show an agenda, extra large a
  week, full page a month. Pick a fixed view in the tile's ⚙ settings instead if you prefer.
- **Per-tile filter**: ⚙ → "Only these calendars" (e.g. `Dan`) makes a tile for one person.
- **Touch**: tap a name to hide/show it, an event for details, a day (week/month) for its full list, ‹ › to move
  between weeks or months; it snaps back to today after two minutes.
- **Top bar**: shows the next event in the coming 12 hours.
- **Refresh**: the Pi fetches each feed at most every 5 minutes. Google itself only updates the secret address
  every few hours, so a new or edited event can take a while to appear. If a feed fails, the last good copy stays
  on screen and a ⚠ appears next to that calendar's name.

## Later: two-way sync

Adding and editing events from the touchscreen, and seeing changes instantly, needs Google sign-in (OAuth) per
account instead of secret links. The widget is built so that can be added as another server-side source.
