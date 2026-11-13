"""Derived numbers for the dashboard. Warmup sets never count.

- e1RM (Epley): weight * (1 + reps / 30), only for 1-12 reps with a weight. For a
  mechanical drop set only the first segment counts (the later segments are the same
  weight after a grip switch, so they'd only understate it).
- Top-set weight: heaviest working set of the exercise in the session.
- A single (1 rep) counts as its own weight. Sets marked inferred (assumed numbers) are
  charted but never claim a PR.
- PR: a session's best e1RM beats every earlier session of that exercise, or a set beats
  the heaviest weight earlier lifted for at least as many reps (if it's the most reps
  ever, it must at least match the heaviest weight ever). An exercise's first session
  only sets the baseline.
- Stall: the best e1RM of the last 3 sessions is no higher than before them.
- Effort: with reps in reserve (rir, or 10 - rpe) the estimate uses reps + reps left,
  since 8 reps with 2 left is a 10-rep weight. Estimates from more than 10 (effective)
  reps are marked rough: the formulas drift up there.
- Volume: working sets per muscle group per week (Monday start); the segments of one
  mechanical drop set count as one set. An exercise's secondary muscle groups get half
  a set each (fractional set counting); week totals count each set once.
Exercises are compared per name + variation, as stored. Every number is for one person
(pid); the exercise list itself is shared by everyone.
"""
from __future__ import annotations

import sqlite3
from collections import defaultdict
from datetime import date as Date, timedelta

EPS = 1e-6
RIM_IN = 120.0
CM_PER_IN = 2.54


ROUGH_REPS = 10  # estimates from more reps than this are flagged as rough
DOUBLED = ("per_hand", "per_arm", "per_side")  # weight is one side's load: total is twice


def epley(weight: float | None, reps: float | None) -> float | None:
    if weight is None or reps is None or reps < 1 or reps > 12 or weight <= 0:
        return None
    if reps == 1:
        return float(weight)  # a single is the 1RM itself; Epley would add 3.3%
    return weight * (1 + reps / 30)


def set_e1rm(row) -> float | None:
    if row["set_type"] == "warmup" or (row["set_type"] == "mechanical_drop" and row["segment"] > 1):
        return None
    return epley(row["weight_lb"], effective_reps(row))


def reserve(row) -> float:
    """Reps left in the tank: rir as logged, else 10 - rpe, else 0."""
    if row["rir"] is not None:
        return max(0.0, row["rir"])
    if row["rpe"] is not None:
        return max(0.0, 10 - row["rpe"])
    return 0.0


def effective_reps(row) -> float | None:
    return row["reps"] + reserve(row) if row["reps"] else row["reps"]


def is_rough(row) -> bool:
    return (effective_reps(row) or 0) > ROUGH_REPS


def credits(rows) -> dict[str, dict[tuple, float]]:
    """group -> {set key: credit}: 1 for the exercise's own muscle group, 0.5 for each secondary."""
    out: dict[str, dict[tuple, float]] = defaultdict(dict)
    for r in rows:
        key = (r["session_id"], r["exercise_id"], r["set_number"])
        primary = r["muscle_group"] or "Other"
        out[primary][key] = 1.0
        for g in (r["secondary"] or "").split(","):
            g = g.strip()
            if g and g != primary:
                out[g].setdefault(key, 0.5)
    return out


def _total(sets: dict[tuple, float] | None) -> float:
    return sum(sets.values()) if sets else 0


def _rows(conn: sqlite3.Connection, pid: int, where: str = "", params: tuple = ()) -> list[sqlite3.Row]:
    return conn.execute(
        f"""SELECT s.*, ss.date, ss.day_label, e.name, e.variation, e.muscle_group, e.secondary
            FROM sets s JOIN sessions ss ON ss.id = s.session_id JOIN exercises e ON e.id = s.exercise_id
            WHERE s.set_type != 'warmup' AND ss.person_id = ? {where}
            ORDER BY ss.date, ss.id, s.set_number, s.segment""",
        (pid, *params),
    ).fetchall()


