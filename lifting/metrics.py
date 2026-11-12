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
Exercises are compared per name + variation, as stored.
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


def _rows(conn: sqlite3.Connection, where: str = "", params: tuple = ()) -> list[sqlite3.Row]:
    return conn.execute(
        f"""SELECT s.*, ss.date, ss.day_label, e.name, e.variation, e.muscle_group
            FROM sets s JOIN sessions ss ON ss.id = s.session_id JOIN exercises e ON e.id = s.exercise_id
            WHERE s.set_type != 'warmup' {where}
            ORDER BY ss.date, ss.id, s.set_number, s.segment""",
        params,
    ).fetchall()


def _label(name: str, variation: str) -> str:
    return f"{name} ({variation})" if variation else name


def history(conn: sqlite3.Connection, exercise_id: int | None = None, name: str | None = None) -> dict:
    """Per exercise: its sessions in order with best e1RM, top set and PR info.

    With name, every variation of that exercise is treated as one lift (key: the name).
    """
    if name:
        rows = _rows(conn, "AND lower(e.name) = lower(?)", (name,))
    elif exercise_id:
        rows = _rows(conn, "AND s.exercise_id = ?", (exercise_id,))
    else:
        rows = _rows(conn)
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


def exercises(conn: sqlite3.Connection) -> list[dict]:
    hist = history(conn)
    out = []
    for e in conn.execute(
        """SELECT e.*, count(DISTINCT s.session_id) AS session_count, max(ss.date) AS last_date
           FROM exercises e LEFT JOIN sets s ON s.exercise_id = e.id LEFT JOIN sessions ss ON ss.id = s.session_id
           GROUP BY e.id ORDER BY e.name, e.variation"""
    ):
        h = hist.get(e["id"])
        latest = next((x["e1rm"] for x in reversed(h["sessions"]) if x["e1rm"] is not None), None) if h else None
        out.append({
            **dict(e), "label": _label(e["name"], e["variation"]),
            "stalled": bool(h and h["stalled"]), "latest_e1rm": latest,
            "has_e1rm": bool(h and any(x["e1rm"] is not None for x in h["sessions"])),
        })
    return out


def trend_by_name(conn: sqlite3.Connection, name: str) -> dict | None:
    return history(conn, name=name).get(name.lower())


def trend(conn: sqlite3.Connection, exercise_id: int) -> dict | None:
    h = history(conn, exercise_id).get(exercise_id)
    if not h:
        row = conn.execute("SELECT * FROM exercises WHERE id = ?", (exercise_id,)).fetchone()
        if not row:
            return None
        return {"exercise_id": exercise_id, "name": row["name"], "variation": row["variation"],
                "label": _label(row["name"], row["variation"]), "muscle_group": row["muscle_group"], "sessions": [], "stalled": False}
    return h


def prs(conn: sqlite3.Connection, limit: int = 30) -> list[dict]:
    out = []
    for ex in history(conn).values():
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


def volume(conn: sqlite3.Connection, weeks: int = 8, today: Date | None = None) -> dict:
    today = today or Date.today()
    this_week = today - timedelta(days=today.weekday())
    starts = [(this_week - timedelta(weeks=i)).isoformat() for i in range(weeks - 1, -1, -1)]
    counted: dict[str, dict[str, set]] = {w: defaultdict(set) for w in starts}
    for r in _rows(conn, "AND ss.date >= ?", (starts[0],)):
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


def dunk(conn: sqlite3.Connection) -> dict:
    series: dict[str, list[dict]] = {"standing_touch_height": [], "approach_touch_height": [], "box_jump_height": [], "bodyweight": []}
    for m in conn.execute("SELECT * FROM measurements ORDER BY date, id"):
        if m["type"] not in series:
            continue
        value = m["value"] if m["type"] == "bodyweight" else round(_inches(m["value"], m["unit"]), 1)
        unit = m["unit"] if m["type"] == "bodyweight" else "in"
        series[m["type"]].append({"date": m["date"], "value": value, "unit": unit, "approx": bool(m["approx"]), "notes": m["notes"], "source": "measurement", "id": m["id"]})
    # Box jumps logged as sets count too: the highest box of each session.
    for r in conn.execute(
        """SELECT ss.date, max(s.height_in) AS h, e.variation FROM sets s JOIN sessions ss ON ss.id = s.session_id
           JOIN exercises e ON e.id = s.exercise_id
           WHERE lower(e.name) LIKE '%box jump%' AND s.height_in IS NOT NULL AND s.set_type != 'warmup'
           GROUP BY ss.id ORDER BY ss.date"""
    ):
        series["box_jump_height"].append({"date": r["date"], "value": r["h"], "unit": "in", "approx": False, "notes": r["variation"], "source": "sets"})
    series["box_jump_height"].sort(key=lambda p: p["date"])
    return {"series": series, "rim_in": RIM_IN}


NEXT_DAY = {"A": "B", "B": "C", "C": "D", "D": "A"}


def summary(conn: sqlite3.Connection, today: Date | None = None) -> dict:
    today = today or Date.today()
    last = conn.execute("SELECT * FROM sessions ORDER BY date DESC, id DESC LIMIT 1").fetchone()
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
    vol = volume(conn, 1, today)["weeks"][0]
    counts = conn.execute("SELECT (SELECT count(*) FROM sessions) AS sessions, (SELECT count(*) FROM sets) AS sets").fetchone()
    return {
        "last_session": last_out,
        "next_day": NEXT_DAY.get(last["day_label"]) if last else "A",
        "this_week": {"week_start": vol["week_start"], "working_sets": vol["total"],
                      "sessions": conn.execute("SELECT count(*) FROM sessions WHERE date >= ?", (vol["week_start"],)).fetchone()[0]},
        "recent_prs": prs(conn, 5),
        "stalled": [e["label"] for e in exercises(conn) if e["stalled"]],
        "totals": dict(counts),
    }
