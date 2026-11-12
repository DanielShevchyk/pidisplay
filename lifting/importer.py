"""POST /import: sessions[] with nested sets[], plus measurements[] (format of lifting_backfill.json).

Everything goes to one person: the payload's "person" (a name; created if new), else the
person the caller picked (the Import page's switcher), else the default person.

Re-importing is safe: sessions are upserted by person + date + day label, sets by
session + exercise (name + variation) + set_number + segment, measurements by person + date + type.
A re-imported row overwrites the stored one, so a corrected export fixes mistakes.
The whole import is one transaction: any invalid row rejects all of it.
"""
from __future__ import annotations

import re
import sqlite3
from datetime import date as Date
from typing import Any

from .catalog import guess_equipment, guess_muscle_group
from .db import LOAD_BASES, MEASUREMENT_TYPES, SET_TYPES, Tx, default_person

# value_<unit> keys accepted on measurements, e.g. "value_in": 111.
UNIT_KEYS = {"value_in": "in", "value_lb": "lb", "value_kg": "kg", "value_cm": "cm"}
DEFAULT_UNITS = {"bodyweight": "lb"}


class ImportError_(ValueError):
    def __init__(self, errors: list[str]):
        super().__init__("; ".join(errors))
        self.errors = errors


def _date(v: Any, where: str, errors: list[str]) -> str | None:
    if not isinstance(v, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", v):
        errors.append(f"{where}: date must be YYYY-MM-DD")
        return None
    try:
        Date.fromisoformat(v)
    except ValueError:
        errors.append(f"{where}: {v} is not a real date")
        return None
    return v


def _num(v: Any, where: str, field: str, errors: list[str], integer: bool = False) -> float | int | None:
    if v is None or v == "":
        return None
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        errors.append(f"{where}: {field} must be a number")
        return None
    if v < 0:
        errors.append(f"{where}: {field} can't be negative")
        return None
    if integer:
        if int(v) != v:
            errors.append(f"{where}: {field} must be a whole number")
            return None
        return int(v)
    return float(v)


def _text(v: Any) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def _flag(v: Any) -> int:
    return 1 if v is True or v in (1, "true", "yes") else 0


def parse(payload: Any) -> tuple[list[dict], list[dict]]:
    """Validates and normalizes the payload; raises ImportError_ with every problem found."""
    errors: list[str] = []
    if not isinstance(payload, dict):
        raise ImportError_(["Expected a JSON object with sessions[] and/or measurements[]"])
    sessions_in = payload.get("sessions") or []
    measurements_in = payload.get("measurements") or []
    if not isinstance(sessions_in, list) or not isinstance(measurements_in, list):
        raise ImportError_(["sessions and measurements must be arrays"])
    if not sessions_in and not measurements_in:
        raise ImportError_(["Nothing to import: no sessions or measurements"])

    sessions: list[dict] = []
    for i, s in enumerate(sessions_in):
        where = f"sessions[{i}]"
        if not isinstance(s, dict):
            errors.append(f"{where}: must be an object")
            continue
        d = _date(s.get("date"), where, errors)
        label = str(s.get("day_label", s.get("day")) or "").strip().upper()
        if len(label) > 8:
            errors.append(f"{where}: day label is too long")
        sets_in = s.get("sets") or []
        if not isinstance(sets_in, list):
            errors.append(f"{where}: sets must be an array")
            sets_in = []
        sets: list[dict] = []
        seen: set[tuple] = set()
        for j, st in enumerate(sets_in):
            w = f"{where}.sets[{j}]"
            if not isinstance(st, dict):
                errors.append(f"{w}: must be an object")
                continue
            name = _text(st.get("exercise"))
            if not name:
                errors.append(f"{w}: exercise is required")
                continue
            variation = _text(st.get("variation")) or ""
            set_type = st.get("set_type") or "working"
            if set_type not in SET_TYPES:
                errors.append(f"{w}: set_type must be one of {', '.join(SET_TYPES)}")
            basis = st.get("load_basis")
            if basis is not None and basis not in LOAD_BASES:
                errors.append(f"{w}: load_basis must be one of {', '.join(LOAD_BASES)}")
            set_number = _num(st.get("set_number"), w, "set_number", errors, integer=True)
            if set_number is None:
                errors.append(f"{w}: set_number is required")
            segment = _num(st.get("segment", 1), w, "segment", errors, integer=True) or 1
            row = {
                "exercise": name,
                "variation": variation,
                "muscle_group": _text(st.get("muscle_group")),
                "equipment": _text(st.get("equipment")),
                "set_number": set_number,
                "segment": segment,
                "set_type": set_type,
                "weight_lb": _num(st.get("weight_lb"), w, "weight_lb", errors),
                "load_basis": basis,
                "reps": _num(st.get("reps"), w, "reps", errors, integer=True),
                "duration_s": _num(st.get("duration_s"), w, "duration_s", errors),
                "height_in": _num(st.get("height_in"), w, "height_in", errors),
                "approx": _flag(st.get("approx")),
                "inferred": _flag(st.get("inferred")),
                "notes": _text(st.get("notes")),
            }
            key = (name.lower(), variation.lower(), set_number, segment)
            if key in seen:
                errors.append(f"{w}: duplicate of an earlier set ({name}, set {set_number}, segment {segment})")
            seen.add(key)
            sets.append(row)
        sessions.append({"date": d, "day_label": label, "notes": _text(s.get("notes")), "has_notes": "notes" in s, "sets": sets})

    measurements: list[dict] = []
    for i, m in enumerate(measurements_in):
        where = f"measurements[{i}]"
        if not isinstance(m, dict):
            errors.append(f"{where}: must be an object")
            continue
        d = _date(m.get("date"), where, errors)
        mtype = _text(m.get("type"))
        if mtype not in MEASUREMENT_TYPES:
            errors.append(f"{where}: type must be one of {', '.join(MEASUREMENT_TYPES)}")
        value, unit = m.get("value"), _text(m.get("unit"))
        if value is None:
            for k, u in UNIT_KEYS.items():
                if k in m:
                    value, unit = m[k], unit or u
                    break
        value = _num(value, where, "value", errors)
        if value is None:
            errors.append(f"{where}: value is required (value + unit, or e.g. value_in)")
        unit = unit or DEFAULT_UNITS.get(mtype or "", "in")
        measurements.append({"date": d, "type": mtype, "value": value, "unit": unit, "approx": _flag(m.get("approx")), "notes": _text(m.get("notes"))})

    if errors:
        raise ImportError_(errors)
    return sessions, measurements


def exercise_id(conn: sqlite3.Connection, name: str, variation: str, muscle_group: str | None = None, equipment: str | None = None) -> tuple[int, bool]:
    """Finds (case-insensitively) or creates the exercise; returns (id, created)."""
    row = conn.execute(
        "SELECT id, muscle_group, equipment FROM exercises WHERE lower(name) = lower(?) AND lower(variation) = lower(?)",
        (name, variation),
    ).fetchone()
    if row:
        if muscle_group and muscle_group != row["muscle_group"] or equipment and equipment != row["equipment"]:
            conn.execute(
                "UPDATE exercises SET muscle_group = coalesce(?, muscle_group), equipment = coalesce(?, equipment) WHERE id = ?",
                (muscle_group, equipment, row["id"]),
            )
        return row["id"], False
    cur = conn.execute(
        "INSERT INTO exercises (name, variation, muscle_group, equipment) VALUES (?, ?, ?, ?)",
        (name, variation, muscle_group or guess_muscle_group(name, variation), equipment or guess_equipment(name, variation)),
    )
    return cur.lastrowid, True


SET_FIELDS = ("set_type", "weight_lb", "load_basis", "reps", "duration_s", "height_in", "approx", "inferred", "notes")


def run_import(conn: sqlite3.Connection, payload: Any, person_id: int | None = None) -> dict:
    sessions, measurements = parse(payload)
    named = _text(payload.get("person")) if isinstance(payload.get("person"), str) else None
    if named and len(named) > 40:
        raise ImportError_(["person: name is too long (40 characters at most)"])
    if named and named.isdigit():
        raise ImportError_(["person: use a name, not a number"])
    stats = {k: 0 for k in (
        "sessions_created", "sessions_updated", "sets_added", "sets_updated", "sets_unchanged",
        "exercises_created", "measurements_added", "measurements_updated", "measurements_unchanged",
    )}
    stats["person_created"] = False
    with Tx(conn):
        if named:
            row = conn.execute("SELECT id FROM people WHERE name = ?", (named,)).fetchone()
            pid = row["id"] if row else None
            if pid is None:
                pid = conn.execute("INSERT INTO people (name) VALUES (?)", (named,)).lastrowid
                stats["person_created"] = True
        else:
            pid = person_id or default_person(conn)
        stats["person_id"] = pid
        stats["person"] = conn.execute("SELECT name FROM people WHERE id = ?", (pid,)).fetchone()["name"]
        for s in sessions:
            row = conn.execute("SELECT id, notes FROM sessions WHERE person_id = ? AND date = ? AND day_label = ?", (pid, s["date"], s["day_label"])).fetchone()
            if row:
                sid = row["id"]
                if s["has_notes"] and s["notes"] != row["notes"]:
                    conn.execute("UPDATE sessions SET notes = ? WHERE id = ?", (s["notes"], sid))
                    stats["sessions_updated"] += 1
            else:
                sid = conn.execute("INSERT INTO sessions (person_id, date, day_label, notes) VALUES (?, ?, ?, ?)", (pid, s["date"], s["day_label"], s["notes"])).lastrowid
                stats["sessions_created"] += 1
            for st in s["sets"]:
                eid, created = exercise_id(conn, st["exercise"], st["variation"], st["muscle_group"], st["equipment"])
                stats["exercises_created"] += created
                old = conn.execute(
                    f"SELECT id, {', '.join(SET_FIELDS)} FROM sets WHERE session_id = ? AND exercise_id = ? AND set_number = ? AND segment = ?",
                    (sid, eid, st["set_number"], st["segment"]),
                ).fetchone()
                values = [st[f] for f in SET_FIELDS]
                if old is None:
                    conn.execute(
                        f"INSERT INTO sets (session_id, exercise_id, set_number, segment, {', '.join(SET_FIELDS)}) VALUES (?, ?, ?, ?, {', '.join('?' * len(SET_FIELDS))})",
                        (sid, eid, st["set_number"], st["segment"], *values),
                    )
                    stats["sets_added"] += 1
                elif [old[f] for f in SET_FIELDS] != values:
                    conn.execute(f"UPDATE sets SET {', '.join(f'{f} = ?' for f in SET_FIELDS)} WHERE id = ?", (*values, old["id"]))
                    stats["sets_updated"] += 1
                else:
                    stats["sets_unchanged"] += 1
        for m in measurements:
            old = conn.execute("SELECT id, value, unit, approx, notes FROM measurements WHERE person_id = ? AND date = ? AND type = ?", (pid, m["date"], m["type"])).fetchone()
            vals = (m["value"], m["unit"], m["approx"], m["notes"])
            if old is None:
                conn.execute("INSERT INTO measurements (person_id, date, type, value, unit, approx, notes) VALUES (?, ?, ?, ?, ?, ?, ?)", (pid, m["date"], m["type"], *vals))
                stats["measurements_added"] += 1
            elif (old["value"], old["unit"], old["approx"], old["notes"]) != vals:
                conn.execute("UPDATE measurements SET value = ?, unit = ?, approx = ?, notes = ? WHERE id = ?", (*vals, old["id"]))
                stats["measurements_updated"] += 1
            else:
                stats["measurements_unchanged"] += 1
    return stats
