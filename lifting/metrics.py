"""Derived numbers for the dashboard. Warmup sets never count.

- e1RM (Epley): weight * (1 + reps / 30), only for 1-12 reps with a weight. For a
  mechanical drop set only the first segment counts (the later segments are the same
  weight after a grip switch, so they'd only understate it).
- Top-set weight: heaviest working set of the exercise in the session.
- PR: a session's best e1RM beats every earlier session of that exercise, or a set beats
  the heaviest weight earlier lifted for at least as many reps (if it's the most reps
  ever, it must at least match the heaviest weight ever). An exercise's first session
  only sets the baseline.
- Stall: the best e1RM of the last 3 sessions is no higher than before them.
- Volume: working sets per muscle group per week (Monday start); the segments of one
  mechanical drop set count as one set.
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


def epley(weight: float | None, reps: int | None) -> float | None:
    if weight is None or reps is None or reps < 1 or reps > 12 or weight <= 0:
        return None
    return weight * (1 + reps / 30)


def set_e1rm(row) -> float | None:
    if row["set_type"] == "warmup" or (row["set_type"] == "mechanical_drop" and row["segment"] > 1):
        return None
    return epley(row["weight_lb"], row["reps"])


def _rows(conn: sqlite3.Connection, pid: int, where: str = "", params: tuple = ()) -> list[sqlite3.Row]:
    return conn.execute(
        f"""SELECT s.*, ss.date, ss.day_label, e.name, e.variation, e.muscle_group
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
                "e1rm_set": {"weight_lb": best[1]["weight_lb"], "reps": best[1]["reps"]} if best else None,
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
                if best and (best_prior is None or best[0] > best_prior + EPS):
                    kinds.append("e1rm")
                    pr_set = best[1]
                rep_prs = []
                for r in sets:
                    if r["weight_lb"] is None or not r["reps"] or (r["set_type"] == "mechanical_drop" and r["segment"] > 1):
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
    counted: dict[str, dict[str, set]] = {w: defaultdict(set) for w in starts}
    for r in _rows(conn, pid, "AND ss.date >= ?", (starts[0],)):
        w = week_start(r["date"])
        if w in counted:
            counted[w][r["muscle_group"] or "Other"].add((r["session_id"], r["exercise_id"], r["set_number"]))
    groups = sorted({g for w in counted.values() for g in w})
    return {
        "weeks": [{"week_start": w, "groups": {g: len(v) for g, v in sorted(counted[w].items())}, "total": sum(len(v) for v in counted[w].values())} for w in starts],
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


NEXT_DAY = {"A": "B", "B": "C", "C": "D", "D": "A"}


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
        "next_day": NEXT_DAY.get(last["day_label"]) if last else "A",
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
    last7: dict[str, set] = defaultdict(set)
    last28: dict[str, set] = defaultdict(set)
    last_hit: dict[str, str] = {}
    for r in _rows(conn, pid):
        g = r["muscle_group"] or "Other"
        key = (r["session_id"], r["exercise_id"], r["set_number"])
        last_hit[g] = max(last_hit.get(g, ""), r["date"])
        if r["date"] >= since28:
            last28[g].add(key)
        if r["date"] >= since7:
            last7[g].add(key)

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
    for g in trained:
        n = len(last7.get(g, ()))
        if n < target:
            short.append({"kind": "low_volume", "group": g, "sets": n, "target": target,
                          "text": f"{g}: {n} of {target} sets in the last 7 days"})
    for g in trained:
        idle = (today - Date.fromisoformat(last_hit[g])).days
        if idle >= 8:
            short.append({"kind": "idle", "group": g, "days": idle, "text": f"{g}: not trained for {idle} days"})
    for x in lifts:
        if x["stalled"]:
            short.append({"kind": "stalled", "lift": x["name"], "text": f"{x['name']}: no e1RM gain in 3 sessions"})
        elif x["lb_per_week"] is not None and x["lb_per_week"] < 0:
            short.append({"kind": "declining", "lift": x["name"], "text": f"{x['name']}: trending down {abs(x['lb_per_week'])} lb/week"})
    push = sum(len(v) for g, v in last28.items() if g in PUSH)
    pull = sum(len(v) for g, v in last28.items() if g in PULL)
    if push and pull and max(push, pull) / min(push, pull) >= 1.5:
        more, less = ("push", "pull") if push > pull else ("pull", "push")
        short.append({"kind": "balance", "push": push, "pull": pull,
                      "text": f"More {more} than {less}: {max(push, pull)} vs {min(push, pull)} sets in 4 weeks"})
    order = {"stalled": 0, "declining": 1, "low_volume": 2, "balance": 3, "idle": 4}
    short.sort(key=lambda s: (order[s["kind"]], s.get("sets", 0)))

    # Dunk: touch height trend toward the rim + 6 in.
    touch = [(m["date"], _inches(m["value"], m["unit"])) for m in conn.execute(
        "SELECT * FROM measurements WHERE person_id = ? AND type IN ('standing_touch_height', 'approach_touch_height') ORDER BY date",
        (pid,))]
    dunk_out = None
    if touch:
        best_touch = max(v for _, v in touch)
        slope = _slope_per_week(touch)
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
        "groups_7d": {g: len(last7.get(g, ())) for g in sorted(last_hit)},
        "overall_change_pct": overall,
        "lifts": lifts,
        "prs_30d": len(prs30),
        "shortcomings": short,
        "dunk": dunk_out,
    }