def _label(name: str, variation: str) -> str:
    return f"{name} ({variation})" if variation else name


def history(conn: sqlite3.Connection, pid: int, exercise_id: int | None = None, name: str | None = None) -> dict:
    """Per exercise: its sessions in order with best e1RM, top set and PR info.

    With name, every variation of that exercise is treated as one lift (key: the name).
    """
    if name:
        rows = _rows(conn, pid, "AND lower(e.name) = lower(?)", (name,))
    elif exercise_id:
        rows = _rows(conn, pid, "AND s.exercise_id = ?", (exercise_id,))
    else:
        rows = _rows(conn, pid)
    by_ex: dict = {}
    for r in rows:
        key = r["name"].lower() if name else r["exercise_id"]
        ex = by_ex.setdefault(key, {
            "exercise_id": None if name else r["exercise_id"], "name": r["name"],
            "variation": "" if name else r["variation"],
            "label": r["name"] if name else _label(r["name"], r["variation"]),
            "muscle_group": r["muscle_group"], "sessions": {},
        })
        ses = ex["sessions"].setdefault(r["session_id"], {
            "session_id": r["session_id"], "date": r["date"], "day_label": r["day_label"], "sets": [],
        })
        ses["sets"].append(r)

    for ex in by_ex.values():
        best_prior: float | None = None
        lifted: list[tuple[int, float]] = []  # (reps, weight) of earlier sessions
        out = []
        for ses in ex["sessions"].values():
            sets = ses.pop("sets")
            scored = [(set_e1rm(r), r) for r in sets]
            with_e = [(e, r) for e, r in scored if e is not None]
            best = max(with_e, key=lambda t: t[0]) if with_e else None
            weighted = [r for r in sets if r["weight_lb"] is not None]
            top = max(weighted, key=lambda r: (r["weight_lb"], r["reps"] or 0)) if weighted else None
            heights = [r["height_in"] for r in sets if r["height_in"] is not None]
            durations = [r["duration_s"] for r in sets if r["duration_s"] is not None]
            entry = {
                "session_id": ses["session_id"], "date": ses["date"], "day_label": ses["day_label"],
                "e1rm": round(best[0], 1) if best else None,
                "e1rm_rough": bool(best and is_rough(best[1])),
                "e1rm_set": {"weight_lb": best[1]["weight_lb"], "reps": best[1]["reps"], "rpe": best[1]["rpe"], "rir": best[1]["rir"]} if best else None,
                "top_weight": top["weight_lb"] if top else None,
                "top_reps": top["reps"] if top else None,
                "max_height_in": max(heights) if heights else None,
                "max_duration_s": max(durations) if durations else None,
                "sets": len({(r["exercise_id"], r["set_number"]) for r in sets}),
                "variations": sorted({r["variation"] for r in sets}),
                "pr": None,
            }
            if out:  # the first session is only a baseline
                kinds: list[str] = []
                pr_set = None
                # Sets with assumed ("inferred") numbers are charted but can't claim a PR.
                real = [(e, r) for e, r in with_e if not r["inferred"]]
                best_real = max(real, key=lambda t: t[0]) if real else None
                # Needs an earlier e1RM to beat: the first scoreable session is the baseline.
                if best_real and best_prior is not None and best_real[0] > best_prior + EPS:
                    kinds.append("e1rm")
                    pr_set = best_real[1]
                rep_prs = []
                for r in sets:
                    if r["weight_lb"] is None or not r["reps"] or r["inferred"] or (r["set_type"] == "mechanical_drop" and r["segment"] > 1):
                        continue
                    at_least = [w for n, w in lifted if n >= r["reps"]]
                    heaviest = max((w for _, w in lifted), default=None)
                    if at_least:
                        beat = r["weight_lb"] > max(at_least) + EPS
                        prev = max(at_least)
                    else:
                        beat = heaviest is not None and r["weight_lb"] >= heaviest - EPS
                        prev = None
                    if beat:
                        rep_prs.append((r, prev))
                if rep_prs:
                    kinds.append("reps")
                    if pr_set is None:
                        pr_set = max(rep_prs, key=lambda t: (t[0]["weight_lb"], t[0]["reps"]))[0]
                if kinds:
                    rep_prev = next((p for r, p in rep_prs if r is pr_set), None)
                    entry["pr"] = {
                        "kinds": kinds,
                        "weight_lb": pr_set["weight_lb"], "reps": pr_set["reps"],
                        "e1rm": round(set_e1rm(pr_set), 1) if set_e1rm(pr_set) else None,
                        "rough": is_rough(pr_set),
                        "previous_e1rm": round(best_prior, 1) if best_prior is not None else None,
                        "previous_weight_at_reps": rep_prev,
                    }
            if best:
                best_prior = best[0] if best_prior is None else max(best_prior, best[0])
            lifted += [(r["reps"], r["weight_lb"]) for r in sets if r["weight_lb"] is not None and r["reps"]
                       and not (r["set_type"] == "mechanical_drop" and r["segment"] > 1)]
            out.append(entry)
        ex["sessions"] = out
        ex["stalled"] = stalled(out)
    return by_ex


