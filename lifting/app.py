"""Lifting tracker web service: JSON API plus the touch dashboard, /log and /import pages.

Run: uvicorn --factory lifting.app:create_app --host 0.0.0.0 --port 8090  (from the repo root)
PiDisplay's own server proxies http://127.0.0.1:8080/lifting/ here, so pages use
relative URLs and work both at /lifting/ and on port 8090 directly.
"""
from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from typing import Any, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import metrics
from .db import LOAD_BASES, MEASUREMENT_TYPES, SET_TYPES, Tx, connect, default_person, find_person
from .importer import ImportError_, _date, run_import

WEB = Path(__file__).resolve().parent / "web"


class PersonIn(BaseModel):
    name: str


class SetPatch(BaseModel):
    exercise_id: Optional[int] = None
    set_number: Optional[int] = None
    segment: Optional[int] = None
    set_type: Optional[str] = None
    weight_lb: Optional[float] = None
    load_basis: Optional[str] = None
    reps: Optional[int] = None
    duration_s: Optional[float] = None
    height_in: Optional[float] = None
    approx: Optional[bool] = None
    inferred: Optional[bool] = None
    notes: Optional[str] = None


class SessionPatch(BaseModel):
    person_id: Optional[int] = None
    date: Optional[str] = None
    day_label: Optional[str] = None
    notes: Optional[str] = None


class ExercisePatch(BaseModel):
    name: Optional[str] = None
    variation: Optional[str] = None
    muscle_group: Optional[str] = None
    equipment: Optional[str] = None


class MeasurementIn(BaseModel):
    date: str
    type: str
    value: float
    unit: Optional[str] = None
    approx: bool = False
    notes: Optional[str] = None


class MeasurementPatch(BaseModel):
    date: Optional[str] = None
    type: Optional[str] = None
    value: Optional[float] = None
    unit: Optional[str] = None
    approx: Optional[bool] = None
    notes: Optional[str] = None


