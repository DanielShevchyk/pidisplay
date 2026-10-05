#!/usr/bin/env python3
"""
fare_watch.py - daily cheap-fare watcher for NorCal -> remote-work hubs.

Pulls the cheapest cached fare per (origin, destination, departure month)
from the Travelpayouts / Aviasales Data API (free token), stores every
observation in SQLite, and pushes an alert when a fare is:
  * at or below your fixed threshold for that destination, OR
  * X% below the rolling median of recent daily lows for that route/month.

Stdlib only (Python 3.8+). Run once a day from cron / Task Scheduler.

Usage:
  python fare_watch.py --dry-run        # fetch + print, writes NOTHING
  python fare_watch.py --test-notify    # send a test push/email and exit
  python fare_watch.py --export-summary # rewrite the PiDisplay summary JSON from fares.db only
  python fare_watch.py                  # normal daily run

PiDisplay (optional, env): PIDISPLAY_URL also shows alerts on the display;
FARE_WATCH_SUMMARY is where the widget's summary JSON is written after every run.
"""
import argparse
import base64
import gzip
import json
import os
import re
import smtplib
import sqlite3
import ssl
import statistics
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from email.message import EmailMessage

API_URL = "https://api.travelpayouts.com/aviasales/v3/prices_for_dates"
HERE = os.path.dirname(os.path.abspath(__file__))


# ----------------------------------------------------------------- config
def load_config(path, need_token=True):
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    cfg["travelpayouts_token"] = (os.environ.get("TRAVELPAYOUTS_TOKEN", "").strip()
                                  or cfg.get("travelpayouts_token", ""))
    if need_token and not cfg["travelpayouts_token"]:
        sys.exit("No API token: set TRAVELPAYOUTS_TOKEN or travelpayouts_token in config.")
    return cfg


LOG_FILE = None   # set by --log; log() then writes to the console AND appends to this file