def stalled(entries: list[dict]) -> bool:
    vals = [e["e1rm"] for e in entries if e["e1rm"] is not None]
    if len(vals) < 4:
        return False
    return max(vals[-3:]) <= max(vals[:-3]) + EPS


def exercises(conn: sqlite3.Connection, pid: int) -> list[dict]:
    """Every exercise, with this person's session count, last date, latest e1RM and stall flag."""
    hist = history(conn, pid)
    out = []
    for e in conn.execute(
        """SELECT e.*, count(DISTINCT ss.id) AS session_count, max(ss.date) AS last_date,
                  (SELECT count(DISTINCT s2.session_id) FROM sets s2 WHERE s2.exercise_id = e.id) AS all_sessions
           FROM exercises e LEFT JOIN sets s ON s.exercise_id = e.id
           LEFT JOIN sessions ss ON ss.id = s.session_id AND ss.person_id = ?
           GROUP BY e.id ORDER BY e.name, e.variation""",
        (pid,),
    ):
        h = hist.get(e["id"])
        latest = next((x["e1rm"] for x in reversed(h["sessions"]) if x["e1rm"] is not None), None) if h else None
        out.append({
            **dict(e), "label": _label(e["name"], e["variation"]),
            "stalled": bool(h and h["stalled"]), "latest_e1rm": latest,
            "has_e1rm": bool(h and any(x["e1rm"] is not None for x in h["sessions"])),
        })
    return out


def trend_by_name(conn: sqlite3.Connection, pid: int, name: str) -> dict | None:
    return history(conn, pid, name=name).get(name.lower())


def trend(conn: sqlite3.Connection, pid: int, exercise_id: int) -> dict | None:
    h = history(conn, pid, exercise_id).get(exercise_id)
    if not h:
        row = conn.execute("SELECT * FROM exercises WHERE id = ?", (exercise_id,)).fetchone()
        if not row:
            return None
        return {"exercise_id": exercise_id, "name": row["name"], "variation": row["variation"],
                "label": _label(row["name"], row["variation"]), "muscle_group": row["muscle_group"], "sessions": [], "stalled": False}
    return h


def prs(conn: sqlite3.Connection, pid: int, limit: int = 30) -> list[dict]:
    out = []
    for ex in history(conn, pid).values():
        for s in ex["sessions"]:
            if s["pr"]:
                out.append({"date": s["date"], "day_label": s["day_label"], "session_id": s["session_id"],
                            "exercise_id": ex["exercise_id"], "name": ex["name"], "variation": ex["variation"],
                            "label": ex["label"], **s["pr"]})
    out.sort(key=lambda p: (p["date"], p["session_id"]), reverse=True)
    return out[:limit]


def week_start(d: str) -> str:
    day = Date.fromisoformat(d)
    return (day - timedelta(days=day.weekday())).isoformat()


