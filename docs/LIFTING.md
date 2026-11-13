# Lifting tracker

A weightlifting log for the wall display: SQLite (WAL mode) behind a small Python
FastAPI service (`lifting/`), with a touch dashboard the **Lifting** tile opens full
screen. Lifting only; runs and rides belong to the Strava widget.

## People

Several people can use it. Each has their own sessions, PRs, volume, measurements and
dunk goal; the exercise list (with muscle groups) is shared. Switch with 👤 at the top
right of every page; add, rename or delete people on **Log › People** (deleting someone
deletes all of their data). The first person is named by `LIFTING_DEFAULT_PERSON` in the
unit (Dan). A Lifting tile shows the first person unless its ⚙ **Person** setting names
someone, so two tiles can follow two people; tapping a tile opens the tracker on that person.

## Pieces

| What | Where |
| --- | --- |
| Service | `pidisplay-lifting.service`, port 8090, venv in `~/.local/share/pidisplay-lifting/venv` |
| Database | `~/pidisplay-data/lifting.db` (redeploys never touch it) |
| Backups | `pidisplay-lifting-backup.timer`, nightly at 03:15 → `~/pidisplay-data/lifting-backups/lifting-YYYY-MM-DD.db`, newest 60 kept |
| On the display | PiDisplay proxies `http://127.0.0.1:8080/lifting/` to the service; the tile opens it in a full-screen frame (with the on-screen keyboard) and holds page rotation while open |
| From a phone | `http://piboy.local:8090/` (same pages). There is no login, so anyone on the home Wi-Fi can edit; set `--host 127.0.0.1` in the unit to close that |

`deploy/update.sh` installs everything (python3-venv, packages, units) on every deploy;
packages are only reinstalled when `lifting/requirements.txt` changes.

## The tile

Built around the training rather than the last session: sets this week (with last week),
overall strength change (average e1RM change since each lift's first session), PRs in the
last 30 days, sets per week, sets per muscle group over the last 7 days against a target
(⚙ setting, default 10), progress per lift with a 4-week projection, and what needs work
(stalled or declining lifts, muscle groups under target, push/pull imbalance over 4 weeks,
groups not trained for 8+ days). Smaller sizes show less. Tap a section to open the
tracker there; a lift opens its trend.

Projections need 3 sessions of the lift over at least 2 weeks; they follow the trend line
but assume at most 2% e1RM gain per week, since early sessions jump a lot.

## Pages

- **Trends**: per lift, estimated 1RM and top-set weight over time. Lifts are grouped by name; pick a variation for a like-for-like line, or "All variations".
- **Volume**: working sets per muscle group for each week (Monday start), with last week as a tick.
- **PRs**: recent PRs; tap one to open that lift's trend.
- **Month**: a calendar month next to the one before: sessions, working sets, weight moved (weight × reps), PRs, average effort, sets per muscle group, training-day calendar.
- **Dunk goal**: standing and approach touch height against the rim (120 in) and rim + 6 in, box jump height (from measurements and logged box-jump sets), bodyweight, and a form to add a measurement.
- **Log**: every set, filterable by date range and exercise, with inline edit and delete. Tabs for sessions (date, day, notes; deleting one deletes its sets), exercises (muscle group, the muscles it also works, equipment; Merge folds a duplicate into another exercise and keeps every set) and measurements.
- **Import**: paste JSON (or pick a file) and import it.

## Import format

`POST /import` (or the Import page) takes the `lifting_backfill.json` format, plus an
optional top-level `"person": "Name"` (a new name adds that person; without it the import
goes to `?person=` / the person picked on the page, else the first person): `sessions[]`
with `date`, `day` (A/B/C/D), `notes` and nested `sets[]`, plus `measurements[]`. The
Import page shows a full example. Re-importing is safe:

- sessions are matched by person + date + day label (notes are updated),
- sets by session + exercise + variation + set number + segment (changed fields are updated),
- measurements by person + date + type.

The whole import is one transaction: one bad row rejects the lot and the page lists every
problem. Muscle group and equipment are guessed from the exercise name unless a set
carries `muscle_group` / `equipment`; fix guesses on Log › Exercises.

Optional on any set, for whatever writes the JSON (unknown keys are ignored, so older exports keep working):

- `"rpe": 8` (1 to 10) or `"rir": 2` (reps left in reserve; `reps_in_reserve` works too). Leave both out when effort wasn't noted.
- `"secondary_muscles": ["Biceps", "Rear delts"]` to say which other muscle groups the exercise works. Without it they are guessed from the name.

From the laptop: `.\deploy\lifting.ps1 -Import C:\path\lifting_backfill.json` (add `-Person Alex` for someone else).

Every API endpoint takes `?person=` (id or name); without it, it is the first person.

## How the numbers work

Warmups never count.

- **e1RM** (Epley) = weight × (1 + reps / 30), only for 1 to 12 reps with a weight. For a mechanical drop set only segment 1 counts. The trend shows the best per session.
- **Effort**: when a set has reps in reserve (`rir`, or 10 − `rpe`), the estimate uses reps + reps left, since 8 reps with 2 left is a 10-rep weight. Sets with no effort logged are treated as taken to failure.
- **Rough estimates (≈)**: an e1RM from more than 10 effective reps is marked ≈; the formulas drift up there. Above 12 there is no estimate.
- **Top-set weight**: the heaviest set of the lift in the session.
- **PR**: the session's best e1RM beats every earlier session, or a set beats the heaviest weight earlier lifted for at least as many reps (for the most reps ever, it must at least match the heaviest weight ever). A lift's first session only sets the baseline.
- **Stall**: no e1RM gain in the last 3 sessions (needs at least 4 sessions with an e1RM).
- **Volume**: segments of one mechanical drop set count as one set. The exercise's own muscle group gets a full set and each muscle it also works gets half a set (a row is 1 for back, 0.5 for biceps). Week totals count each set once.

Weights are stored in lb as logged; `load_basis` says whether that is the total, each
hand, each arm or each side, and comparisons are within one exercise + variation (or name).

## Maintenance

```
sudo systemctl status pidisplay-lifting      journalctl -u pidisplay-lifting
systemctl list-timers pidisplay-lifting-backup.timer
.\deploy\lifting.ps1 -Backup     # back up now          -Fetch   # copy the newest backup to the laptop
```

Restore: stop the service, copy a backup over `~/pidisplay-data/lifting.db` (delete any
`lifting.db-wal` / `-shm` next to it), start the service.

API docs (every endpoint) are at `http://piboy.local:8090/api/docs`.

## Development

```
python3 -m venv .venv && .venv/bin/pip install -r lifting/requirements-dev.txt
.venv/bin/python -m pytest lifting/tests
LIFTING_DB=/tmp/lifting.db .venv/bin/uvicorn --factory lifting.app:create_app --port 8090
```

`npm run dev` forwards `/lifting` to port 8090 as well.

Later: Tailscale for access away from home.
