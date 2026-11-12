# Lifting tracker

A weightlifting log for the wall display: SQLite (WAL mode) behind a small Python
FastAPI service (`lifting/`), with a touch dashboard the **Lifting** tile opens full
screen. Lifting only; runs and rides belong to the Strava widget.

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

## Pages

- **Trends**: per lift, estimated 1RM and top-set weight over time. Lifts are grouped by name; pick a variation for a like-for-like line, or "All variations".
- **Volume**: working sets per muscle group for each week (Monday start), with last week as a tick.
- **PRs**: recent PRs; tap one to open that lift's trend.
- **Dunk goal**: standing and approach touch height against the rim (120 in) and rim + 6 in, box jump height (from measurements and logged box-jump sets), bodyweight, and a form to add a measurement.
- **Log**: every set, filterable by date range and exercise, with inline edit and delete. Tabs for sessions (date, day, notes; deleting one deletes its sets), exercises (muscle group and equipment, which drive the volume chart) and measurements.
- **Import**: paste JSON (or pick a file) and import it.

## Import format

`POST /import` (or the Import page) takes the `lifting_backfill.json` format: `sessions[]`
with `date`, `day` (A/B/C/D), `notes` and nested `sets[]`, plus `measurements[]`. The
Import page shows a full example. Re-importing is safe:

- sessions are matched by date + day label (notes are updated),
- sets by session + exercise + variation + set number + segment (changed fields are updated),
- measurements by date + type.

The whole import is one transaction: one bad row rejects the lot and the page lists every
problem. Muscle group and equipment are guessed from the exercise name unless a set
carries `muscle_group` / `equipment`; fix guesses on Log › Exercises.

From the laptop: `.\deploy\lifting.ps1 -Import C:\path\lifting_backfill.json`.

## How the numbers work

Warmups never count.

- **e1RM** (Epley) = weight × (1 + reps / 30), only for 1 to 12 reps with a weight. For a mechanical drop set only segment 1 counts. The trend shows the best per session.
- **Top-set weight**: the heaviest set of the lift in the session.
- **PR**: the session's best e1RM beats every earlier session, or a set beats the heaviest weight earlier lifted for at least as many reps (for the most reps ever, it must at least match the heaviest weight ever). A lift's first session only sets the baseline.
- **Stall**: no e1RM gain in the last 3 sessions (needs at least 4 sessions with an e1RM).
- **Volume**: segments of one mechanical drop set count as one set.

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