def volume(conn: sqlite3.Connection, pid: int, weeks: int = 8, today: Date | None = None) -> dict:
    today = today or Date.today()
    this_week = today - timedelta(days=today.weekday())
    starts = [(this_week - timedelta(weeks=i)).isoformat() for i in range(weeks - 1, -1, -1)]
    by_week: dict[str, list] = {w: [] for w in starts}
    for r in _rows(conn, pid, "AND ss.date >= ?", (starts[0],)):
        w = week_start(r["date"])
        if w in by_week:
            by_week[w].append(r)
    counted = {w: credits(rows) for w, rows in by_week.items()}
    groups = sorted({g for w in counted.values() for g in w})
    return {
        "weeks": [{"week_start": w, "groups": {g: _total(v) for g, v in sorted(counted[w].items())},
                   # Each set once, however many muscle groups it is credited to.
                   "total": len({(r["session_id"], r["exercise_id"], r["set_number"]) for r in by_week[w]})} for w in starts],
        "groups": groups,
    }


def _inches(value: float, unit: str) -> float:
    return value / CM_PER_IN if unit == "cm" else value


def dunk(conn: sqlite3.Connection, pid: int) -> dict:
    series: dict[str, list[dict]] = {"standing_touch_height": [], "approach_touch_height": [], "box_jump_height": [], "bodyweight": []}
    for m in conn.execute("SELECT * FROM measurements WHERE person_id = ? ORDER BY date, id", (pid,)):
        if m["type"] not in series:
            continue
        value = m["value"] if m["type"] == "bodyweight" else round(_inches(m["value"], m["unit"]), 1)
        unit = m["unit"] if m["type"] == "bodyweight" else "in"
        series[m["type"]].append({"date": m["date"], "value": value, "unit": unit, "approx": bool(m["approx"]), "notes": m["notes"], "source": "measurement", "id": m["id"]})
    # Box jumps logged as sets count too: the highest box of each session.
    for r in conn.execute(
        """SELECT ss.date, max(s.height_in) AS h, e.variation FROM sets s JOIN sessions ss ON ss.id = s.session_id
           JOIN exercises e ON e.id = s.exercise_id
           WHERE ss.person_id = ? AND lower(e.name) LIKE '%box jump%' AND s.height_in IS NOT NULL AND s.set_type != 'warmup'
           GROUP BY ss.id ORDER BY ss.date""",
        (pid,),
    ):
        series["box_jump_height"].append({"date": r["date"], "value": r["h"], "unit": "in", "approx": False, "notes": r["variation"], "source": "sets"})
    series["box_jump_height"].sort(key=lambda p: p["date"])
    return {"series": series, "rim_in": RIM_IN}


def next_day(conn: sqlite3.Connection, pid: int) -> str | None:
    """The day label after the last session's, cycling through the labels this person has used
    (A, B, C -> A again if there has never been a D). None when sessions carry no labels."""
    labels = [r["day_label"] for r in conn.execute(
        "SELECT day_label FROM sessions WHERE person_id = ? ORDER BY date, id", (pid,))]
    cycle = sorted({l for l in labels if l})
    if not cycle:
        return None if labels else "A"
    last = labels[-1]
    if last not in cycle:
        return None
    if len(cycle) == 1:
        # Only one label so far: assume the usual A/B/C/D split is just starting.
        return {"A": "B", "B": "C", "C": "D"}.get(last, last)
    return cycle[(cycle.index(last) + 1) % len(cycle)]