def log(msg):
    line = "[%s] %s" % (datetime.now().strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    if LOG_FILE:
        with open(LOG_FILE, "a", encoding="utf-8") as f:
            f.write(line + "\n")


# ----------------------------------------------------------------- dates
def shift_month(ym, k):
    y, m = int(ym[:4]), int(ym[5:7])
    idx = y * 12 + (m - 1) + k
    return "%04d-%02d" % (idx // 12, idx % 12 + 1)


def month_list(n, today=None):
    today = today or date.today()
    start = "%04d-%02d" % (today.year, today.month)
    return [shift_month(start, i) for i in range(n)]


# ----------------------------------------------------------------- API usage
API_CALLS = {}        # service label -> requests made this run (retries included)
RUN_STATS = {}        # fares_fetched / deals_found for this run, saved to the runs table
SERPAPI_ACCOUNT = {}  # latest SerpApi account.json (quota), if checked


def count_call(url):
    parts = urllib.parse.urlsplit(url)
    host = parts.netloc
    if "travelpayouts" in host:
        label = "Travelpayouts"
    elif "serpapi" in host:
        label = "SerpApi quota check" if "account" in parts.path else "SerpApi searches"
    elif "open-meteo" in host:
        label = "Open-Meteo"
    elif "ntfy" in host:
        label = "ntfy"
    else:
        label = host
    API_CALLS[label] = API_CALLS.get(label, 0) + 1


def usage_summary(started):
    """End-of-run block: requests per service, SerpApi quota, run time."""
    used = API_CALLS.get("SerpApi searches", 0)
    key = os.environ.get("SERPAPI_KEY", "").strip()
    if key:                                   # free call; gives an up-to-date quota
        serpapi_searches_left(key)
    acct = SERPAPI_ACCOUNT
    rows = [("Travelpayouts", "%d calls" % API_CALLS.get("Travelpayouts", 0), "no monthly cap")]
    quota = ""
    if acct.get("total_searches_left") is not None:
        quota = "%d of %d left this month" % (acct["total_searches_left"], acct.get("searches_per_month") or 0)
    rows.append(("SerpApi", "%d search%s" % (used, "" if used == 1 else "es"), quota or "quota unknown"))
    rows.append(("Open-Meteo", "%d calls" % API_CALLS.get("Open-Meteo", 0), "weather, free"))
    rows.append(("ntfy", "%d message%s" % (API_CALLS.get("ntfy", 0), "" if API_CALLS.get("ntfy", 0) == 1 else "s"),
                 "notifications"))
    for label, n in sorted(API_CALLS.items()):
        if label not in ("Travelpayouts", "SerpApi searches", "SerpApi quota check", "Open-Meteo", "ntfy"):
            rows.append((label, "%d calls" % n, ""))
    log("---- API usage this run " + "-" * 20)
    for name, count, note in rows:
        log("  %-14s %-13s %s" % (name, count, note))
    log("  %-14s %ds" % ("Run time", round(time.time() - started)))


# ----------------------------------------------------------------- API
def http_get_json(url, params, headers, timeout=30, retries=3):
    full = url + "?" + urllib.parse.urlencode(params)
    last_err = None
    for attempt in range(retries):
        count_call(full)
        try:
            req = urllib.request.Request(full, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                raw = r.read()
                if r.headers.get("Content-Encoding") == "gzip":
                    raw = gzip.decompress(raw)
                return json.loads(raw.decode("utf-8"))
        except urllib.error.HTTPError as e:
            last_err = e
            if e.code == 429 or e.code >= 500:      # rate-limited / server error
                if attempt < retries - 1:
                    time.sleep(5 * 2 ** attempt)
                continue
            raise
        except urllib.error.URLError as e:
            last_err = e
            if attempt < retries - 1:
                time.sleep(5 * 2 ** attempt)
    raise RuntimeError("request failed after %d tries: %s" % (retries, last_err))


def per_month_queries(cfg):
    """A fixed return month (return_offset_months) needs one query per departure month;
    otherwise a single query per route returns every month at once (verified identical)."""
    trip = cfg.get("trip", {})
    return not trip.get("one_way", False) and trip.get("return_offset_months") is not None


def fetch_fares(cfg, origin, dest, month=None):
    """Return every cached fare (list of dicts, cheapest first) for this route,
    limited to one departure month if `month` is given."""
    trip = cfg.get("trip", {})
    one_way = bool(trip.get("one_way", False))
    params = {
        "origin": origin,
        "destination": dest,
        "currency": cfg.get("currency", "usd"),
        "sorting": "price",
        "direct": "false",
        "unique": "false",
        "one_way": "true" if one_way else "false",
        "limit": int(cfg.get("fetch_limit", 1000)),     # 1000 is the API maximum
        "page": 1,
    }
    if month:
        params["departure_at"] = month
    offset = trip.get("return_offset_months")
    if month and not one_way and offset is not None:
        params["return_at"] = shift_month(month, int(offset))
    headers = {
        "X-Access-Token": cfg["travelpayouts_token"],
        "Accept-Encoding": "gzip",      # only gzip is decoded in http_get_json
    }
    data = http_get_json(API_URL, params, headers)
    if not data.get("success"):
        raise RuntimeError(data.get("error") or "API returned success=false")
    return sorted((r for r in (data.get("data") or []) if r.get("price")), key=lambda r: r["price"])


# ----------------------------------------------------------------- storage
SCHEMA = """
CREATE TABLE IF NOT EXISTS observations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at  TEXT NOT NULL,          -- UTC ISO timestamp
    origin      TEXT NOT NULL,
    dest        TEXT NOT NULL,
    month       TEXT NOT NULL,          -- departure month YYYY-MM
    price       REAL NOT NULL,
    currency    TEXT,
    depart_at   TEXT,
    return_at   TEXT,
    airline     TEXT,
    transfers   INTEGER,
    link        TEXT
);
CREATE INDEX IF NOT EXISTS ix_obs_route ON observations(dest, month, checked_at);
-- Every fare returned by every lookup (observations keeps only the cheapest per
-- origin/dest/month per run, which is what alerting uses). For trend analysis.
CREATE TABLE IF NOT EXISTS fares (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at       TEXT NOT NULL,     -- UTC ISO timestamp of the run
    origin           TEXT NOT NULL,     -- airport queried
    dest             TEXT NOT NULL,     -- city code queried
    month            TEXT NOT NULL,     -- departure month YYYY-MM
    price            REAL NOT NULL,
    currency         TEXT,
    depart_at        TEXT,
    return_at        TEXT,
    trip_days        INTEGER,
    origin_airport   TEXT,
    dest_airport     TEXT,
    airline          TEXT,
    flight_number    TEXT,
    transfers        INTEGER,
    return_transfers INTEGER,
    duration_to      INTEGER,           -- minutes
    duration_back    INTEGER,           -- minutes
    gate             TEXT,              -- agency that quoted the fare
    checked_bags     INTEGER,           -- included checked bags (0 = none, NULL = unknown)
    bag_kg           INTEGER,           -- total checked allowance in kg (0/NULL = unknown)
    raw              TEXT              -- full API row as JSON, minus the long booking link
);
CREATE INDEX IF NOT EXISTS ix_fares_route ON fares(dest, month, checked_at);
CREATE INDEX IF NOT EXISTS ix_fares_checked ON fares(checked_at);
-- Live Google Flights prices (SerpApi) looked up for deals, same dates as the cached fare.
CREATE TABLE IF NOT EXISTS live_checks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    checked_at    TEXT NOT NULL,
    origin        TEXT NOT NULL,
    dest          TEXT NOT NULL,
    depart_date   TEXT,
    return_date   TEXT,
    price         REAL,                 -- NULL when Google had no flights
    cached_price  REAL,                 -- the Travelpayouts price that triggered the check
    airline       TEXT,
    stops         INTEGER,
    duration      INTEGER,              -- outbound minutes
    price_level   TEXT,                 -- Google's low / typical / high
    typical_low   REAL,
    typical_high  REAL
);
CREATE INDEX IF NOT EXISTS ix_live_route ON live_checks(dest, depart_date, checked_at);
-- Full copy of every notification sent, so any alert can be re-sent later (--resend)
-- without calling the flight/weather APIs again.
CREATE TABLE IF NOT EXISTS sent_alerts (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    sent_at     TEXT NOT NULL,          -- UTC ISO timestamp of the run
    dest        TEXT,
    month       TEXT,
    origin      TEXT,
    price       REAL,                   -- headline price (live if verified, else cached)
    verified    INTEGER,
    title       TEXT NOT NULL,
    message     TEXT NOT NULL,          -- push text (links shown as buttons)
    email_body  TEXT,                   -- same alert with inline links
    click       TEXT,
    actions     TEXT,                   -- JSON [[label, url], ...]
    push        TEXT                    -- JSON {tags, priority, icon, attach, filename}
);
CREATE INDEX IF NOT EXISTS ix_sent_at ON sent_alerts(sent_at);
-- One row per normal run, for the PiDisplay summary's "last run" status.
CREATE TABLE IF NOT EXISTS runs (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at     TEXT NOT NULL,
    finished_at    TEXT,
    ok             INTEGER,
    error          TEXT,
    fares_fetched  INTEGER,
    deals_found    INTEGER,
    serpapi_used   INTEGER,             -- searches used this month (SerpApi account)
    serpapi_budget INTEGER              -- searches per month on the plan
);
CREATE TABLE IF NOT EXISTS alerts (
    dest        TEXT NOT NULL,
    month       TEXT NOT NULL,
    origin      TEXT NOT NULL,
    price       REAL NOT NULL,
    alerted_at  TEXT NOT NULL,
    verified    INTEGER,                -- 1 = live-confirmed price, 0 = cached only
    PRIMARY KEY (dest, month)
);
"""


def open_db(path, read_only=False):
    if read_only:
        # Dry runs must not create or modify fares.db; read existing history if any.
        if os.path.exists(path):
            conn = sqlite3.connect(path)
            conn.execute("PRAGMA query_only = ON")
            return conn
        path = ":memory:"
    conn = sqlite3.connect(path)
    conn.executescript(SCHEMA)
    # Columns added after a table first shipped; CREATE TABLE IF NOT EXISTS won't add them.
    for table, col, typ in (("fares", "checked_bags", "INTEGER"), ("fares", "bag_kg", "INTEGER"),
                            ("alerts", "verified", "INTEGER"), ("sent_alerts", "deal_json", "TEXT")):
        if col not in [r[1] for r in conn.execute("PRAGMA table_info(%s)" % table)]:
            conn.execute("ALTER TABLE %s ADD COLUMN %s %s" % (table, col, typ))
    return conn


def record_observation(conn, origin, dest, month, fare, currency, now_iso):
    conn.execute(
        "INSERT INTO observations (checked_at, origin, dest, month, price, currency,"
        " depart_at, return_at, airline, transfers, link) VALUES (?,?,?,?,?,?,?,?,?,?,?)",
        (now_iso, origin, dest, month, float(fare["price"]), currency,
         fare.get("departure_at"), fare.get("return_at"), fare.get("airline"),
         fare.get("transfers"), fare.get("link")))


def record_fares(conn, origin, dest, month, fares, currency, now_iso):
    rows = []
    for f in fares:
        dep, ret = (f.get("departure_at") or "")[:10], (f.get("return_at") or "")[:10]
        days = None
        if dep and ret:
            days = (date.fromisoformat(ret) - date.fromisoformat(dep)).days
        raw = {k: v for k, v in f.items() if k != "link"}
        bags = checked_bags(f) or (None, None)
        rows.append((now_iso, origin, dest, month, float(f["price"]), currency,
                     f.get("departure_at"), f.get("return_at"), days,
                     f.get("origin_airport"), f.get("destination_airport"),
                     f.get("airline"), f.get("flight_number"),
                     f.get("transfers"), f.get("return_transfers"),
                     f.get("duration_to"), f.get("duration_back"), f.get("gate"),
                     bags[0], bags[1], json.dumps(raw, separators=(",", ":"))))
    conn.executemany(
        "INSERT INTO fares (checked_at, origin, dest, month, price, currency, depart_at,"
        " return_at, trip_days, origin_airport, dest_airport, airline, flight_number,"
        " transfers, return_transfers, duration_to, duration_back, gate,"
        " checked_bags, bag_kg, raw)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)", rows)


def record_live(conn, origin, dest, lv, cached_price, now_iso):
    typ = lv.get("typical") or [None, None]
    conn.execute(
        "INSERT INTO live_checks (checked_at, origin, dest, depart_date, return_date, price,"
        " cached_price, airline, stops, duration, price_level, typical_low, typical_high)"
        " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (now_iso, origin, dest, lv.get("depart"), lv.get("return"), lv.get("price"), cached_price,
         lv.get("airline"), len(lv["via"]) if lv.get("via") is not None else None,
         lv.get("duration"), lv.get("price_level"), typ[0], typ[1] if len(typ) > 1 else None))


def deal_record(d, click):
    """Structured copy of a sent deal, for the PiDisplay summary's deal list."""
    f = d.get("fare") or {}
    origin = d["live_best"][1] if d.get("live_best") else d.get("origin")
    used = (d.get("by_origin") or {}).get(origin) or f
    return {"code": d.get("dest"), "origin": origin,
            "price": d["live_best"][0] if d.get("live_best") else d.get("price"),
            "target": d.get("eff_target") or d.get("threshold"), "median30": d.get("median"),
            "departDate": (f.get("departure_at") or "")[:10] or None,
            "returnDate": (f.get("return_at") or "")[:10] or None,
            "verified": bool(d.get("live_best")),
            "livePrice": d["live_best"][0] if d.get("live_best") else None,
            "stops": used.get("transfers"), "bags": bags_text(used), "weather": d.get("weather_data"),
            "link": click, "event": d.get("event"), "reason": d.get("reason"),
            "infoOnly": bool(d.get("info_only"))}


def record_sent(conn, d, title, body, email_body, click, actions, push, now_iso):
    price = d["live_best"][0] if d.get("live_best") else d.get("price")
    conn.execute(
        "INSERT INTO sent_alerts (sent_at, dest, month, origin, price, verified, title, message,"
        " email_body, click, actions, push, deal_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        (now_iso, d.get("dest"), d.get("month"),
         d["live_best"][1] if d.get("live_best") else d.get("origin"), price,
         1 if d.get("live_best") else 0, title, body, email_body, click,
         json.dumps(actions or []), json.dumps(push or {}), json.dumps(deal_record(d, click))))


def list_sent(conn, limit=20):
    rows = conn.execute("SELECT id, sent_at, title FROM sent_alerts ORDER BY id DESC LIMIT ?",
                        (limit,)).fetchall()
    if not rows:
        print("No saved alerts yet.")
    for i, at, title in reversed(rows):
        local = datetime.fromisoformat(at).astimezone().strftime("%Y-%m-%d %H:%M")
        print("%5d  %s  %s" % (i, local, title))


def resend_alerts(conn, ncfg, which):
    """Re-send saved alerts by id, or 'last' = every alert from the most recent run."""
    ids = []
    for w in which:
        if w == "last":
            last = conn.execute("SELECT MAX(sent_at) FROM sent_alerts").fetchone()[0]
            ids += [r[0] for r in conn.execute("SELECT id FROM sent_alerts WHERE sent_at=? ORDER BY id",
                                               (last,))]
        else:
            ids.append(int(w))
    if not ids:
        log("nothing to resend")
        return 0
    sent = 0
    for i in ids:
        row = conn.execute("SELECT title, message, email_body, click, actions, push FROM sent_alerts"
                           " WHERE id=?", (i,)).fetchone()
        if not row:
            log("no saved alert with id %d" % i)
            continue
        title, body, email_body, click, actions, push = row
        if send(ncfg, title, body, click=click, actions=[tuple(a) for a in json.loads(actions or "[]")],
                email_body=email_body, push=json.loads(push or "{}")):
            sent += 1
            log("resent #%d: %s" % (i, title))
    return sent


def rolling_median(conn, dest, month, window_days, min_days, today_str):
    """Median of per-day lowest prices (any origin) before today. None if too little history."""
    cutoff = (datetime.strptime(today_str, "%Y-%m-%d") - timedelta(days=window_days)).strftime("%Y-%m-%d")
    rows = conn.execute(
        "SELECT substr(checked_at,1,10) AS d, MIN(price) FROM observations"
        " WHERE dest=? AND month=? AND substr(checked_at,1,10) >= ? AND substr(checked_at,1,10) < ?"
        " GROUP BY d", (dest, month, cutoff, today_str)).fetchall()
    if len(rows) < min_days:
        return None
    return statistics.median(p for _, p in rows)


def evaluate(price, threshold, median, drop_pct, window_days=30):
    """Return a human-readable reason string if this is a deal, else None."""
    reasons = []
    if threshold is not None and price <= threshold:
        reasons.append("under your $%d target" % threshold)
    if median is not None and price <= median * (1 - drop_pct):
        reasons.append("%d%% below %d-day median ($%d)" % (
            round((1 - price / median) * 100), window_days, median))
    return "; ".join(reasons) or None


def should_alert(conn, dest, month, price, realert_drop, cooldown_days, now):
    """Avoid repeat pings: only re-alert if cheaper by realert_drop or cooldown has passed.
    Returns True, False, or "verify": blocked by an earlier *unverified* alert, so it may
    only go out again if a live check confirms it (an upgrade from unverified to verified)."""
    try:
        row = conn.execute("SELECT price, alerted_at, verified FROM alerts WHERE dest=? AND month=?",
                           (dest, month)).fetchone()
    except sqlite3.OperationalError:          # dry run on a db from before the verified column
        row = conn.execute("SELECT price, alerted_at, 1 FROM alerts WHERE dest=? AND month=?",
                           (dest, month)).fetchone()
    if not row:
        return True
    last_price, last_at, verified = row
    if price <= last_price * (1 - realert_drop):
        return True
    if (now - datetime.fromisoformat(last_at)) >= timedelta(days=cooldown_days):
        return True
    return "verify" if verified == 0 else False


def record_alert(conn, deal, now_iso):
    conn.execute(
        "INSERT INTO alerts (dest, month, origin, price, alerted_at, verified) VALUES (?,?,?,?,?,?)"
        " ON CONFLICT(dest, month) DO UPDATE SET origin=excluded.origin, price=excluded.price,"
        " alerted_at=excluded.alerted_at, verified=excluded.verified",
        (deal["dest"], deal["month"], deal["origin"], deal["price"], now_iso,
         1 if deal.get("live_best") else 0))


# ----------------------------------------------------------------- names
# IATA city/airport code -> "City, Country". Unknown codes fall back to the code;
# add your own under "place_names" in config.json. Keep ASCII (ntfy titles are HTTP headers).
PLACES = {
    "SFO": "San Francisco, USA", "SMF": "Sacramento, USA", "OAK": "Oakland, USA",
    "SJC": "San Jose, USA", "SEA": "Seattle, USA", "LAX": "Los Angeles, USA",
    "TYO": "Tokyo, Japan", "NRT": "Tokyo Narita, Japan", "HND": "Tokyo Haneda, Japan",
    "OSA": "Osaka, Japan", "KIX": "Osaka Kansai, Japan",
    "SEL": "Seoul, South Korea", "ICN": "Seoul Incheon, South Korea", "GMP": "Seoul Gimpo, South Korea",
    "LON": "London, UK", "LHR": "London Heathrow, UK", "LGW": "London Gatwick, UK",
    "STN": "London Stansted, UK", "LTN": "London Luton, UK", "LCY": "London City, UK",
    "MAN": "Manchester, UK", "DUB": "Dublin, Ireland",
    "PAR": "Paris, France", "CDG": "Paris Charles de Gaulle, France", "ORY": "Paris Orly, France",
    "IST": "Istanbul, Turkey", "SAW": "Istanbul Sabiha Gokcen, Turkey",
    "WAW": "Warsaw, Poland", "WMI": "Warsaw Modlin, Poland", "GDN": "Gdansk, Poland",
    "KRK": "Krakow, Poland", "BER": "Berlin, Germany", "PRG": "Prague, Czechia",
    "VIE": "Vienna, Austria", "BUD": "Budapest, Hungary",
    "SYD": "Sydney, Australia", "MEL": "Melbourne, Australia", "BNE": "Brisbane, Australia",
    "AKL": "Auckland, New Zealand", "YVR": "Vancouver, Canada",
    "AMS": "Amsterdam, Netherlands", "RTM": "Rotterdam, Netherlands", "EIN": "Eindhoven, Netherlands",
    "MNL": "Manila, Philippines", "CEB": "Cebu, Philippines", "CRK": "Clark, Philippines",
    "MUC": "Munich, Germany", "FRA": "Frankfurt, Germany",
    # common connection airports, so layovers read "PHX (Phoenix, USA)"
    "PHX": "Phoenix, USA", "DEN": "Denver, USA", "ORD": "Chicago, USA", "DFW": "Dallas, USA",
    "IAH": "Houston, USA", "ATL": "Atlanta, USA", "JFK": "New York JFK, USA", "EWR": "Newark, USA",
    "BOS": "Boston, USA", "IAD": "Washington Dulles, USA", "MSP": "Minneapolis, USA",
    "DTW": "Detroit, USA", "SLC": "Salt Lake City, USA", "LAS": "Las Vegas, USA", "SAN": "San Diego, USA",
    "PDX": "Portland, USA", "HNL": "Honolulu, USA", "CLT": "Charlotte, USA", "PHL": "Philadelphia, USA",
    "YYZ": "Toronto, Canada", "YUL": "Montreal, Canada", "YYC": "Calgary, Canada", "MEX": "Mexico City, Mexico",
    "LIS": "Lisbon, Portugal", "MAD": "Madrid, Spain", "BCN": "Barcelona, Spain",
    "ZRH": "Zurich, Switzerland", "HEL": "Helsinki, Finland", "CPH": "Copenhagen, Denmark",
    "KEF": "Reykjavik, Iceland", "FCO": "Rome, Italy", "BRU": "Brussels, Belgium",
    "DOH": "Doha, Qatar", "DXB": "Dubai, UAE", "AUH": "Abu Dhabi, UAE",
    "TPE": "Taipei, Taiwan", "HKG": "Hong Kong", "SIN": "Singapore", "PVG": "Shanghai, China",
    "PEK": "Beijing, China", "CAN": "Guangzhou, China", "BKK": "Bangkok, Thailand",
    "KUL": "Kuala Lumpur, Malaysia", "ITM": "Osaka Itami, Japan",
}


def place(code, extra=None):
    return (extra or {}).get(code) or PLACES.get(code) or code


def fmt_minutes(m):
    return "%dh%02dm" % divmod(int(m), 60) if m else ""


def fmt_day(iso):
    """'2026-11-14...' -> 'Nov 14'."""
    return datetime.strptime(iso[:10], "%Y-%m-%d").strftime("%b %d").replace(" 0", " ") if iso else "?"


def trip_dates(dep, ret):
    """'Nov 14 -> Nov 21 (8 days)' or 'Nov 14, one-way'."""
    if not dep:
        return "?"
    if not ret:
        return "%s, one-way" % fmt_day(dep)
    days = (date.fromisoformat(ret[:10]) - date.fromisoformat(dep[:10])).days + 1
    return "%s -> %s (%d days)" % (fmt_day(dep), fmt_day(ret), days)


def checked_bags(fare):
    """(pieces, total_kg) of checked baggage from the booking link's undocumented
    static_fare_key ('L0' none, 'L1_1_23' = 1 bag/23 kg, 'L1_2_46' = 2 bags/46 kg).
    None if unknown. The key's hand-luggage flag (H) is not used: it proved unreliable."""
    m = re.search(r"static_fare_key=([^&]+)", fare.get("link") or "")
    if not m:
        return None
    for part in urllib.parse.unquote(m.group(1)).split("|"):
        if part == "L0":
            return 0, 0
        lm = re.fullmatch(r"L1_(\d+)_(\d+)", part)
        if lm:
            return int(lm.group(1)), int(lm.group(2))
    return None


def bags_text(fare):
    b = checked_bags(fare)
    if b is None:
        return None
    pieces, kg = b
    if not pieces:
        return "No checked bag incl."
    txt = "%d checked bag%s incl." % (pieces, "s" if pieces > 1 else "")
    if kg:
        txt += " (%d kg%s)" % (kg, " total" if pieces > 1 else "")
    return txt


def cached_summary(f):
    """Compact parts for a cached fare, e.g. ['1 stop', 'LH', 'no bag']."""
    out, back = f.get("transfers"), f.get("return_transfers")
    if out is None:
        stops = ""
    elif back is None or not f.get("return_at") or back == out:
        stops = "nonstop" if out == 0 else "%d stop%s" % (out, "s" if out > 1 else "")
    else:
        stops = "%d/%d stops" % (out, back)            # outbound / return
    b = checked_bags(f)
    bag = None if b is None else ("no bag" if not b[0] else "%d bag%s" % (b[0], "s" if b[0] > 1 else ""))
    return [x for x in (stops, f.get("airline"), bag) if x]


# ----------------------------------------------------------------- weather
# Typical weather for the actual trip dates, averaged over the same dates in past
# years (Open-Meteo historical archive, free, no key). Unknown codes are geocoded by name.
WEATHER_URL = "https://archive-api.open-meteo.com/v1/archive"
GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search"
COORDS = {
    "TYO": (35.68, 139.69), "OSA": (34.69, 135.50), "SEL": (37.57, 126.98),
    "LON": (51.51, -0.13), "MAN": (53.48, -2.24), "DUB": (53.35, -6.26),
    "PAR": (48.86, 2.35), "IST": (41.01, 28.98), "WAW": (52.23, 21.01),
    "GDN": (54.35, 18.65), "KRK": (50.06, 19.94), "BER": (52.52, 13.40),
    "PRG": (50.08, 14.44), "VIE": (48.21, 16.37), "BUD": (47.50, 19.04),
    "SYD": (-33.87, 151.21), "MEL": (-37.81, 144.96), "BNE": (-27.47, 153.03),
    "AKL": (-36.85, 174.76), "YVR": (49.28, -123.12), "SEA": (47.61, -122.33),
    "AMS": (52.37, 4.90), "MNL": (14.60, 120.98), "CEB": (10.32, 123.89),
    "MUC": (48.14, 11.58), "FRA": (50.11, 8.68),
}


def city_coords(code, names=None):
    if code in COORDS:
        return COORDS[code]
    city = place(code, names).split(",")[0]
    if city == code:
        return None
    res = (http_get_json(GEOCODE_URL, {"name": city, "count": 1}, {}).get("results") or [])
    if res:
        COORDS[code] = (res[0]["latitude"], res[0]["longitude"])
        return COORDS[code]
    return None


def _shift_year(d, k):
    try:
        return d.replace(year=d.year - k)
    except ValueError:                      # Feb 29 in a non-leap year
        return d.replace(year=d.year - k, day=28)


def trip_weather(code, fare, wcfg, names=None, out=None):
    """Typical weather for this fare's trip dates, or None if unavailable.
    out: optional dict that receives {summary, highF, lowF} for the PiDisplay summary."""
    coords = city_coords(code, names)
    dep = (fare.get("departure_at") or "")[:10]
    if not coords or not dep:
        return None
    start = datetime.strptime(dep, "%Y-%m-%d").date()
    ret = (fare.get("return_at") or "")[:10]
    end = datetime.strptime(ret, "%Y-%m-%d").date() if ret else start + timedelta(days=13)
    years = int(wcfg.get("years", 5))
    metric = wcfg.get("units", "fahrenheit") == "celsius"
    # One request covering the last N years; keep only days inside each year's shifted trip window.
    windows = [(_shift_year(start, k), _shift_year(end, k))
               for k in range(1, years + 1) if _shift_year(end, k) < date.today()]
    if not windows:
        return None
    params = {"latitude": coords[0], "longitude": coords[1],
              "start_date": min(w[0] for w in windows).isoformat(),
              "end_date": max(w[1] for w in windows).isoformat(),
              "daily": "temperature_2m_max,temperature_2m_min,precipitation_sum,"
                       "snowfall_sum,sunshine_duration",
              "timezone": "auto",
              "temperature_unit": "celsius" if metric else "fahrenheit",
              "precipitation_unit": "mm" if metric else "inch"}
    daily = http_get_json(WEATHER_URL, params, {}).get("daily") or {}
    highs, lows, rain, snow, sun = [], [], [], [], []
    for i, day in enumerate(daily.get("time") or []):
        dd = date.fromisoformat(day)
        if not any(a <= dd <= b for a, b in windows):
            continue
        hi, lo = daily["temperature_2m_max"][i], daily["temperature_2m_min"][i]
        if hi is None or lo is None:
            continue
        highs.append(hi)
        lows.append(lo)
        rain.append(daily["precipitation_sum"][i] or 0)
        snow.append(daily["snowfall_sum"][i] or 0)
        sun.append((daily["sunshine_duration"][i] or 0) / 3600)
    if not highs:
        return None
    wet = 1.0 if metric else 0.04            # >= 1 mm counts as a rainy day
    snowy = 0.5 if metric else 0.2           # snowfall is cm / inch; ignore trace flurries
    trip_days = (end - start).days + 1
    unit, punit = ("C", "mm") if metric else ("F", "in")
    rain_days = sum(r >= wet for r in rain) / len(rain) * trip_days
    snow_days = sum(s >= snowy for s in snow) / len(snow) * trip_days
    lines = ["\U0001F321️ HISTORICAL WEATHER",
             "Midday ~%d°%s / Night ~%d°%s" % (round(statistics.mean(highs)), unit,
                                              round(statistics.mean(lows)), unit),
             "Rain ~%d of %d days (%.2f %s/day)" % (round(rain_days), trip_days,
                                                    statistics.mean(rain), punit),
             "Sun ~%.0fh/day" % statistics.mean(sun)]
    if snow_days >= 0.5:
        lines.append("Snow ~%d days" % round(snow_days))
    if out is not None:
        to_f = (lambda c: c * 9 / 5 + 32) if metric else (lambda f: f)
        out.update(summary="Rain ~%d of %d days, sun ~%.0fh/day%s" % (
                       round(rain_days), trip_days, statistics.mean(sun),
                       ", snow ~%d days" % round(snow_days) if snow_days >= 0.5 else ""),
                   highF=round(to_f(statistics.mean(highs))), lowF=round(to_f(statistics.mean(lows))))
    return lines


# ----------------------------------------------------------------- live prices
# Travelpayouts only has fares other people searched (rarely SMF), and they can be days
# old. For deals about to alert, ask Google Flights (via SerpApi) for the live price on
# the exact dates. Free plan = 250 searches/month, so this is budgeted per run.
SERPAPI_URL = "https://serpapi.com/search.json"
SERPAPI_ACCOUNT_URL = "https://serpapi.com/account.json"
# Google Flights rejects metro codes (TYO, LON...), so expand them to airports.
CITY_AIRPORTS = {
    "TYO": "NRT,HND", "OSA": "KIX,ITM", "SEL": "ICN,GMP", "LON": "LHR,LGW,STN,LTN,LCY",
    "PAR": "CDG,ORY", "IST": "IST,SAW", "WAW": "WAW,WMI", "MIL": "MXP,LIN,BGY",
    "ROM": "FCO,CIA", "STO": "ARN,BMA", "MOW": "SVO,DME,VKO",
}


def serpapi_searches_left(key):
    try:
        acct = http_get_json(SERPAPI_ACCOUNT_URL, {"api_key": key}, {})
        SERPAPI_ACCOUNT.clear()
        SERPAPI_ACCOUNT.update(acct)
        return int(acct.get("total_searches_left"))
    except Exception as ex:
        log("could not read SerpApi quota: %s" % ex)
        return None


def live_price(key, origin, dest, fare, currency="usd"):
    """Cheapest live Google Flights option for this fare's dates from `origin`."""
    dep = (fare.get("departure_at") or "")[:10]
    ret = (fare.get("return_at") or "")[:10]
    params = {"engine": "google_flights", "departure_id": origin,
              "arrival_id": CITY_AIRPORTS.get(dest, dest), "outbound_date": dep,
              "type": 1 if ret else 2, "currency": currency.upper(), "hl": "en", "gl": "us",
              "api_key": key}
    if ret:
        params["return_date"] = ret
    d = http_get_json(SERPAPI_URL, params, {}, timeout=60)
    pi = d.get("price_insights") or {}
    res = {"depart": dep, "return": ret or None, "price": None,
           "url": (d.get("search_metadata") or {}).get("google_flights_url"),
           "price_level": pi.get("price_level"), "typical": pi.get("typical_price_range")}
    opts = [o for o in (d.get("best_flights") or []) + (d.get("other_flights") or []) if o.get("price")]
    if not opts:
        res["error"] = d.get("error") or "no flights found"
        return res
    o = min(opts, key=lambda x: x["price"])
    airlines = []
    for seg in o.get("flights") or []:
        if seg.get("airline") and seg["airline"] not in airlines:
            airlines.append(seg["airline"])
    res["history"] = [(int(t), float(p)) for t, p in (pi.get("price_history") or []) if p]
    # Outbound itinerary (Google's search results don't include the return legs).
    res["legs"] = [{"from": (s.get("departure_airport") or {}).get("id"),
                    "to": (s.get("arrival_airport") or {}).get("id"),
                    "to_name": (s.get("arrival_airport") or {}).get("name"),
                    "arrive": (s.get("arrival_airport") or {}).get("time"),   # local time at arrival
                    "minutes": s.get("duration"), "airline": s.get("airline"),
                    "flight": s.get("flight_number")} for s in o.get("flights") or []]
    res["layovers"] = [{"id": l.get("id"), "name": l.get("name"), "minutes": l.get("duration"),
                        "overnight": bool(l.get("overnight"))} for l in o.get("layovers") or []]
    res.update(price=float(o["price"]), airline=", ".join(airlines), logo=o.get("airline_logo"),
               via=[l.get("id") for l in o.get("layovers") or []],
               duration=o.get("total_duration"))
    return res


def hm(minutes):
    """Minutes -> 'h:mm' (e.g. 21:43)."""
    return "%d:%02d" % divmod(int(minutes), 60) if minutes else "?"


def airport_label(code, name=None):
    """'Phoenix, USA' for known codes, else Google's airport name without 'International Airport'."""
    if code in PLACES:
        return PLACES[code]
    return re.sub(r"\s*(International)?\s*Airport$", "", name or code).strip() or code


def live_lines(origin, lv, vs_price=None, vs_origin=None, dest=None):
    """One airport's live Google Flights result: price, airline, then the outbound
    itinerary leg by leg with layovers and local arrival time."""
    if lv.get("price") is None:
        return ["%s: no flights found" % origin]
    diff = ""
    if vs_price is not None:
        diff = " (cheapest)" if lv["price"] <= vs_price else " (+$%d vs %s)" % (lv["price"] - vs_price, vs_origin)
    lines = ["%s: $%d%s" % (origin, lv["price"], diff), "  " + (lv.get("airline") or "?")]
    legs, lays = lv.get("legs") or [], lv.get("layovers") or []
    if legs:
        if len(legs) == 1:
            lines.append("  %s -> %s | Nonstop, flight time %s" % (legs[0]["from"], legs[0]["to"],
                                                                   hm(legs[0].get("minutes"))))
        else:
            if len(lays) == 1:
                lines.append("  1 stop via %s (%s)" % (lays[0]["id"],
                                                       airport_label(lays[0]["id"], lays[0].get("name"))))
            else:                             # one per line so long city names don't wrap
                lines.append("  %d stops via" % len(lays))
                lines += ["    %s (%s)" % (l["id"], airport_label(l["id"], l.get("name"))) for l in lays]
            lines.append("  Total flight time %s (outbound)" % hm(lv.get("duration")))
            for i, leg in enumerate(legs):
                lines.append("  %s -> %s | Flight time %s" % (leg["from"], leg["to"], hm(leg.get("minutes"))))
                if i < len(lays):
                    lines.append("  Layover %s%s" % (hm(lays[i].get("minutes")),
                                                      " (overnight)" if lays[i].get("overnight") else ""))
        arrive = legs[-1].get("arrive")
        if arrive:
            when = datetime.strptime(arrive, "%Y-%m-%d %H:%M")
            city = place(dest or legs[-1]["to"]).split(",")[0]
            lines.append("  Arrives %s, %s (%s time)" % (when.strftime("%H:%M"),
                                                         fmt_day(when.strftime("%Y-%m-%d")), city))
    else:                                     # older saved results without leg details
        via = lv.get("via") or []
        stops = "nonstop" if not via else "%d stop%s via %s" % (len(via), "s" if len(via) > 1 else "", ", ".join(via))
        lines.append("  %s, %s out" % (stops, fmt_minutes(lv.get("duration")) or "?"))
    if lv.get("price_level"):
        rng = lv.get("typical") or []
        lines.append("  Google says %s%s" % (lv["price_level"],
                                             " (usual $%d-%d)" % tuple(rng[:2]) if len(rng) >= 2 else ""))
    return lines


# ----------------------------------------------------------------- charts
# Rendered by QuickChart (free, no key): the chart config, i.e. just the price numbers,
# goes in the image URL, and ntfy attaches that image to the notification.
QUICKCHART_URL = "https://quickchart.io/chart"


def _compact_data(data, labels):
    """Shrink a series for the URL: whole dollars; a flat line (target, limit, typical)
    becomes its two end points and a lone point (today's dot) just itself, as {x, y}
    points on the same category axis. Other series keep their gaps (None) as-is."""
    vals = [None if v is None else int(round(v)) for v in data]
    present = [(labels[i], v) for i, v in enumerate(vals) if v is not None]
    if len(present) == 1 and len(vals) > 1:
        return [{"x": present[0][0], "y": present[0][1]}]
    if len(present) == len(vals) > 2 and len({v for _, v in present}) == 1:
        return [{"x": labels[0], "y": vals[0]}, {"x": labels[-1], "y": vals[0]}]
    return vals


def quickchart(title, labels, datasets, w=600, h=340):
    # Chart.js v4 legend: a zero-height box is stroked with the dataset's own width and
    # dash pattern, so each entry shows as a line sample (solid / dashed / dash-dot)
    # instead of v2's filled blocks.
    # Kept small (base64, compacted data): ntfy rejects notifications over ~8 KB and the
    # chart URL travels inside the notification.
    for ds in datasets:
        ds["data"] = _compact_data(ds["data"], labels)
    cfg = {"type": "line", "data": {"labels": labels, "datasets": datasets},
           "options": {"layout": {"padding": {"right": 14, "top": 4}},
                       "plugins": {"title": {"display": True, "text": title, "font": {"size": 15}},
                                   "legend": {"position": "bottom",
                                              "labels": {"boxWidth": 40, "boxHeight": 0,
                                                         "padding": 14}}},
                       "scales": {"y": {"title": {"display": True, "text": "USD round trip"}}}}}
    raw = json.dumps(cfg, separators=(",", ":")).encode("utf-8")
    return QUICKCHART_URL + "?" + urllib.parse.urlencode(
        {"c": base64.b64encode(raw).decode("ascii"), "encoding": "base64", "w": w, "h": h,
         "bkg": "white", "f": "png", "v": "4"})


def _line(label, data, color, width=3, dash=None, points=0, span=True, style="line"):
    """One chart series; the legend sample uses `width` and `dash`. style = data-point shape.
    Chart.js defaults (no fill, line point style, no gap spanning) are left out to keep URLs short."""
    ds = {"label": label, "data": data, "borderColor": color, "borderWidth": width, "pointRadius": points}
    if points:
        ds["backgroundColor"] = color         # fills the dots
    if span:
        ds["spanGaps"] = True
    if style != "line":
        ds["pointStyle"] = style
    if dash:
        ds["borderDash"] = dash
    return ds


def _chart_target(d):
    return d.get("eff_target") or d.get("threshold")


# Solid lines/dots = prices (colour per airport); dashed = thresholds (red family).
ORIGIN_COLORS = {"SFO": "#1a73e8", "SMF": "#e37400"}
OTHER_COLORS = ["#188038", "#a142f4", "#00796b"]
LIMIT_COLOR, LIMIT_DASH = "#8c1d18", [12, 4, 2, 4]      # airport allowance: dark red dash-dot


def history_chart(d):
    """Google's daily price for these exact dates over the last ~60 days, one line per
    live-checked airport (e.g. SFO and SMF), plus your target and any airport allowance."""
    if not d.get("live_best"):
        return None
    live = d.get("live") or {}
    series = {}                                   # origin -> {day: price}
    for o, lv in live.items():
        hist = lv.get("history") or []
        if len(hist) >= 5:
            series[o] = {datetime.fromtimestamp(t, timezone.utc).strftime("%Y-%m-%d"): p for t, p in hist}
    if not series:
        return None
    days = sorted(set().union(*series.values()))
    n = len(days)
    ds = []
    for i, (o, by_day) in enumerate(sorted(series.items(), key=lambda kv: kv[0] != d["live_best"][1])):
        color = ORIGIN_COLORS.get(o, OTHER_COLORS[i % len(OTHER_COLORS)])
        ds.append(_line("%s on Google" % o, [by_day.get(x) for x in days], color))
    # Google often has no history for smaller airports (SMF); show today's live price as a dot.
    for i, (o, lv) in enumerate(live.items()):
        if o not in series and lv.get("price") is not None:
            color = ORIGIN_COLORS.get(o, OTHER_COLORS[i % len(OTHER_COLORS)])
            # Width only affects the legend sample here (a single point draws no line):
            # a short thick bar reads as a marker rather than a line.
            dot = _line("%s today $%d" % (o, lv["price"]), [None] * (n - 1) + [lv["price"]],
                        color, 9, None, 9, style="circle")
            dot.update(pointBorderColor="#ffffff", pointBorderWidth=2)
            ds.append(dot)
    shown = set(series) | {o for o, lv in live.items() if lv.get("price") is not None}
    target = d.get("threshold")
    if target:
        ds.append(_line("Your target $%d" % target, [target] * n, "#d93025", 2, [8, 5]))
        for o, extra in sorted((d.get("allow") or {}).items()):
            if o in shown:
                ds.append(_line("%s limit $%d" % (o, target + extra), [target + extra] * n,
                                LIMIT_COLOR, 2, LIMIT_DASH))
    # Google's typical range for the headline airport (the alert's price); with two
    # airports on the chart, the label says whose range it is.
    head = d["live_best"][1]
    typ = (live.get(head) or {}).get("typical") or []
    if len(typ) >= 2:
        who = "%s typical" % head if len(shown) > 1 else "Typical"
        ds.append(_line("%s low $%d" % (who, typ[0]), [typ[0]] * n, "#9aa0a6", 2, [3, 3]))
        ds.append(_line("%s high $%d" % (who, typ[1]), [typ[1]] * n, "#5f6368", 2, [3, 3]))
    lv0 = live[d["live_best"][1]]
    title = "%s %s: Google price, last %d days" % (
        place(d["dest"]).split(",")[0], trip_dates(lv0.get("depart"), lv0.get("return")).split(" (")[0], n)
    labels = [fmt_day(x) for x in days]
    return quickchart(title, labels, ds)


def own_history_chart(conn, d, compare_origins, names=None, min_days=7, window_days=60, now=None):
    """Fallback when Google has no price history: the cheapest fare we saved each day for
    this destination + departure month, per airport. None until min_days of data exist."""
    if d.get("event"):                          # fixed-date trips: Google history only
        return None
    now = now or datetime.now(timezone.utc)
    cutoff = (now - timedelta(days=window_days)).strftime("%Y-%m-%d")
    try:
        rows = conn.execute(
            "SELECT substr(checked_at,1,10) AS day, origin, MIN(price) FROM observations"
            " WHERE dest=? AND month=? AND substr(checked_at,1,10) >= ? GROUP BY day, origin",
            (d["dest"], d["month"], cutoff)).fetchall()
    except sqlite3.OperationalError:
        return None
    days = sorted({r[0] for r in rows})
    if len(days) < min_days:
        return None
    series = {}
    for day, o, p in rows:
        series.setdefault(o, {})[day] = p
    head = d["live_best"][1] if d.get("live_best") else d["origin"]
    wanted = [o for o in list(compare_origins) + [head] if o in series]
    wanted = list(dict.fromkeys(wanted))            # keep order, drop duplicates
    if not wanted:
        return None
    n = len(days)
    ds = [_line("%s cheapest that day" % o, [series[o].get(x) for x in days],
                ORIGIN_COLORS.get(o, OTHER_COLORS[i % len(OTHER_COLORS)]), 3, None, 0)
          for i, o in enumerate(wanted)]
    target = d.get("threshold")
    if target:
        ds.append(_line("Your target $%d" % target, [target] * n, "#d93025", 2, [8, 5]))
        for o, extra in sorted((d.get("allow") or {}).items()):
            if o in wanted:
                ds.append(_line("%s limit $%d" % (o, target + extra), [target + extra] * n,
                                LIMIT_COLOR, 2, LIMIT_DASH))
    head_prices = sorted(series.get(head, {}).values())
    if len(head_prices) >= 4:                       # middle half of our own daily prices
        q1, _, q3 = statistics.quantiles(head_prices, n=4)
        ds.append(_line("%s usual low $%d (your data)" % (head, q1), [q1] * n, "#9aa0a6", 2, [3, 3]))
        ds.append(_line("%s usual high $%d (your data)" % (head, q3), [q3] * n, "#5f6368", 2, [3, 3]))
    city = place(d["dest"], names).split(",")[0]
    month_txt = datetime.strptime(d["month"], "%Y-%m").strftime("%b '%y")
    return quickchart("%s, %s departures: saved prices, last %d days" % (city, month_txt, n),
                      [fmt_day(x) for x in days], ds)


def month_chart(d, months, compare_origins, names=None):
    """Cheapest cached fare per departure month, per airport, over the months watched.
    Months without data stay as gaps rather than being bridged by a line."""
    per_month = d.get("month_prices") or {}
    origins = [o for o in compare_origins if any(per_month.get(m, {}).get(o) for m in months)]
    if not origins:
        return None
    labels = [datetime.strptime(m, "%Y-%m").strftime("%b '%y") for m in months]
    ds = [_line(o, [per_month.get(m, {}).get(o) for m in months],
                ORIGIN_COLORS.get(o, OTHER_COLORS[i % len(OTHER_COLORS)]), 3, None, 5, False, "circle")
          for i, o in enumerate(origins)]
    target = d.get("threshold")
    if target:
        ds.append(_line("Your target $%d" % target, [target] * len(months), "#d93025", 2, [8, 5]))
        for o, extra in sorted((d.get("allow") or {}).items()):
            if o in origins:
                ds.append(_line("%s limit $%d" % (o, target + extra), [target + extra] * len(months),
                                LIMIT_COLOR, 2, LIMIT_DASH))
    city = place(d["dest"], names).split(",")[0]
    return quickchart("%s: cheapest fare by departure month" % city, labels, ds)


# ----------------------------------------------------------------- links
def google_flights_link(origin, dest, fare):
    dep = (fare.get("departure_at") or "")[:10]
    ret = (fare.get("return_at") or "")[:10]
    q = "Flights from %s to %s on %s" % (origin, dest, dep)
    if ret:
        q += " through %s" % ret
    return "https://www.google.com/travel/flights?q=" + urllib.parse.quote(q)


def aviasales_link(fare):
    link = fare.get("link")
    return "https://www.aviasales.com" + link if link else None


# ----------------------------------------------------------------- notify
def notify_ntfy(ncfg, title, body, click=None, actions=None, tags=None, priority=4, icon=None,
                attach=None, filename=None):
    """Publish as JSON (no header length/charset limits). actions: [(label, url)], max 3 buttons.
    tags matching emoji names render as emoji before the title; icon is Android-only;
    attach is an image URL the app downloads and shows (one per message)."""
    topic = ncfg.get("ntfy_topic")
    if not topic:
        return False
    server = ncfg.get("ntfy_server", "https://ntfy.sh").rstrip("/")
    msg = {"topic": topic, "title": title, "message": body, "tags": tags or ["airplane"],
           "priority": int(priority)}
    if click:
        msg["click"] = click
    if icon:
        msg["icon"] = icon
    if attach:
        msg["attach"] = attach
        msg["filename"] = filename or "chart.png"
    if actions:
        msg["actions"] = [{"action": "view", "label": label, "url": url, "clear": False}
                          for label, url in actions[:3]]
    # ntfy.sh rejects requests over ~8 KB (HTTP 413). Rather than lose the alert, drop the
    # chart, then the icon, then trim the text until it fits.
    limit = int(ncfg.get("max_request_bytes", 7800))
    size = lambda: len(json.dumps(msg).encode("utf-8"))
    for extra in ("attach", "icon"):
        if size() > limit and extra in msg:
            msg.pop(extra)
            msg.pop("filename", None)
            log("notification too large for ntfy; sending without the %s" % (
                "chart" if extra == "attach" else extra))
    while size() > limit and len(msg["message"]) > 400:
        msg["message"] = msg["message"][:-200].rstrip() + "\n..."
    req = urllib.request.Request(server, data=json.dumps(msg).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    count_call(server)
    with urllib.request.urlopen(req, timeout=20):
        pass
    return True


def notify_email(ncfg, subject, body):
    e = ncfg.get("email") or {}
    if not e.get("enabled"):
        return False
    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = subject, e["from"], e["to"]
    msg.set_content(body)
    password = os.environ.get("FARE_WATCH_SMTP_PASSWORD", e.get("password", ""))
    with smtplib.SMTP_SSL(e["smtp_host"], int(e.get("smtp_port", 465)),
                          context=ssl.create_default_context()) as s:
        s.login(e["username"], password)
        s.send_message(msg)
    return True


def short_body(body):
    """First lines of an alert, through the line after the price: place, dates, price, reason."""
    lines = [l for l in body.splitlines() if l.strip()]
    for i, l in enumerate(lines):
        if "$" in l:
            return "\n".join(lines[:i + 2])
    return "\n".join(lines[:4])


def pidisplay_level(push):
    """Map the ntfy style to a PiDisplay level: live-verified deal, unverified deal, other."""
    tags = (push or {}).get("tags") or []
    return "alert" if "white_check_mark" in tags else "warning" if "warning" in tags else "info"


def notify_pidisplay(title, body, level="info"):
    """Show the alert in PiDisplay's notification bell (env PIDISPLAY_URL, e.g. http://127.0.0.1:8080)."""
    base = os.environ.get("PIDISPLAY_URL", "").strip().rstrip("/")
    if not base:
        return False
    msg = {"title": title, "body": body, "source": "Farewatcher", "level": level}
    req = urllib.request.Request(base + "/api/notifications", data=json.dumps(msg).encode("utf-8"),
                                 headers={"Content-Type": "application/json"}, method="POST")
    count_call(base)
    with urllib.request.urlopen(req, timeout=10):
        pass
    return True


def send(ncfg, title, body, click=None, actions=None, email_body=None, push=None):
    """Return True if at least one channel delivered. Push gets buttons; email gets inline links.
    push: extra ntfy fields (tags, priority, icon). PiDisplay only counts as delivered when
    no phone/email channel is configured, so a failed push is still retried next run."""
    ok = False
    for fn in (lambda: notify_ntfy(ncfg, title, body, click, actions, **(push or {})),
               lambda: notify_email(ncfg, title, email_body or body)):
        try:
            ok = fn() or ok
        except Exception as ex:
            log("notify error: %s" % ex)
    try:
        shown = notify_pidisplay(title, short_body(body), pidisplay_level(push))
        if shown and not (ncfg.get("ntfy_topic") or (ncfg.get("email") or {}).get("enabled")):
            ok = True
    except Exception as ex:
        log("PiDisplay notify error: %s" % ex)
    return ok


def _shown_origins(d, compare_origins):
    return list(compare_origins) + ([d["origin"]] if d["origin"] not in compare_origins else [])


def deal_actions(d, compare_origins=()):
    """Up to 3 (label, url) buttons: Google Flights per compared airport, then the booking source."""
    by_origin, live = d.get("by_origin", {}), d.get("live", {})
    acts = []
    for o in _shown_origins(d, compare_origins):
        if live.get(o, {}).get("url"):           # exact-dates Google Flights page
            acts.append(("%s flights" % o, live[o]["url"]))
        elif by_origin.get(o):
            acts.append(("%s flights" % o, google_flights_link(o, d["dest"], by_origin[o])))
    if d.get("av_link"):
        acts.append(("Book %s $%d" % (d["origin"], d["price"]), d["av_link"]))
    return acts[:3]


def push_style(d, ncfg=None):
    """ntfy tags/priority/icon for a deal: check mark if live-verified, warning if not;
    priority from how far under target the (live, else cached) price is."""
    ncfg = ncfg or {}
    price = d["live_best"][0] if d.get("live_best") else d["price"]
    target = d.get("eff_target") or d.get("threshold")
    ratio = price / target if target else 1.0
    if ratio <= 1 - float(ncfg.get("urgent_below_target", 0.25)):
        priority = 5            # big deal: loudest alert
    elif ratio <= 1 - float(ncfg.get("high_below_target", 0.10)):
        priority = 4
    else:
        priority = 3            # borderline: normal notification
    kind = d.get("event_tag") or "airplane"                  # e.g. beer for Oktoberfest
    if d.get("info_only"):
        return {"tags": [kind, "eyes"], "priority": 2}       # heads-up, not a deal
    style = {"tags": ["white_check_mark" if d.get("live_best") else "warning", kind],
             "priority": priority}
    if d.get("live_best"):
        logo = (d.get("live") or {}).get(d["live_best"][1], {}).get("logo")
        if logo:
            style["icon"] = logo
    return style


def _allowance_mark(d, origin, delta):
    """'within/over your +$250 SMF limit' line for airports with an allowance."""
    extra = (d.get("allow") or {}).get(origin)
    if extra is None or delta <= 0:
        return []
    return ["  %s %s your +$%d %s limit" % ("✅" if delta <= extra else "❌",
                                            "within" if delta <= extra else "over", extra, origin)]


def format_deal(d, compare_origins=(), names=None, links=True):
    """Deal text; always lists each compare_origins airport (e.g. SFO and SMF) side by side.
    links=False drops the URLs (the push notification shows them as buttons instead)."""
    f = d["fare"]
    lines = ["%s (%s)" % (place(d["dest"], names), d["dest"])]
    if d.get("event"):
        lines.insert(0, d["event"].upper())
    dest_airport = f.get("destination_airport")
    if dest_airport and dest_airport != d["dest"]:
        lines.append("Lands %s, %s" % (dest_airport, place(dest_airport, names).split(",")[0]))
    lines.append(trip_dates(f.get("departure_at"), f.get("return_at")))
    lines.append("")
    if d.get("live_best"):
        lp, lo = d["live_best"]
        lines.append("$%d from %s (live price)" % (lp, lo))
    else:
        lines.append("~$%d from %s (unverified)" % (d["price"], d["origin"]))
    lines.append(d["reason"][0].upper() + d["reason"][1:])
    bags = bags_text(f)
    if bags:
        lines.append("\U0001F9F3 Bags: " + bags[0].lower() + bags[1:])

    if d.get("weather"):
        lines += [""] + list(d["weather"])

    live = d.get("live") or {}
    if live:
        prices = [(lv["price"], o) for o, lv in live.items() if lv.get("price") is not None]
        lo_p, lo_o = min(prices) if prices else (None, None)
        lines += ["", "\U0001F4B5 LIVE ON GOOGLE FLIGHTS"]
        for o, lv in live.items():
            lines += live_lines(o, lv, lo_p if len(prices) > 1 else None, lo_o, d["dest"])
            if lv.get("price") is not None and len(prices) > 1:
                lines += _allowance_mark(d, o, lv["price"] - lo_p)

    if d.get("event"):                         # fixed-date trips have no cached fares
        return "\n".join(lines)
    # Cached fares, one compact line each (+ dates only when they differ from the headline trip).
    lines += ["", "\U0001F5C2️ CACHED FARES (may be days old)"]
    by_origin = d.get("by_origin", {})
    shown = _shown_origins(d, compare_origins)
    cached = [(float(by_origin[o]["price"]), o) for o in shown if by_origin.get(o)]
    c_lo = min(cached)[0] if cached else None
    for o in shown:
        of = by_origin.get(o)
        if not of:
            lines.append("%s: none this month" % o)
            continue
        p = float(of["price"])
        diff = "" if p <= c_lo else " (+$%d)" % (p - c_lo)
        lines.append("%s: $%d%s, %s" % (o, p, diff, ", ".join(cached_summary(of))))
        if (of.get("departure_at"), of.get("return_at")) != (f.get("departure_at"), f.get("return_at")):
            lines.append("  other dates: " + trip_dates(of.get("departure_at"), of.get("return_at")))
        if links:
            lines.append("  Verify: " + google_flights_link(o, d["dest"], of))
    if links and d.get("av_link"):
        lines += ["", "Source (%s): %s" % (d["origin"], d["av_link"])]
    return "\n".join(lines)


# ----------------------------------------------------------------- PiDisplay summary
# A JSON snapshot of fares.db for the PiDisplay widget, rewritten after every run
# (and by --export-summary). Reads only; no API calls.
def record_run(db_path, started, ok, error):
    acct = SERPAPI_ACCOUNT
    per_month, left = acct.get("searches_per_month"), acct.get("total_searches_left")
    conn = open_db(db_path)
    conn.execute(
        "INSERT INTO runs (started_at, finished_at, ok, error, fares_fetched, deals_found,"
        " serpapi_used, serpapi_budget) VALUES (?,?,?,?,?,?,?,?)",
        (started, datetime.now(timezone.utc).replace(microsecond=0).isoformat(), 1 if ok else 0, error,
         RUN_STATS.get("fares_fetched"), RUN_STATS.get("deals_found"),
         per_month - left if per_month is not None and left is not None else None, per_month))
    conn.commit()
    conn.close()


def _live_for(conn, dest, origin, dep, ret, since):
    """Latest live Google price for these exact dates since `since`, or None."""
    row = conn.execute(
        "SELECT price FROM live_checks WHERE dest=? AND origin=? AND depart_date=? AND return_date IS ?"
        " AND checked_at >= ? AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 1",
        (dest, origin, dep, ret, since)).fetchone()
    return row[0] if row else None


def _alternates(conn, cfg, dest, origin, dep, ret, since, window_days=3, live_since=None):
    """The same trip from each other configured origin, from the latest fetch for this destination:
    exact same dates if that origin has them, else its cheapest fare departing within
    +/- window_days (sameDates false). Origins with neither are left out."""
    latest = conn.execute("SELECT MAX(checked_at) FROM fares WHERE dest=?", (dest,)).fetchone()[0]
    if not latest or not dep:
        return []
    d0 = date.fromisoformat(dep)
    live_since = live_since or since
    out = []
    for o in cfg.get("origins") or []:
        if o == origin:
            continue
        rows = conn.execute(
            "SELECT price, substr(depart_at,1,10), substr(return_at,1,10), transfers, airline FROM fares"
            " WHERE dest=? AND origin=? AND checked_at=? ORDER BY price", (dest, o, latest)).fetchall()
        exact = [r for r in rows if r[1] == dep and (r[2] or None) == ret]
        near = [r for r in rows if r[1] and abs((date.fromisoformat(r[1]) - d0).days) <= window_days]
        pick = (exact or near or [None])[0]
        if not exact:
            # No cached fare on these dates, but a live Google check from this origin is
            # the exact equivalent (live checks cover each deal from every live origin).
            row = conn.execute(
                "SELECT price, stops, airline FROM live_checks WHERE dest=? AND origin=? AND depart_date=?"
                " AND return_date IS ? AND checked_at >= ? AND price IS NOT NULL"
                " ORDER BY checked_at DESC LIMIT 1", (dest, o, dep, ret, live_since)).fetchone()
            if row:
                out.append({"origin": o, "price": row[0], "departDate": dep, "returnDate": ret,
                            "stops": row[1], "airline": row[2], "sameDates": True,
                            "verified": True, "livePrice": row[0]})
                continue
        if not pick:
            continue
        price, a_dep, a_ret, stops, airline = pick
        live = _live_for(conn, dest, o, a_dep, a_ret or None, since)
        out.append({"origin": o, "price": price, "departDate": a_dep, "returnDate": a_ret or None,
                    "stops": stops, "airline": airline, "sameDates": bool(exact),
                    "verified": live is not None, "livePrice": live})
    return out


def _origin_view(conn, code, origin, latest, months, cut90, cut30, now, recheck):
    """One home airport's view of a destination for the widget's airport switch: its cheapest
    current cached fare (else its latest live Google check in the last 14 days), median,
    90-day daily lows and cheapest per travel month."""
    current, per_month = None, {}
    if latest:
        rows = conn.execute(
            "SELECT month, price, depart_at, return_at, airline, transfers FROM observations"
            " WHERE dest=? AND origin=? AND checked_at=? AND month >= ? ORDER BY price",
            (code, origin, latest, months[0])).fetchall()
        for r in rows:
            per_month.setdefault(r[0], r[1])
        if rows:
            _, price, dep, ret, airline, stops = rows[0]
            dep, ret = (dep or "")[:10] or None, (ret or "")[:10] or None
            # 14 days, like the deal list: a recent live check outranks a stale cached price.
            live = _live_for(conn, code, origin, dep, ret, (now - timedelta(days=DISPROVED_DAYS)).isoformat())
            current = {"price": price, "origin": origin, "departDate": dep, "returnDate": ret,
                       "stops": stops, "airline": airline, "verified": live is not None, "livePrice": live,
                       "link": google_flights_link(origin, code, {"departure_at": dep, "return_at": ret})}
    if current is None:                     # nothing cached from here: use a recent live check
        row = conn.execute(
            "SELECT price, depart_date, return_date, stops, airline FROM live_checks"
            " WHERE dest=? AND origin=? AND checked_at >= ? AND price IS NOT NULL AND depart_date >= ?"
            " ORDER BY checked_at DESC, price LIMIT 1",
            (code, origin, (now - timedelta(days=DISPROVED_DAYS)).isoformat(),
             now.strftime("%Y-%m-%d"))).fetchone()
        if row:
            price, dep, ret, stops, airline = row
            current = {"price": price, "origin": origin, "departDate": dep, "returnDate": ret,
                       "stops": stops, "airline": airline, "verified": True, "livePrice": price,
                       "link": google_flights_link(origin, code, {"departure_at": dep, "return_at": ret})}
    history = [{"date": d_, "low": p} for d_, p in conn.execute(
        "SELECT substr(checked_at,1,10) AS d, MIN(price) FROM observations WHERE dest=? AND origin=?"
        " AND substr(checked_at,1,10) >= ? GROUP BY d ORDER BY d", (code, origin, cut90))]
    lows30 = [x["low"] for x in history if x["date"] >= cut30]
    return {"currentLow": current, "median30": statistics.median(lows30) if lows30 else None,
            "history": history, "monthly": [{"month": m, "low": per_month.get(m)} for m in months]}


def build_summary(cfg, conn, now=None):
    now = now or datetime.now(timezone.utc).replace(microsecond=0)
    names = cfg.get("place_names") or {}
    a = cfg.get("alerting", {})
    cooldown = int(a.get("realert_cooldown_days", 14))
    recheck = int(cfg.get("live_check", {}).get("recheck_after_days", 3))
    months = month_list(int(cfg.get("months_ahead", 6)), now.date())
    today = now.strftime("%Y-%m-%d")

    run = conn.execute("SELECT started_at, finished_at, ok, error, fares_fetched, deals_found,"
                       " serpapi_used, serpapi_budget FROM runs ORDER BY id DESC LIMIT 1").fetchone()
    if run:
        last_run = dict(zip(("startedAt", "finishedAt", "ok", "error", "faresFetched", "dealsFound",
                             "serpapiUsedThisMonth", "serpapiBudget"), run))
        last_run["ok"] = bool(last_run["ok"])
    else:                       # history from before runs were recorded: only the time is known
        at = conn.execute("SELECT MAX(checked_at) FROM observations").fetchone()[0]
        last_run = {"startedAt": at, "finishedAt": at, "ok": None, "error": None, "faresFetched": None,
                    "dealsFound": None, "serpapiUsedThisMonth": None, "serpapiBudget": None}

    destinations = []
    for code, target in cfg["destinations"].items():
        latest = conn.execute("SELECT MAX(checked_at) FROM observations WHERE dest=?", (code,)).fetchone()[0]
        current, monthly = None, []
        if latest:
            rows = conn.execute(
                "SELECT month, origin, price, depart_at, return_at, airline, transfers FROM observations"
                " WHERE dest=? AND checked_at=? AND month >= ? ORDER BY price", (code, latest, months[0])
            ).fetchall()
            per_month = {}
            for r in rows:
                per_month.setdefault(r[0], r[2])
            monthly = [{"month": m, "low": per_month.get(m)} for m in months]
            if rows:
                month, origin, price, dep, ret, airline, stops = rows[0]
                dep, ret = (dep or "")[:10] or None, (ret or "")[:10] or None
                since = (now - timedelta(days=recheck)).isoformat()
                live = _live_for(conn, code, origin, dep, ret, since)
                current = {"price": price, "origin": origin, "departDate": dep, "returnDate": ret,
                           "stops": stops, "airline": airline, "verified": live is not None,
                           "livePrice": live,
                           "link": google_flights_link(origin, code, {"departure_at": dep, "return_at": ret}),
                           "alternates": _alternates(conn, cfg, code, origin, dep, ret, since)}
        else:
            monthly = [{"month": m, "low": None} for m in months]
        cut90 = (now - timedelta(days=90)).strftime("%Y-%m-%d")
        history = [{"date": d_, "low": p} for d_, p in conn.execute(
            "SELECT substr(checked_at,1,10) AS d, MIN(price) FROM observations WHERE dest=?"
            " AND substr(checked_at,1,10) >= ? GROUP BY d ORDER BY d", (code, cut90))]
        cut30 = (now - timedelta(days=30)).strftime("%Y-%m-%d")
        lows30 = [h["low"] for h in history if h["date"] >= cut30]
        by_origin = {o: _origin_view(conn, code, o, latest, months, cut90, cut30, now, recheck)
                     for o in cfg.get("origins") or []}
        destinations.append({"code": code, "name": place(code, names), "target": target,
                             "median30": statistics.median(lows30) if lows30 else None,
                             "currentLow": current, "history": history, "monthly": monthly,
                             "byOrigin": by_origin})

    # Active deals: the latest alert per destination+month inside the re-alert cooldown,
    # departing in the future. Heads-up event checks above target are not deals.
    since = (now - timedelta(days=cooldown)).isoformat()
    rows = conn.execute(
        "SELECT id, sent_at, dest, month, origin, price, verified, click, deal_json FROM sent_alerts s"
        " WHERE sent_at >= ? AND id = (SELECT MAX(id) FROM sent_alerts t WHERE t.dest=s.dest"
        " AND t.month=s.month)", (since,)).fetchall()
    targets = cfg["destinations"]
    events = {event_key(ev): ev for ev in cfg.get("events") or []}
    deals = []
    for i, sent_at, code, month, origin, price, verified, click, dj in rows:
        info = json.loads(dj) if dj else {}
        if info.get("infoOnly"):
            continue
        if not dj:              # sent before deal_json existed: fill in from that run's fare
            ob = conn.execute("SELECT depart_at, return_at, transfers, link FROM observations"
                              " WHERE dest=? AND month=? AND origin=? AND checked_at=?",
                              (code, month, origin, sent_at)).fetchone()
            if ob:
                info = {"departDate": (ob[0] or "")[:10] or None, "returnDate": (ob[1] or "")[:10] or None,
                        "stops": ob[2], "bags": bags_text({"link": ob[3]})}
            if verified:
                info["livePrice"] = price
        if info.get("median30") is None:
            info["median30"] = next((x["median30"] for x in destinations if x["code"] == code), None)
        dep = info.get("departDate") or (events.get(month) or {}).get("depart")
        if (dep and dep < today) or (not dep and month and not month.startswith("event:") and month < months[0]):
            continue
        target = info.get("target") or targets.get(code) or (events.get(month) or {}).get("target")
        deals.append({"id": i, "code": code, "name": place(code, names), "origin": info.get("origin", origin),
                      "price": info.get("price", price), "target": target, "median30": info.get("median30"),
                      "departDate": dep, "returnDate": info.get("returnDate"),
                      "verified": bool(info.get("verified", verified)), "livePrice": info.get("livePrice"),
                      "stops": info.get("stops"), "bags": info.get("bags"), "weather": info.get("weather"),
                      "link": info.get("link") or click, "foundAt": sent_at,
                      "event": info.get("event") or (events.get(month) or {}).get("name")})
    # The latest live check on a deal's dates (from its origin) outranks the price it was sent at.
    checked_since = (now - timedelta(days=DISPROVED_DAYS)).isoformat()
    still = []
    for d in deals:
        row = None
        if d["departDate"] and not d["event"]:
            row = conn.execute(
                "SELECT price FROM live_checks WHERE dest=? AND origin=? AND depart_date=?"
                " AND return_date IS ? AND checked_at >= ? AND price IS NOT NULL"
                " ORDER BY checked_at DESC LIMIT 1",
                (d["code"], d["origin"], d["departDate"], d["returnDate"], checked_since)).fetchone()
        if row:
            if d["target"] is not None and row[0] > d["target"]:
                continue                        # disproved: no longer a deal
            d["livePrice"], d["verified"] = row[0], True
        still.append(d)
    deals = still
    live_since = (now - timedelta(days=recheck)).isoformat()
    for d in deals:
        d["alternates"] = _alternates(conn, cfg, d["code"], d["origin"], d["departDate"], d["returnDate"],
                                      live_since, live_since=since)
    deals.sort(key=lambda d: (d["price"] or 0) / (d["target"] or d["price"] or 1))

    recent = [{"sentAt": s, "title": t, "body": b} for s, t, b in conn.execute(
        "SELECT sent_at, title, message FROM sent_alerts ORDER BY id DESC LIMIT 20")]
    return {"generatedAt": now.isoformat(), "currency": cfg.get("currency", "usd").upper(),
            "lastRun": last_run, "destinations": destinations, "deals": deals, "recentAlerts": recent}


def export_summary(cfg, db_path, path):
    """Write the summary JSON atomically (tmp file + rename) so the widget never reads half a file."""
    if not os.path.exists(db_path):
        log("summary skipped: no %s yet" % db_path)
        return False
    conn = open_db(db_path)                 # adds any missing tables/columns, then reads only
    conn.commit()
    conn.execute("PRAGMA query_only = ON")
    try:
        summary = build_summary(cfg, conn)
    finally:
        conn.close()
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1)
    os.replace(tmp, path)
    log("summary written: %s" % path)
    return True


# ----------------------------------------------------------------- main
def add_live_prices(cfg, conn, deals, compare, dry_run, now, drop, window):
    """Attach live Google Flights prices to the best deals, within the SerpApi budget."""
    lcfg = cfg.get("live_check", {})
    now_iso = now.isoformat()
    if lcfg.get("require_live_confirmation", True):
        # Don't spend searches re-confirming a stale cached fare we already saw was gone.
        for d in deals:
            rej = recent_live_rejection(cfg, conn, d, now, drop, window)
            if rej:
                d["recent_reject"] = rej
        deals = [d for d in deals if "recent_reject" not in d]
        if not deals:
            return
    key = os.environ.get("SERPAPI_KEY", "").strip()
    if not key:
        log("live check skipped: SERPAPI_KEY not set")
        return
    budget = int(lcfg.get("max_searches_per_run", 6))
    left = serpapi_searches_left(key)
    if left is not None:
        budget = min(budget, max(0, left - int(lcfg.get("reserve_searches", 10))))
    origins = lcfg.get("origins") or compare
    log("live Google Flights check: budget %d search(es) this run, %s left this month" % (
        budget, "?" if left is None else left))
    for d in deals:                                  # deals are sorted best-first
        for o in origins:
            if budget <= 0:
                return
            budget -= 1
            try:
                lv = live_price(key, o, d["dest"], d["fare"], cfg.get("currency", "usd"))
            except Exception as ex:
                log("live check %s-%s failed: %s" % (o, d["dest"], ex))
                continue
            d.setdefault("live", {})[o] = lv
            log("      live %s->%s %s: %s" % (o, d["dest"], lv["depart"],
                                              "$%d" % lv["price"] if lv["price"] else "no flights"))
            if not dry_run:
                cached = (d.get("by_origin", {}).get(o) or {}).get("price")
                record_live(conn, o, d["dest"], lv, cached, now_iso)


def origin_allowances(cfg):
    """Extra $ you'll pay over the destination target to fly from a given airport (e.g. SMF)."""
    return {o: float(v) for o, v in (cfg.get("origin_allowance") or {}).items()}


def allowance_reason(origin, threshold, extra):
    return "%s under $%d (target + $%d)" % (origin, threshold + extra, extra)


def live_verdict(cfg, d, priced, drop, window):
    """Best qualifying live price as (price, origin, reason, effective_target), or None.
    priced: [(price, origin)]. Any airport qualifies under target (+leeway) or by the
    median rule; an airport with an allowance also qualifies under target + allowance."""
    leeway = float(cfg.get("live_check", {}).get("confirm_leeway", 0.0))
    thr = d["threshold"]
    target = thr * (1 + leeway) if thr is not None else None
    for p, o in sorted(priced):
        if evaluate(p, target, d.get("median"), drop, window):
            reason = evaluate(p, thr, d.get("median"), drop, window) \
                or "within %d%% of your $%d target" % (round(leeway * 100), thr)
            return p, o, reason, thr
    if thr is not None:
        allow = origin_allowances(cfg)
        for p, o in sorted(priced):
            if o in allow and p <= target + allow[o]:
                reason = allowance_reason(o, thr, allow[o])
                if p > thr + allow[o]:
                    reason = "%s within %d%% of $%d (target + $%d)" % (
                        o, round(leeway * 100), thr + allow[o], allow[o])
                return p, o, reason, thr + allow[o]
    return None


DISPROVED_DAYS = 14   # a live check this recent outranks a cached fare on the same dates


def live_disproved(conn, dest, origin, dep, ret, target, now, days=DISPROVED_DAYS):
    """(price, checked_at) of the latest live check from `origin` for these exact dates in the
    last `days` days if it was above `target`; None if there's none or it qualified."""
    if not dep or target is None:
        return None
    since = (now - timedelta(days=days)).isoformat()
    try:
        row = conn.execute(
            "SELECT price, checked_at FROM live_checks WHERE dest=? AND origin=? AND depart_date=?"
            " AND return_date IS ? AND checked_at >= ? AND price IS NOT NULL"
            " ORDER BY checked_at DESC LIMIT 1", (dest, origin, dep, ret or None, since)).fetchone()
    except sqlite3.OperationalError:          # dry run against a db without live_checks yet
        return None
    return row if row and row[0] > target else None


def recent_live_rejection(cfg, conn, d, now, drop, window):
    """If these exact dates were live-checked in the last few days and did NOT qualify,
    return (price or None, checked_at) so we can skip without spending searches."""
    days = int(cfg.get("live_check", {}).get("recheck_after_days", 3))
    if days <= 0:
        return None
    f = d["fare"]
    dep, ret = (f.get("departure_at") or "")[:10], (f.get("return_at") or "")[:10] or None
    cutoff = (now - timedelta(days=days)).isoformat()
    try:
        rows = conn.execute(
            "SELECT origin, price, checked_at FROM live_checks WHERE dest=? AND depart_date=?"
            " AND return_date IS ? AND checked_at >= ?", (d["dest"], dep, ret, cutoff)).fetchall()
    except sqlite3.OperationalError:          # dry run against a db without live_checks yet
        return None
    if not rows:
        return None
    priced = [(p, o) for o, p, _ in rows if p is not None]
    last = max(c for _, _, c in rows)
    if not priced:                             # Google had no flights at all for these dates
        return None, last
    if live_verdict(cfg, d, priced, drop, window):
        return None                            # it qualified then; don't block it now
    return min(priced)[0], last


def confirm_with_live(cfg, deals, drop, window):
    """Drop deals whose live price (cheapest across checked airports) no longer qualifies.
    Deals without a live price are kept, so a failed/over-budget check never hides an alert.
    Dropped deals aren't recorded as alerted, so they can still alert on a later run."""
    if not cfg.get("live_check", {}).get("require_live_confirmation", True):
        return deals
    kept = []
    for d in deals:
        if "recent_reject" in d:
            p, when = d["recent_reject"]
            log("skipped %s %s: cached $%d, but live check on %s found %s (target $%d); "
                "not re-checking yet" % (d["dest"], d["month"], d["price"], when[:10],
                                         "$%d" % p if p is not None else "no flights",
                                         d["threshold"] or 0))
            continue
        priced = [(lv["price"], o) for o, lv in (d.get("live") or {}).items() if lv.get("price") is not None]
        verdict = live_verdict(cfg, d, priced, drop, window) if priced else None
        if not priced:
            kept.append(d)
        elif verdict:
            # Headline the price you'll actually see on Google Flights, not the cached one.
            d["live_best"] = (verdict[0], verdict[1])
            d["reason"], d["eff_target"] = verdict[2], verdict[3]
            kept.append(d)
        else:
            log("skipped %s %s: cached $%d but live price now $%d (target $%d)" % (
                d["dest"], d["month"], d["price"], min(priced)[0], d["threshold"] or 0))
    return kept


def event_key(ev):
    """Stable id used in place of a month for an event's alert/dedupe rows."""
    return "event:" + re.sub(r"[^a-z0-9]+", "-", ev["name"].lower()).strip("-")


def check_events(cfg, conn, dry_run, now, drop, window, realert, cooldown, allow):
    """Fixed-date trips (e.g. Oktoberfest) checked directly on Google Flights on a schedule.
    Travelpayouts rarely has fares that far out, so these don't depend on cached data.
    Returns deals to send: target met, or the very first price check (info only)."""
    events = cfg.get("events") or []
    if not events:
        return []
    es, lcfg = cfg.get("event_settings", {}), cfg.get("live_check", {})
    every = float(es.get("check_every_days", 3.5))
    horizon = int(es.get("horizon_days", 330))
    origins = lcfg.get("origins") or cfg.get("compare_origins") or ["SFO"]
    key = os.environ.get("SERPAPI_KEY", "").strip()
    if not key:
        log("event watch skipped: SERPAPI_KEY not set")
        return []
    now_iso, today = now.isoformat(), now.date()
    left, reserve = None, int(lcfg.get("reserve_searches", 10))
    out = []
    for ev in events:
        dep, ret = ev["depart"], ev.get("return")
        days_out = (date.fromisoformat(dep) - today).days
        if days_out <= 0:
            continue
        if days_out > horizon:
            log("%s: Google Flights should open these dates around %s" % (
                ev["name"], (date.fromisoformat(dep) - timedelta(days=horizon)).isoformat()))
            continue
        try:
            last = conn.execute("SELECT MAX(checked_at) FROM live_checks WHERE dest=? AND depart_date=?"
                                " AND return_date IS ?", (ev["dest"], dep, ret)).fetchone()[0]
        except sqlite3.OperationalError:
            last = None
        if last and now - datetime.fromisoformat(last) < timedelta(days=every):
            continue
        if left is None:
            left = serpapi_searches_left(key)
        if left is not None and left - reserve < len(origins):
            log("%s: skipped, SerpApi quota too low (%d left)" % (ev["name"], left))
            continue
        fare = {"departure_at": dep, "return_at": ret}
        live = {}
        log("%s: checking Google Flights %s ..." % (ev["name"], trip_dates(dep, ret)))
        for o in origins:
            try:
                lv = live_price(key, o, ev["dest"], fare, cfg.get("currency", "usd"))
            except Exception as ex:
                log("      live %s->%s failed: %s" % (o, ev["dest"], ex))
                continue
            if left is not None:
                left -= 1
            live[o] = lv
            log("      live %s->%s: %s" % (o, ev["dest"], "$%d" % lv["price"] if lv["price"] else "no flights"))
            if not dry_run:
                record_live(conn, o, ev["dest"], lv, None, now_iso)
        priced = [(lv["price"], o) for o, lv in live.items() if lv.get("price") is not None]
        if not priced:
            continue
        d = {"dest": ev["dest"], "month": event_key(ev), "event": ev["name"], "event_tag": ev.get("tag"),
             "origin": min(priced)[1], "price": min(priced)[0], "threshold": float(ev["target"]),
             "eff_target": float(ev["target"]), "fare": fare, "live": live, "by_origin": {},
             "median": None, "allow": allow, "needs_live": False, "av_link": None}
        verdict = live_verdict(cfg, d, priced, drop, window)
        if verdict:
            if not should_alert(conn, d["dest"], d["month"], verdict[0], realert, cooldown, now):
                log("%s: $%d still under target, already alerted" % (ev["name"], verdict[0]))
                continue
            d["live_best"] = (verdict[0], verdict[1])
            d["reason"], d["eff_target"] = verdict[2], verdict[3]
        elif not last:
            # First look at these dates: worth one heads-up even above target.
            d["live_best"] = min(priced)
            d["reason"] = "first price check: above your $%d target" % d["threshold"]
            d["info_only"] = True
        else:
            log("%s: cheapest $%d from %s, above $%d target" % (ev["name"], min(priced)[0],
                                                              min(priced)[1], d["threshold"]))
            continue
        d["gf_link"] = live[d["live_best"][1]].get("url") or google_flights_link(d["live_best"][1], d["dest"], fare)
        out.append(d)
    return out


def run(cfg, db_path, dry_run=False, fetch=fetch_fares, now=None, live_in_dry_run=False):
    now = now or datetime.now(timezone.utc).replace(microsecond=0)
    now_iso = now.isoformat()
    today_str = now.strftime("%Y-%m-%d")
    currency = cfg.get("currency", "usd")
    months = month_list(int(cfg.get("months_ahead", 6)), now.date())
    delay = float(cfg.get("request_delay_sec", 0.5))
    a = cfg.get("alerting", {})
    drop = float(a.get("drop_vs_median", 0.25))
    window = int(a.get("history_window_days", 30))
    min_days = int(a.get("min_history_days", 7))
    realert = float(a.get("realert_drop", 0.05))
    cooldown = int(a.get("realert_cooldown_days", 14))
    max_alerts = int(a.get("max_alerts_per_run", 8))

    compare = [o for o in cfg.get("compare_origins", ["SFO", "SMF"])]
    names = cfg.get("place_names") or {}

    conn = open_db(db_path, read_only=dry_run)
    best = {}        # (dest, month) -> cheapest candidate across origins
    by_origin = {}   # (dest, month) -> {origin: fare}, for side-by-side comparison
    calls = errors = 0
    dests = list(cfg["destinations"].items())
    queries = months if per_month_queries(cfg) else [None]    # None = all months in one call
    log("start: %d destinations x %d airports%s = %d lookups%s" % (
        len(dests), len(cfg["origins"]), " x %d months" % len(months) if queries[0] else "",
        len(dests) * len(cfg["origins"]) * len(queries), " (dry run)" if dry_run else ""))

    for i, (dest, threshold) in enumerate(dests, 1):
        log("[%d/%d] %s (%s), target $%d ..." % (i, len(dests), place(dest, names), dest, threshold))
        found = 0
        for origin in cfg["origins"]:
            for qmonth in queries:
                calls += 1
                try:
                    got = fetch(cfg, origin, dest, qmonth) or []
                except Exception as ex:
                    errors += 1
                    log("fetch %s-%s %s failed: %s" % (origin, dest, qmonth or "all months", ex))
                    got = []
                if isinstance(got, dict):            # single-fare fetchers (tests)
                    got = [got]
                if delay:
                    time.sleep(delay)
                for month in ([qmonth] if qmonth else months):
                    fares = [f for f in got if (f.get("departure_at") or "")[:7] == month]
                    if not fares:
                        continue
                    fare = min(fares, key=lambda f: float(f["price"]))
                    price = float(fare["price"])
                    found += len(fares)
                    if not dry_run:
                        record_fares(conn, origin, dest, month, fares, currency, now_iso)
                        record_observation(conn, origin, dest, month, fare, currency, now_iso)
                    key = (dest, month)
                    by_origin.setdefault(key, {})[origin] = fare
                    if key not in best or price < best[key]["price"]:
                        best[key] = {"origin": origin, "dest": dest, "month": month,
                                     "price": price, "threshold": threshold, "fare": fare}
        RUN_STATS["fares_fetched"] = RUN_STATS.get("fares_fetched", 0) + found
        cands = [c for (d_, _), c in best.items() if d_ == dest]
        if cands:
            lo = min(cands, key=lambda c: c["price"])
            log("      %d fares found; cheapest $%d from %s departing %s%s" % (
                found, lo["price"], lo["origin"], lo["month"],
                "  <-- under target" if lo["price"] <= threshold else ""))
        else:
            log("      no fares found")

    log("checking for deals ...")
    deals = []
    allow = origin_allowances(cfg)
    for (dest, month), c in best.items():
        median = rolling_median(conn, dest, month, window, min_days, today_str)
        reason = evaluate(c["price"], c["threshold"], median, drop, window)
        c["eff_target"] = c["threshold"]
        if not reason and c["threshold"] is not None:
            # No deal from the cheapest airport; a closer airport may still be worth it
            # within its allowance (e.g. SMF up to target + $250).
            for o, extra in allow.items():
                of = by_origin.get((dest, month), {}).get(o)
                if of and float(of["price"]) <= c["threshold"] + extra:
                    c = dict(c, origin=o, price=float(of["price"]), fare=of,
                             eff_target=c["threshold"] + extra)
                    reason = allowance_reason(o, c["threshold"], extra)
                    break
        if dry_run:
            log("%s (%s) %s best $%d from %s  median=%s  %s" % (
                dest, place(dest, names), month, c["price"], c["origin"],
                "n/a" if median is None else "$%d" % median, reason or ""))
        status = should_alert(conn, dest, month, c["price"], realert, cooldown, now) if reason else False
        if status:
            c["needs_live"] = status == "verify"
            c["reason"] = reason
            c["median"] = median
            c["by_origin"] = by_origin.get((dest, month), {})
            c["gf_link"] = google_flights_link(c["origin"], dest, c["fare"])
            c["av_link"] = aviasales_link(c["fare"])
            c["allow"] = allow
            deals.append(c)

    # Best deals first: lowest price relative to the (allowance-adjusted) target.
    deals.sort(key=lambda d: d["price"] / (d["eff_target"] or d["price"]))
    deals = deals[:max_alerts]

    if deals and cfg.get("live_check", {}).get("enabled", True):
        if dry_run and not live_in_dry_run:
            log("live check skipped in dry run (add --live to spend SerpApi searches)")
        else:
            add_live_prices(cfg, conn, deals, compare, dry_run, now, drop, window)
            deals = confirm_with_live(cfg, deals, drop, window)
    # Already sent unverified: only worth re-sending once a live check confirms it.
    held = [d for d in deals if d.get("needs_live") and not d.get("live_best")]
    for d in held:
        log("held %s %s: already sent unverified at ~$%d; waiting for a live check" % (
            d["dest"], d["month"], d["price"]))
    deals = [d for d in deals if d not in held]
    # Not live-checked this run (budget/skip), but checked recently on these dates and too dear:
    # don't push the stale cached price as an unverified deal.
    kept = []
    for d in deals:
        f = d["fare"]
        target = d.get("eff_target") or d["threshold"]
        rej = None if d.get("live_best") else live_disproved(
            conn, d["dest"], d["origin"], (f.get("departure_at") or "")[:10],
            (f.get("return_at") or "")[:10] or None, target, now)
        if rej:
            log("held %s %s: cached $%d, but live check on %s found $%d (target $%d)" % (
                d["dest"], d["month"], d["price"], rej[1][:10], rej[0], target))
        else:
            kept.append(d)
    deals = kept

    # Fixed-date event trips (e.g. Oktoberfest), checked on Google Flights on their own schedule.
    if cfg.get("events"):
        if dry_run and not live_in_dry_run:
            log("event watch skipped in dry run (add --live to spend SerpApi searches)")
        else:
            deals += check_events(cfg, conn, dry_run, now, drop, window, realert, cooldown, allow)

    # Weather last, so skipped/held deals don't cost lookups.
    wcfg = cfg.get("weather", {})
    if deals and wcfg.get("enabled", True):
        log("looking up typical weather for %d deal(s) ..." % len(deals))
        for d in deals:
            try:
                wd = {}
                d["weather"] = trip_weather(d["dest"], d["fare"], wcfg, names, wd)
                d["weather_data"] = wd or None
            except Exception as ex:          # weather is a nice-to-have; never block an alert
                log("weather lookup for %s failed: %s" % (d["dest"], ex))

    # Chart image, best available: Google's 60-day history for the exact dates, else our
    # own saved daily prices (once enough days exist), else price by departure month.
    ccfg = cfg.get("charts", {})
    if deals and ccfg.get("enabled", True):
        for d in deals:
            d["month_prices"] = {m: {o: float(f["price"]) for o, f in by_origin.get((d["dest"], m), {}).items()}
                                 for m in months}
            try:
                d["chart"] = (history_chart(d)
                              or own_history_chart(conn, d, compare, names,
                                                   int(ccfg.get("min_own_history_days", 7)), now=now)
                              or month_chart(d, months, compare, names))
            except Exception as ex:
                log("chart for %s failed: %s" % (d["dest"], ex))

    sent = 0
    for d in deals:
        body = format_deal(d, compare, names, links=False)
        actions = deal_actions(d, compare)
        city = place(d["dest"], names).split(",")[0]
        if d.get("info_only"):
            title = "%s: first prices, $%d from %s (live)" % (d["event"], d["live_best"][0], d["live_best"][1])
        elif d.get("event"):
            title = "%s: $%d from %s (live)" % (d["event"], d["live_best"][0], d["live_best"][1])
        elif d.get("live_best"):
            title = "%s $%d from %s (%s, live)" % (city, d["live_best"][0], d["live_best"][1], d["month"])
        else:
            title = "%s ~$%d from %s (%s, unverified)" % (city, d["price"], d["origin"], d["month"])
        style = push_style(d, cfg.get("notify", {}))
        if d.get("chart"):
            style.update(attach=d["chart"], filename="price-chart.png")
        if dry_run:
            print("\n--- WOULD ALERT ---\n[%s, priority %d]\n%s\n%s\nButtons: %s\nChart: %s" % (
                ", ".join(style["tags"]), style["priority"], title, body,
                " | ".join(label for label, _ in actions), d.get("chart") or "none"))
            continue
        # Record the alert only after a channel confirms delivery, so a failed
        # push doesn't silently suppress tomorrow's retry.
        email_body = format_deal(d, compare, names)
        if send(cfg.get("notify", {}), title, body, click=d["gf_link"], actions=actions,
                email_body=email_body, push=style):
            if not d.get("info_only"):         # a heads-up mustn't block the real deal alert
                record_alert(conn, d, now_iso)
            record_sent(conn, d, title, body, email_body, d["gf_link"], actions, style, now_iso)
            sent += 1
            log("alert sent: " + title)
        else:
            log("alert NOT delivered: " + title)
    if not deals:
        log("no new deals to alert on")

    RUN_STATS["deals_found"] = len(deals)
    if not dry_run:
        conn.commit()
    conn.close()
    log("done:%d calls, %d errors, %d route-months with data, %d deals, %d alerts sent%s"
        % (calls, errors, len(best), len(deals), sent, " (dry run, nothing written)" if dry_run else ""))
    return deals


def warn_if_stale(cfg, db_path, now, hours=36):
    """Push a warning when the last successful run is older than `hours` (Pi off, crashes...)."""
    if not os.path.exists(db_path):
        return
    conn = sqlite3.connect(db_path)
    try:
        last = conn.execute("SELECT MAX(finished_at) FROM runs WHERE ok=1").fetchone()[0]
    except sqlite3.OperationalError:
        last = None
    finally:
        conn.close()
    if not last or now - datetime.fromisoformat(last) <= timedelta(hours=hours):
        return
    local = datetime.fromisoformat(last).astimezone().strftime("%a %b %d %H:%M")
    log("last successful run was %s; sending a warning" % local)
    send(cfg.get("notify", {}), "Farewatcher: no successful run since %s" % local,
         "The previous good fare check was more than %d hours ago (Pi off, or runs failing). "
         "This run is starting now." % hours, push={"tags": ["warning"], "priority": 3})


def notify_failure(cfg, unit, log_path):
    """Called by fare_watch-alert@.service when a Farewatcher unit fails."""
    tail = ""
    if log_path and os.path.exists(log_path):
        with open(log_path, encoding="utf-8", errors="replace") as f:
            tail = "".join(f.readlines()[-8:]).strip()
    body = "%s failed on the Pi. Check: journalctl -u %s" % (unit, unit)
    if tail:
        body += "\n\nLast log lines:\n" + tail
    return send(cfg.get("notify", {}), "Farewatcher run FAILED", body,
                push={"tags": ["rotating_light"], "priority": 4})


def backup_db(db_path, dest_dir, keep=14):
    """Consistent copy via SQLite's online backup API, one file per day; keeps the newest `keep`."""
    os.makedirs(dest_dir, exist_ok=True)
    out = os.path.join(dest_dir, "fares-%s.db" % date.today().isoformat())
    tmp = out + ".tmp"
    src = sqlite3.connect("file:%s?mode=ro" % db_path, uri=True)
    dst = sqlite3.connect(tmp)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    os.replace(tmp, out)
    old = sorted(f for f in os.listdir(dest_dir) if re.fullmatch(r"fares-\d{4}-\d{2}-\d{2}\.db", f))
    for f in old[:-keep]:
        os.remove(os.path.join(dest_dir, f))
    log("backup written: %s (%d kept)" % (out, min(len(old), keep)))
    return out


def main():
    p = argparse.ArgumentParser(description="Cheap fare watcher")
    p.add_argument("--config", default=os.path.join(HERE, "config.json"))
    p.add_argument("--db", default=os.path.join(HERE, "fares.db"))
    p.add_argument("--dry-run", action="store_true", help="fetch and print only; write nothing")
    p.add_argument("--test-notify", action="store_true", help="send a test notification and exit")
    p.add_argument("--list-sent", nargs="?", type=int, const=20, metavar="N",
                   help="list the last N saved alerts (default 20) with their ids")
    p.add_argument("--resend", nargs="+", metavar="ID",
                   help="re-send saved alerts by id, or 'last' for the most recent run's alerts "
                        "(no flight/weather API calls)")
    p.add_argument("--export-summary", action="store_true",
                   help="only rewrite the PiDisplay summary JSON (env FARE_WATCH_SUMMARY) from fares.db")
    p.add_argument("--live", action="store_true",
                   help="with --dry-run: also do the live Google Flights check (uses SerpApi quota)")
    p.add_argument("--log", help="also append log lines to this file (console output is kept)")
    p.add_argument("--backup", metavar="DIR",
                   help="write a dated backup of fares.db into DIR (keeps 14) and exit; no config needed")
    p.add_argument("--notify-failure", metavar="UNIT",
                   help="push a 'run failed' alert for this systemd unit and exit (used by OnFailure)")
    p.add_argument("--hold", type=int, default=0,
                   help="keep the console window open this many seconds after finishing")
    args = p.parse_args()

    global LOG_FILE
    LOG_FILE = args.log
    # Alert text has emoji; don't crash when the console/pipe can't encode them.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(errors="replace")
        except (AttributeError, ValueError):
            pass
    code = 0
    started = time.time()
    started_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat()
    summary_path = os.environ.get("FARE_WATCH_SUMMARY", "").strip()
    normal_run = not (args.export_summary or args.list_sent is not None or args.resend
                      or args.test_notify or args.dry_run or args.notify_failure)
    cfg, error = None, None
    if args.backup:
        try:
            backup_db(args.db, args.backup)
        except Exception as ex:
            log("backup FAILED: %s" % ex)
            sys.exit(1)
        sys.exit(0)
    try:
        cfg = load_config(args.config, need_token=not (args.export_summary or args.notify_failure))
        if args.notify_failure:
            ok = notify_failure(cfg, args.notify_failure, os.path.join(HERE, "fare_watch.log"))
            code = 0 if ok else 1
        elif args.export_summary:
            if not summary_path:
                sys.exit("FARE_WATCH_SUMMARY is not set")
            code = 0 if export_summary(cfg, args.db, summary_path) else 1
        elif args.list_sent is not None or args.resend:
            conn = open_db(args.db)
            if args.list_sent is not None:
                list_sent(conn, args.list_sent)
            if args.resend:
                code = 0 if resend_alerts(conn, cfg.get("notify", {}), args.resend) else 1
            conn.close()
        elif args.test_notify:
            ok = send(cfg.get("notify", {}), "fare_watch test", "If you see this, alerts work.")
            log("test notification " + ("sent" if ok else "FAILED - check config"))
            code = 0 if ok else 1
        else:
            if normal_run:
                try:
                    warn_if_stale(cfg, args.db, datetime.now(timezone.utc))
                except Exception as ex:
                    log("stale-run check failed: %s" % ex)
            run(cfg, args.db, dry_run=args.dry_run, live_in_dry_run=args.live)
    except SystemExit as ex:
        log("stopped: %s" % ex)
        code, error = 1, str(ex)
    except Exception as ex:
        import traceback
        log("CRASHED:\n" + traceback.format_exc())
        code, error = 1, "%s: %s" % (type(ex).__name__, ex)
    if not args.list_sent and not args.export_summary and not args.notify_failure:
        try:
            usage_summary(started)
        except Exception as ex:               # never let the summary hide the real result
            log("usage summary failed: %s" % ex)
    if normal_run:                            # status + widget snapshot, even after a failure
        try:
            record_run(args.db, started_iso, code == 0, error)
            if summary_path and cfg:
                export_summary(cfg, args.db, summary_path)
        except Exception as ex:
            log("PiDisplay summary failed: %s" % ex)
    if args.hold:
        print("\nClosing in %d seconds..." % args.hold, flush=True)
        time.sleep(args.hold)
    sys.exit(code)


if __name__ == "__main__":
    main()