def create_app(db_file: str | Path | None = None) -> FastAPI:
    # Handlers are async on purpose: they then run one at a time on the event loop, so
    # the single SQLite connection is never used from two threads at once.
    app = FastAPI(title="PiDisplay lifting", docs_url="/api/docs", openapi_url="/api/openapi.json", redoc_url=None)
    conn = connect(db_file)
    app.state.conn = conn

    def page(name: str):
        return FileResponse(WEB / name, headers={"Cache-Control": "no-cache"})

    @app.get("/", include_in_schema=False)
    async def index():
        return page("index.html")

    @app.get("/log", include_in_schema=False)
    async def log_page():
        return page("log.html")

    @app.get("/import", include_in_schema=False)
    async def import_page():
        return page("import.html")

    app.mount("/static", StaticFiles(directory=WEB / "static"), name="static")

    async def person_id(person: Optional[str] = Query(None, description="Person id or name; blank = the default person")) -> int:
        """Every view and write is for one person, picked with ?person= (async: runs on the event loop)."""
        pid = find_person(conn, person)
        if pid is None:
            raise HTTPException(404, f"No person called {person!r}")
        return pid

    Person = Depends(person_id)

    @app.get("/api/health")
    async def health():
        return {"ok": True}

    async def do_import(request: Request, pid: int = Person):
        raw = await request.body()
        try:
            payload = json.loads(raw.decode("utf-8-sig"))
        except (UnicodeDecodeError, json.JSONDecodeError) as e:
            return JSONResponse({"ok": False, "errors": [f"Not valid JSON: {e}"]}, status_code=400)
        try:
            stats = run_import(conn, payload, pid)
        except ImportError_ as e:
            return JSONResponse({"ok": False, "errors": e.errors}, status_code=400)
        return {"ok": True, **stats}

    app.post("/import")(do_import)
    app.post("/api/import")(do_import)

    # ---- People --------------------------------------------------------------------

    def clean_name(name: str) -> str:
        name = " ".join((name or "").split())
        if not name:
            raise HTTPException(400, "Name can't be empty")
        if len(name) > 40:
            raise HTTPException(400, "Name is too long (40 characters at most)")
        if name.isdigit():
            raise HTTPException(400, "A name can't be only digits")  # ?person= takes ids too
        return name

    @app.get("/api/people")
    async def people():
        default_person(conn)  # there is always at least one
        return [dict(r) for r in conn.execute(
            """SELECT p.id, p.name, (SELECT count(*) FROM sessions WHERE person_id = p.id) AS sessions,
                      (SELECT max(date) FROM sessions WHERE person_id = p.id) AS last_date,
                      (SELECT count(*) FROM measurements WHERE person_id = p.id) AS measurements
               FROM people p ORDER BY p.id""")]

    @app.post("/api/people")
    async def add_person(body: PersonIn):
        name = clean_name(body.name)
        try:
            pid = conn.execute("INSERT INTO people (name) VALUES (?)", (name,)).lastrowid
        except sqlite3.IntegrityError as e:
            raise HTTPException(409, f"There is already someone called {name}") from e
        return {"id": pid, "name": name}

    @app.patch("/api/people/{pid}")
    async def rename_person(pid: int, body: PersonIn):
        name = clean_name(body.name)
        try:
            if conn.execute("UPDATE people SET name = ? WHERE id = ?", (name, pid)).rowcount == 0:
                raise HTTPException(404, "Not found")
        except sqlite3.IntegrityError as e:
            raise HTTPException(409, f"There is already someone called {name}") from e
        return {"id": pid, "name": name}

    @app.delete("/api/people/{pid}")
    async def delete_person(pid: int):
        """Deletes the person with all their sessions, sets and measurements."""
        if conn.execute("SELECT count(*) FROM people").fetchone()[0] <= 1:
            raise HTTPException(409, "Keep at least one person")
        return delete("people", pid)

    # ---- Read views ----------------------------------------------------------------

    @app.get("/api/summary")
    async def summary(pid: int = Person):
        return metrics.summary(conn, pid)

    @app.get("/api/insights")
    async def insights(target: int = Query(10, ge=1, le=40), pid: int = Person):
        return metrics.insights(conn, pid, target=target)

    @app.get("/api/exercises")
    async def exercises(pid: int = Person):
        return metrics.exercises(conn, pid)

    @app.get("/api/trend")
    async def trend_by_name(name: str, pid: int = Person):
        t = metrics.trend_by_name(conn, pid, name)
        if t is None:
            raise HTTPException(404, "No sets for that exercise")
        return t

    @app.get("/api/trend/{exercise_id}")
    async def trend(exercise_id: int, pid: int = Person):
        t = metrics.trend(conn, pid, exercise_id)
        if t is None:
            raise HTTPException(404, "No such exercise")
        return t

    @app.get("/api/volume")
    async def volume(weeks: int = Query(8, ge=1, le=52), pid: int = Person):
        return metrics.volume(conn, pid, weeks)

    @app.get("/api/prs")
    async def prs(limit: int = Query(30, ge=1, le=500), pid: int = Person):
        return metrics.prs(conn, pid, limit)

    @app.get("/api/dunk")
    async def dunk(pid: int = Person):
        return metrics.dunk(conn, pid)

    @app.get("/api/sessions")
    async def sessions(pid: int = Person):
        return [dict(r) for r in conn.execute(
            """SELECT ss.*, count(s.id) AS set_rows FROM sessions ss LEFT JOIN sets s ON s.session_id = ss.id
               WHERE ss.person_id = ? GROUP BY ss.id ORDER BY ss.date DESC, ss.id DESC""", (pid,))]

    @app.get("/api/sets")
    async def sets(
        date_from: Optional[str] = Query(None, alias="from"),
        date_to: Optional[str] = Query(None, alias="to"),
        exercise_id: Optional[int] = None,
        name: Optional[str] = None,
        include_warmups: bool = True,
        pid: int = Person,
    ):
        where, params = ["ss.person_id = ?"], [pid]
        if date_from:
            where.append("ss.date >= ?"); params.append(date_from)
        if date_to:
            where.append("ss.date <= ?"); params.append(date_to)
        if exercise_id:
            where.append("s.exercise_id = ?"); params.append(exercise_id)
        if name:
            where.append("lower(e.name) = lower(?)"); params.append(name)
        if not include_warmups:
            where.append("s.set_type != 'warmup'")
        rows = conn.execute(
            f"""SELECT s.*, ss.date, ss.day_label, e.name, e.variation FROM sets s
                JOIN sessions ss ON ss.id = s.session_id JOIN exercises e ON e.id = s.exercise_id
                WHERE {' AND '.join(where)}
                ORDER BY ss.date DESC, ss.id DESC, s.id""",
            params,
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            e = metrics.set_e1rm(r)
            d["e1rm"] = round(e, 1) if e else None
            d["approx"], d["inferred"] = bool(d["approx"]), bool(d["inferred"])
            out.append(d)
        return out

    @app.get("/api/measurements")
    async def measurements(pid: int = Person):
        return [{**dict(r), "approx": bool(r["approx"])} for r in conn.execute(
            "SELECT * FROM measurements WHERE person_id = ? ORDER BY date DESC, id DESC", (pid,))]

    # ---- Edits ---------------------------------------------------------------------

    def patch(table: str, row_id: int, changes: dict[str, Any], allowed: tuple[str, ...]):
        changes = {k: v for k, v in changes.items() if k in allowed}
        if not changes:
            raise HTTPException(400, "Nothing to change")
        try:
            with Tx(conn):
                cur = conn.execute(f"UPDATE {table} SET {', '.join(f'{k} = ?' for k in changes)} WHERE id = ?", (*changes.values(), row_id))
                if cur.rowcount == 0:
                    raise HTTPException(404, "Not found")
        except sqlite3.IntegrityError as e:
            raise HTTPException(409, f"That would clash with an existing row ({e})") from e
        return dict(conn.execute(f"SELECT * FROM {table} WHERE id = ?", (row_id,)).fetchone())

    def delete(table: str, row_id: int):
        with Tx(conn):
            if conn.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,)).rowcount == 0:
                raise HTTPException(404, "Not found")
        return {"ok": True}

    @app.patch("/api/sets/{set_id}")
    async def patch_set(set_id: int, body: SetPatch):
        changes = body.model_dump(exclude_unset=True)
        if "set_type" in changes and changes["set_type"] not in SET_TYPES:
            raise HTTPException(400, f"set_type must be one of {', '.join(SET_TYPES)}")
        if changes.get("load_basis") is not None and changes["load_basis"] not in LOAD_BASES:
            raise HTTPException(400, f"load_basis must be one of {', '.join(LOAD_BASES)}")
        for k in ("exercise_id", "set_number", "segment", "set_type"):
            if k in changes and changes[k] is None:
                raise HTTPException(400, f"{k} can't be empty")
        for k in ("weight_lb", "reps", "duration_s", "height_in", "set_number", "segment"):
            if changes.get(k) is not None and changes[k] < 0:
                raise HTTPException(400, f"{k} can't be negative")
        if "notes" in changes:
            changes["notes"] = (changes["notes"] or "").strip() or None
        for k in ("approx", "inferred"):
            if k in changes:
                changes[k] = 1 if changes[k] else 0
        if "exercise_id" in changes and not conn.execute("SELECT 1 FROM exercises WHERE id = ?", (changes["exercise_id"],)).fetchone():
            raise HTTPException(400, "No such exercise")
        return patch("sets", set_id, changes, tuple(SetPatch.model_fields))

    @app.delete("/api/sets/{set_id}")
    async def delete_set(set_id: int):
        return delete("sets", set_id)

    @app.patch("/api/sessions/{session_id}")
    async def patch_session(session_id: int, body: SessionPatch):
        changes = body.model_dump(exclude_unset=True)
        if "date" in changes:
            errs: list[str] = []
            if not _date(changes["date"], "date", errs):
                raise HTTPException(400, errs[0])
        if "day_label" in changes:
            changes["day_label"] = (changes["day_label"] or "").strip().upper()
        if "notes" in changes:
            changes["notes"] = (changes["notes"] or "").strip() or None
        if "person_id" in changes and not conn.execute("SELECT 1 FROM people WHERE id = ?", (changes["person_id"],)).fetchone():
            raise HTTPException(400, "No such person")
        return patch("sessions", session_id, changes, ("person_id", "date", "day_label", "notes"))

    @app.delete("/api/sessions/{session_id}")
    async def delete_session(session_id: int):
        return delete("sessions", session_id)

    @app.patch("/api/exercises/{ex_id}")
    async def patch_exercise(ex_id: int, body: ExercisePatch):
        changes = {k: (v or "").strip() for k, v in body.model_dump(exclude_unset=True).items()}
        if "name" in changes and not changes["name"]:
            raise HTTPException(400, "Name can't be empty")
        for k in ("muscle_group", "equipment"):
            if k in changes:
                changes[k] = changes[k] or None
        return patch("exercises", ex_id, changes, ("name", "variation", "muscle_group", "equipment"))

    @app.delete("/api/exercises/{ex_id}")
    async def delete_exercise(ex_id: int):
        if conn.execute("SELECT 1 FROM sets WHERE exercise_id = ? LIMIT 1", (ex_id,)).fetchone():
            raise HTTPException(409, "This exercise still has sets; delete or move them first")
        return delete("exercises", ex_id)

    @app.post("/api/measurements")
    async def add_measurement(body: MeasurementIn, pid: int = Person):
        return run_import_or_400({"measurements": [body.model_dump()]}, pid)

    def run_import_or_400(payload: dict, pid: int):
        try:
            return {"ok": True, **run_import(conn, payload, pid)}
        except ImportError_ as e:
            raise HTTPException(400, "; ".join(e.errors)) from e

    @app.patch("/api/measurements/{m_id}")
    async def patch_measurement(m_id: int, body: MeasurementPatch):
        changes = body.model_dump(exclude_unset=True)
        for k in ("date", "type", "value", "unit"):
            if k in changes and changes[k] in (None, ""):
                raise HTTPException(400, f"{k} can't be empty")
        if "type" in changes and changes["type"] not in MEASUREMENT_TYPES:
            raise HTTPException(400, f"type must be one of {', '.join(MEASUREMENT_TYPES)}")
        if "date" in changes:
            errs: list[str] = []
            if not _date(changes["date"], "date", errs):
                raise HTTPException(400, errs[0])
        if "value" in changes and changes["value"] < 0:
            raise HTTPException(400, "value can't be negative")
        if "approx" in changes:
            changes["approx"] = 1 if changes["approx"] else 0
        if "notes" in changes:
            changes["notes"] = (changes["notes"] or "").strip() or None
        return patch("measurements", m_id, changes, ("date", "type", "value", "unit", "approx", "notes"))

    @app.delete("/api/measurements/{m_id}")
    async def delete_measurement(m_id: int):
        return delete("measurements", m_id)

    return app