def summary(conn: sqlite3.Connection, pid: int, today: Date | None = None) -> dict:
    today = today or Date.today()
    person = conn.execute("SELECT id, name FROM people WHERE id = ?", (pid,)).fetchone()
    last = conn.execute("SELECT * FROM sessions WHERE person_id = ? ORDER BY date DESC, id DESC LIMIT 1", (pid,)).fetchone()
    last_out = None
    if last:
        lifts = conn.execute(
            """SELECT e.name, e.variation, max(s.weight_lb) AS top, count(DISTINCT s.set_number) AS sets
               FROM sets s JOIN exercises e ON e.id = s.exercise_id
               WHERE s.session_id = ? AND s.set_type != 'warmup' GROUP BY e.id ORDER BY min(s.id)""",
            (last["id"],),
        ).fetchall()
        last_out = {"date": last["date"], "day_label": last["day_label"], "notes": last["notes"],
                    "exercises": [{"label": _label(l["name"], l["variation"]), "name": l["name"], "top_weight": l["top"], "sets": l["sets"]} for l in lifts]}
    vol = volume(conn, pid, 1, today)["weeks"][0]
    counts = conn.execute(
        """SELECT (SELECT count(*) FROM sessions WHERE person_id = :p) AS sessions,
                  (SELECT count(*) FROM sets s JOIN sessions ss ON ss.id = s.session_id WHERE ss.person_id = :p) AS sets""",
        {"p": pid},
    ).fetchone()
    return {
        "person": dict(person) if person else None,
        "people_count": conn.execute("SELECT count(*) FROM people").fetchone()[0],
        "last_session": last_out,
        "next_day": next_day(conn, pid),
        "this_week": {"week_start": vol["week_start"], "working_sets": vol["total"],
                      "sessions": conn.execute("SELECT count(*) FROM sessions WHERE person_id = ? AND date >= ?", (pid, vol["week_start"])).fetchone()[0]},
        "recent_prs": prs(conn, pid, 5),
        "stalled": [e["label"] for e in exercises(conn, pid) if e["stalled"]],
        "totals": dict(counts),
    }


# ---- Insights for the dashboard tile ------------------------------------------------------

# Groups that get a weekly set target; jumps and core work are tracked but not judged.
NO_TARGET = {"Plyometrics", "Core", "Other"}
PUSH = {"Chest", "Shoulders", "Side delts", "Triceps"}
PULL = {"Back", "Biceps", "Rear delts"}
MAX_GAIN = 0.02  # projections assume at most 2% e1RM gain per week


def _slope_per_week(points: list[tuple[str, float]]) -> float | None:
    """Least-squares slope (units per week) of (date, value) points; None if too few."""
    if len(points) < 3:
        return None
    xs = [Date.fromisoformat(d).toordinal() / 7 for d, _ in points]
    if max(xs) - min(xs) < 1:  # under a week of data: too early to call
        return None
    ys = [v for _, v in points]
    mx, my = sum(xs) / len(xs), sum(ys) / len(ys)
    den = sum((x - mx) ** 2 for x in xs)
    return sum((x - mx) * (y - my) for x, y in zip(xs, ys)) / den if den else None


