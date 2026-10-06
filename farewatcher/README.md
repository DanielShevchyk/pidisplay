# Farewatcher

Daily cheap-fare watcher for the Bay Area / Sacramento airports. It feeds the PiDisplay **Fares** widget and pushes deals to your phone.

Each run (stdlib-only Python 3, `fare_watch.py`):

1. Pulls cached fares from the Travelpayouts API for every origin × destination over the next `months_ahead` months and stores them in SQLite (`fares.db`).
2. Flags a deal when a fare is under the destination's target (plus `origin_allowance` for SMF) or well below its 30-day median.
3. Confirms the best deals against live Google Flights prices (SerpApi, free plan budgeted per run). A deal a live check disproved in the last 14 days is held, not sent as unverified.
4. Adds typical trip weather (Open-Meteo) and a price chart (QuickChart), then alerts via ntfy, optional email, and the PiDisplay notification bell.
5. Writes `farewatcher.json` for the widget (`--export-summary` rewrites it from the database alone).

Fixed-date trips (`events` in the config, e.g. Oktoberfest) are checked directly on Google Flights on their own schedule.

Open jaws (`open_jaw` in the config): fly out of SFO/SMF into one city and home from a nearby one (e.g. into Frankfurt, home from Paris). Return cities are the other watched destinations within `max_km` (today London, Paris, Amsterdam, Munich and Frankfurt) plus `extra_return_from`. Each run fetches one-way fares for those legs from Travelpayouts (about 20 extra calls, saved in `oneway_fares`, apart from the round-trip tables) and pairs them within `nights`. An open jaw becomes a deal when the total is under the arrival city's target (plus the SMF allowance) and at least `min_saving` below the round trip; the best one is confirmed as a Google Flights multi-city ticket (one SerpApi search, held back from the round-trip budget; results in `openjaw_checks`). The summary exports `openJaw` on destinations, `byOrigin` entries and deals.

## On the Pi

| What | Where |
| --- | --- |
| Code, config, database, log | `/home/dan/fare_watch/` (`fare_watch.py`, `config.json`, `fares.db`, `fare_watch.log`) |
| Nightly database backups (14 kept) | `/home/dan/fare_watch/backups/fares-YYYY-MM-DD.db` |
| Widget summary | `/home/dan/pidisplay-data/farewatcher.json` |
| Secrets and settings | `/etc/fare_watch.env` (root-only, `0600`) |
| systemd units | `/etc/systemd/system/fare_watch*.{service,timer}` |

Timers: `fare_watch.timer` runs the check daily at 08:00, and `fare_watch-backup.timer` backs up the database at 03:30. Both are `Persistent`, so a run missed while the Pi was off happens at boot. If either job fails, `fare_watch-alert@.service` pushes "Farewatcher run FAILED" to the ntfy topic from `config.json`. A run also warns if the last successful run was more than 36 hours ago.

Environment variables (`/etc/fare_watch.env`): `TRAVELPAYOUTS_TOKEN`, `SERPAPI_KEY`, optional `FARE_WATCH_SMTP_PASSWORD`, `PIDISPLAY_URL` (`http://127.0.0.1:8080`), `FARE_WATCH_SUMMARY` (the widget JSON path).

`config.json` is not in git; `config.example.json` has the same structure with placeholders. Use a long random ntfy topic, because anyone who knows it can read the alerts.

## Updating

Edit `fare_watch.py` here, commit, then copy it to the Pi:

```bash
scp farewatcher/fare_watch.py dan@piboy:/home/dan/fare_watch/
ssh dan@piboy "python3 -m py_compile /home/dan/fare_watch/fare_watch.py"
```

Unit file changes go to `/etc/systemd/system/` followed by `sudo systemctl daemon-reload`.

Useful commands on the Pi:

```bash
systemctl list-timers 'fare_watch*'
journalctl -u fare_watch -n 50
cd ~/fare_watch && python3 fare_watch.py --dry-run      # fetch + print, writes nothing
python3 fare_watch.py --list-sent                        # recent alerts; --resend ID to re-push
```