def insights(conn: sqlite3.Connection, pid: int, today: Date | None = None, target: int = 10, weeks: int = 8) -> dict:
    """Volume, overall progress, projections and shortcomings for one person."""
    today = today or Date.today()
    vol = volume(conn, pid, weeks, today)
    this_week, last_week = vol["weeks"][-1], vol["weeks"][-2] if len(vol["weeks"]) > 1 else None

    # Rolling last 7 days and last 28 days per muscle group, plus when each was last trained.
    since7 = (today - timedelta(days=6)).isoformat()
    since28 = (today - timedelta(days=27)).isoformat()
    all_rows = _rows(conn, pid)
    last7 = credits(r for r in all_rows if r["date"] >= since7)
    last28 = credits(r for r in all_rows if r["date"] >= since28)
    last_hit: dict[str, str] = {}  # directly or as a secondary muscle
    for r in all_rows:
        for g in credits([r]):
            last_hit[g] = max(last_hit.get(g, ""), r["date"])

    # Progress and projections per exercise as logged (name + variation): different
    # stances or machines aren't comparable, so they aren't mixed here.
    hist = history(conn, pid)
    variations: dict[str, int] = defaultdict(int)
    for ex in hist.values():
        variations[ex["name"]] += 1
    lifts = []
    for ex in hist.values():
        pts = [(x["date"], x["e1rm"]) for x in ex["sessions"] if x["e1rm"] is not None]
        if not pts:
            continue
        first, latest = pts[0][1], pts[-1][1]
        best = max(v for _, v in pts)
        span = (Date.fromisoformat(pts[-1][0]) - Date.fromisoformat(pts[0][0])).days
        # A trend needs 3+ sessions over 2+ weeks; the projection's weekly gain is capped
        # at MAX_GAIN of the best e1RM, since early sessions jump a lot (technique, warming
        # up to a new machine) and a straight line would run away.
        slope = _slope_per_week(pts) if len(pts) >= 3 and span >= 14 else None
        rate = min(slope, best * MAX_GAIN) if slope is not None else None
        lifts.append({
            "exercise_id": ex["exercise_id"],
            "name": ex["label"] if variations[ex["name"]] > 1 else ex["name"],
            "sessions": len(pts),
            "first_e1rm": first, "latest_e1rm": latest, "best_e1rm": best,
            "change_pct": round((latest / first - 1) * 100, 1) if len(pts) > 1 and first else None,
            "lb_per_week": round(slope, 1) if slope is not None else None,
            "projected_4wk": round(best + rate * 4, 1) if rate is not None and rate > 0 else None,
            "projection_capped": bool(slope is not None and rate is not None and rate < slope),
            "stalled": ex["stalled"],
            "last_date": pts[-1][0],
            "points": [v for _, v in pts[-12:]],  # for the tile's sparkline
        })
    # Most-logged first, then most recent.
    lifts.sort(key=lambda x: x["name"])
    lifts.sort(key=lambda x: x["last_date"], reverse=True)
    lifts.sort(key=lambda x: x["sessions"], reverse=True)
    changes = [x["change_pct"] for x in lifts if x["change_pct"] is not None]
    overall = round(sum(changes) / len(changes), 1) if changes else None

    # Shortcomings, most important first.
    short: list[dict] = []
    trained = sorted(g for g in last_hit if g not in NO_TARGET)
    idle_days = {g: (today - Date.fromisoformat(last_hit[g])).days for g in trained}
    for g in trained:
        n = _total(last7.get(g))
        if n < target and idle_days[g] < 8:  # 8+ days idle is reported once, as idle
            short.append({"kind": "low_volume", "group": g, "sets": n, "target": target,
                          "text": f"{g}: {n:g} of {target} sets in the last 7 days"})
    for g in trained:
        idle = idle_days[g]
        if idle >= 8:
            short.append({"kind": "idle", "group": g, "days": idle, "text": f"{g}: not trained for {idle} days"})
    for x in lifts:
        if x["stalled"]:
            short.append({"kind": "stalled", "lift": x["name"], "text": f"{x['name']}: no e1RM gain in 3 sessions"})
        elif x["lb_per_week"] is not None and x["lb_per_week"] < 0:
            short.append({"kind": "declining", "lift": x["name"], "text": f"{x['name']}: trending down {abs(x['lb_per_week'])} lb/week"})
    push = sum(_total(v) for g, v in last28.items() if g in PUSH)
    pull = sum(_total(v) for g, v in last28.items() if g in PULL)
    if push and pull and max(push, pull) / min(push, pull) >= 1.5:
        more, less = ("push", "pull") if push > pull else ("pull", "push")
        short.append({"kind": "balance", "push": push, "pull": pull,
                      "text": f"More {more} than {less}: {max(push, pull):g} vs {min(push, pull):g} sets in 4 weeks"})
    order = {"stalled": 0, "declining": 1, "low_volume": 2, "balance": 3, "idle": 4}
    short.sort(key=lambda s: (order[s["kind"]], s.get("sets", 0)))

    # Dunk: touch height trend toward the rim + 6 in.
    touches = [(m["type"], m["date"], _inches(m["value"], m["unit"])) for m in conn.execute(
        "SELECT * FROM measurements WHERE person_id = ? AND type IN ('standing_touch_height', 'approach_touch_height') ORDER BY date",
        (pid,))]
    dunk_out = None
    if touches:
        best_type, _, best_touch = max(touches, key=lambda t: t[2])
        # Trend within one kind of jump only: standing vs approach differ by inches.
        slope = _slope_per_week([(d, v) for t, d, v in touches if t == best_type])
        goal = RIM_IN + 6
        weeks_to_goal = round((goal - best_touch) / slope) if slope and slope > 0 and best_touch < goal else None
        dunk_out = {"best_in": round(best_touch, 1), "goal_in": goal, "to_go_in": round(max(0, goal - best_touch), 1),
                    "in_per_week": round(slope, 2) if slope is not None else None, "weeks_to_goal": weeks_to_goal}

    prs30 = [p for p in prs(conn, pid, 500) if p["date"] >= (today - timedelta(days=29)).isoformat()]
    return {
        "target": target,
        "weeks": [{"week_start": w["week_start"], "total": w["total"]} for w in vol["weeks"]],
        "this_week": this_week["total"],
        "last_week": last_week["total"] if last_week else None,
        # Every group trained so far, 0 when not in the last 7 days.
        "groups_7d": {g: _total(last7.get(g)) for g in sorted(last_hit)},
        "overall_change_pct": overall,
        "lifts": lifts,
        "prs_30d": len(prs30),
        "shortcomings": short,
        "dunk": dunk_out,
    }


# ---- Monthly report -------------------------------------------------------------------------

def _month_bounds(month: str) -> tuple[str, str, str]:
    """(first day, first day of the next month, previous month as YYYY-MM)."""
    y, m = int(month[:4]), int(month[5:7])
    start = Date(y, m, 1)
    nxt = Date(y + (m == 12), m % 12 + 1, 1)
    prev = Date(y - (m == 1), (m - 2) % 12 + 1, 1)
    return start.isoformat(), nxt.isoformat(), prev.isoformat()[:7]


def _month_stats(conn: sqlite3.Connection, pid: int, month: str, all_prs: list[dict]) -> dict:
    start, end, _ = _month_bounds(month)
    rows = _rows(conn, pid, "AND ss.date >= ? AND ss.date < ?", (start, end))
    days = sorted({r["date"] for r in conn.execute(
        "SELECT date FROM sessions WHERE person_id = ? AND date >= ? AND date < ?", (pid, start, end))})
    load = 0.0
    for r in rows:
        if r["weight_lb"] and r["reps"]:
            load += r["weight_lb"] * r["reps"] * (2 if r["load_basis"] in DOUBLED else 1)
    efforts = [10 - reserve(r) for r in rows if r["rpe"] is not None or r["rir"] is not None]
    prs_ = [p for p in all_prs if start <= p["date"] < end]
    return {
        "month": month,
        "sessions": conn.execute("SELECT count(*) FROM sessions WHERE person_id = ? AND date >= ? AND date < ?", (pid, start, end)).fetchone()[0],
        "days": days,
        "working_sets": len({(r["session_id"], r["exercise_id"], r["set_number"]) for r in rows}),
        "volume_lb": round(load),
        "avg_rpe": round(sum(efforts) / len(efforts), 1) if efforts else None,
        "prs": len(prs_),
        "pr_list": prs_[:12],
        "groups": {g: _total(v) for g, v in sorted(credits(rows).items())},
    }


def report(conn: sqlite3.Connection, pid: int, month: str | None = None, today: Date | None = None) -> dict:
    """One calendar month next to the month before it."""
    today = today or Date.today()
    month = month or today.isoformat()[:7]
    _, nxt, prev = _month_bounds(month)
    all_prs = prs(conn, pid, 100000)
    first = conn.execute("SELECT min(date) FROM sessions WHERE person_id = ?", (pid,)).fetchone()[0]
    return {
        "this": _month_stats(conn, pid, month, all_prs),
        "previous": _month_stats(conn, pid, prev, all_prs),
        "previous_month": prev if first and first[:7] <= prev else None,
        "next_month": nxt[:7] if nxt[:7] <= today.isoformat()[:7] else None,
        "in_progress": month == today.isoformat()[:7],
    }
