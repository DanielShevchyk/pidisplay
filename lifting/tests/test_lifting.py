"""Run from the repo root: python3 -m pytest lifting/tests  (needs fastapi, httpx, pytest)."""
from __future__ import annotations

import copy
import sqlite3
from datetime import date

import pytest
from fastapi.testclient import TestClient

from lifting import metrics
from lifting.app import create_app
from lifting.backup import backup


def s(exercise, n, w, reps, **kw):
    return {"exercise": exercise, "set_number": n, "weight_lb": w, "reps": reps, "load_basis": "total", **kw}


SAMPLE = {
    "sessions": [
        {"date": "2026-11-03", "day": "A", "notes": "first", "sets": [
            s("Belt squat", 1, 180, 8, variation="standard stance", set_type="warmup"),
            s("Belt squat", 2, 270, 8, variation="standard stance", set_type="working"),
            s("Belt squat", 3, 270, 10, variation="standard stance", set_type="working"),
            s("Spider curl", 1, 37.5, 4, set_type="mechanical_drop", segment=1, load_basis="per_hand"),
            s("Spider curl", 1, 37.5, 3, set_type="mechanical_drop", segment=2, load_basis="per_hand"),
            {"exercise": "Plank", "set_number": 1, "set_type": "working", "duration_s": 45},
        ]},
        {"date": "2026-11-05", "day": "B", "sets": [
            s("Belt squat", 1, 360, 5, variation="standard stance", set_type="working"),
            s("Belt squat", 2, 300, 12, variation="standard stance", set_type="working"),
            s("Spider curl", 1, 35, 4, set_type="mechanical_drop", segment=1, load_basis="per_hand"),
            s("Spider curl", 1, 35, 4, set_type="mechanical_drop", segment=2, load_basis="per_hand"),
            {"exercise": "Box jump", "set_number": 1, "set_type": "working", "height_in": 31.5, "reps": 5},
        ]},
    ],
    "measurements": [{"date": "2026-11-03", "type": "standing_touch_height", "value_in": 111, "approx": True}],
}


@pytest.fixture()
def client(tmp_path):
    app = create_app(tmp_path / "lifting.db")
    with TestClient(app) as c:
        c.db = tmp_path / "lifting.db"
        yield c


def test_import_and_reimport_is_idempotent(client):
    r = client.post("/import", json=SAMPLE).json()
    assert r["ok"] and r["sessions_created"] == 2 and r["sets_added"] == 11 and r["measurements_added"] == 1
    r2 = client.post("/import", json=SAMPLE).json()
    assert r2["sessions_created"] == 0 and r2["sets_added"] == 0 and r2["sets_unchanged"] == 11 and r2["measurements_unchanged"] == 1
    changed = copy.deepcopy(SAMPLE)
    changed["sessions"][0]["sets"][1]["reps"] = 9
    r3 = client.post("/import", json=changed).json()
    assert r3["sets_updated"] == 1 and r3["sets_added"] == 0
    conn = sqlite3.connect(client.db)
    assert conn.execute("PRAGMA journal_mode").fetchone()[0] == "wal"
    assert conn.execute("SELECT count(*) FROM sets").fetchone()[0] == 11
    assert conn.execute("SELECT muscle_group FROM exercises WHERE name = 'Belt squat'").fetchone()[0] == "Quads"


def test_import_rejects_bad_rows_without_writing(client):
    bad = copy.deepcopy(SAMPLE)
    bad["sessions"][1]["sets"][0]["set_type"] = "heavy"
    bad["sessions"][1]["date"] = "2026-13-01"
    r = client.post("/import", json=bad)
    assert r.status_code == 400
    errs = r.json()["errors"]
    assert any("set_type" in e for e in errs) and any("date" in e for e in errs)
    assert client.get("/api/sessions").json() == []
    assert client.post("/import", content=b"{not json").status_code == 400


def test_variation_makes_a_separate_exercise(client):
    data = {"sessions": [{"date": "2026-11-03", "day": "A", "sets": [
        s("Belt squat", 1, 270, 8, variation="standard stance"),
        s("Belt squat", 1, 270, 8, variation="narrow stance"),
    ]}]}
    assert client.post("/import", json=data).json()["sets_added"] == 2
    assert len(client.get("/api/exercises").json()) == 2


def test_metrics(client):
    client.post("/import", json=SAMPLE)
    ex = {e["name"]: e for e in client.get("/api/exercises").json()}
    t = client.get(f"/api/trend/{ex['Belt squat']['id']}").json()
    first, second = t["sessions"]
    assert first["e1rm"] == 360.0  # 270 x 10, warmup ignored
    assert first["top_weight"] == 270 and first["pr"] is None  # baseline
    assert second["e1rm"] == 420.0  # 300 x 12 beats 360 x 5 (420)
    assert second["top_weight"] == 360
    assert "e1rm" in second["pr"]["kinds"] and second["pr"]["previous_e1rm"] == 360.0
    # Mechanical drop: only segment 1 scores, and both segments are one set.
    curl = client.get(f"/api/trend/{ex['Spider curl']['id']}").json()["sessions"]
    assert curl[0]["e1rm"] == round(37.5 * (1 + 4 / 30), 1) and curl[0]["sets"] == 1
    assert curl[1]["pr"] is None
    prs = client.get("/api/prs").json()
    assert [p["name"] for p in prs] == ["Belt squat"]


def test_trend_by_name_combines_variations(client):
    data = {"sessions": [
        {"date": "2026-11-03", "day": "A", "sets": [s("Belt squat", 1, 270, 8, variation="standard stance")]},
        {"date": "2026-11-05", "day": "B", "sets": [s("Belt squat", 1, 360, 8, variation="narrow stance")]},
    ]}
    client.post("/import", json=data)
    t = client.get("/api/trend", params={"name": "belt squat"}).json()
    assert [x["top_weight"] for x in t["sessions"]] == [270, 360]
    assert t["sessions"][1]["pr"]["kinds"] == ["e1rm", "reps"] and t["sessions"][1]["variations"] == ["narrow stance"]
    assert client.get("/api/trend", params={"name": "nope"}).status_code == 404


def test_rep_pr_and_stall(tmp_path):
    from lifting.db import connect
    from lifting.importer import run_import
    conn = connect(tmp_path / "x.db")
    days = ["2026-10-01", "2026-10-03", "2026-10-05", "2026-10-07", "2026-10-09", "2026-10-10"]
    plan = [(100, 10), (100, 12), (95, 10), (100, 11), (90, 15), (95, 12)]
    pid = run_import(conn, {"sessions": [{"date": d, "day": "A", "sets": [s("Row", 1, w, r)]} for d, (w, r) in zip(days, plan)]})["person_id"]
    h = next(iter(metrics.history(conn, pid).values()))
    kinds = [x["pr"]["kinds"] if x["pr"] else None for x in h["sessions"]]
    assert kinds[1] == ["e1rm", "reps"]  # 100 x 12 beats 100 x 10 both ways
    assert kinds[2] is None and kinds[3] is None
    assert kinds[4] is None  # 15 reps is the most ever, but at less than the heaviest weight
    assert kinds[5] is None
    assert h["stalled"] is True  # the last 3 sessions with an e1RM (95x10, 100x11, 95x12) don't beat 100x12
    run_import(conn, {"sessions": [{"date": "2026-10-11", "day": "A", "sets": [s("Row", 1, 100, 15)]}]})
    h = next(iter(metrics.history(conn, pid).values()))
    assert h["sessions"][-1]["pr"]["kinds"] == ["reps"]  # beats 90 x 15
    assert h["sessions"][-1]["pr"]["previous_weight_at_reps"] == 90


def test_weekly_volume_counts_drop_set_once(client):
    client.post("/import", json=SAMPLE)
    v = metrics.volume(client.app.state.conn, 1, 2, today=date(2026, 11, 5))
    week = v["weeks"][-1]
    assert week["week_start"] == "2026-11-02"
    assert week["groups"] == {"Biceps": 2, "Core": 1, "Glutes": 2, "Plyometrics": 1, "Quads": 4}  # squats: half a set of glutes
    assert week["total"] == 8  # each set once


def test_edit_and_delete(client):
    client.post("/import", json=SAMPLE)
    rows = client.get("/api/sets", params={"from": "2026-11-05"}).json()
    assert {r["date"] for r in rows} == {"2026-11-05"}
    target = next(r for r in rows if r["name"] == "Belt squat" and r["set_number"] == 1)
    r = client.patch(f"/api/sets/{target['id']}", json={"reps": 6, "notes": " grind "})
    assert r.status_code == 200 and r.json()["reps"] == 6 and r.json()["notes"] == "grind"
    clash = client.patch(f"/api/sets/{target['id']}", json={"set_number": 2})
    assert clash.status_code == 409
    assert client.patch(f"/api/sets/{target['id']}", json={"set_type": "bogus"}).status_code == 400
    assert client.delete(f"/api/sets/{target['id']}").status_code == 200
    assert client.delete(f"/api/sets/{target['id']}").status_code == 404
    sid = client.get("/api/sessions").json()[0]["id"]
    assert client.delete(f"/api/sessions/{sid}").status_code == 200
    assert all(r["date"] != "2026-11-05" for r in client.get("/api/sets").json())


def test_dunk_and_measurements(client):
    client.post("/import", json=SAMPLE)
    assert client.post("/api/measurements", json={"date": "2026-11-10", "type": "approach_touch_height", "value": 118}).status_code == 200
    d = client.get("/api/dunk").json()
    assert d["series"]["standing_touch_height"][0]["value"] == 111
    assert d["series"]["approach_touch_height"][0]["value"] == 118
    assert d["series"]["box_jump_height"][0] == {"date": "2026-11-05", "value": 31.5, "unit": "in", "approx": False, "notes": "", "source": "sets"}


def test_pages_and_summary(client):
    client.post("/import", json=SAMPLE)
    for p in ("/", "/log", "/import"):
        assert client.get(p).status_code == 200
    sm = client.get("/api/summary").json()
    assert sm["last_session"]["date"] == "2026-11-05" and sm["next_day"] == "A"  # only A and B so far


def test_backup(tmp_path, client):
    client.post("/import", json=SAMPLE)
    out = tmp_path / "backups"
    for d in range(1, 5):
        backup(client.db, out, keep=3, today=date(2026, 11, d))
    files = sorted(p.name for p in out.iterdir())
    assert files == ["lifting-2026-11-02.db", "lifting-2026-11-03.db", "lifting-2026-11-04.db"]
    assert sqlite3.connect(out / files[-1]).execute("SELECT count(*) FROM sets").fetchone()[0] == 11


def test_people_are_kept_apart(client):
    me = client.post("/import", json=SAMPLE).json()
    assert me["person"] == "Me" and me["person_id"] == 1
    other = copy.deepcopy(SAMPLE)
    other["person"] = "Alex"
    r = client.post("/import", json=other).json()
    assert r["person_created"] and r["person"] == "Alex" and r["sessions_created"] == 2 and r["sets_added"] == 11
    assert client.post("/import", json=other).json()["sets_unchanged"] == 11  # matched by name now
    assert [p["name"] for p in client.get("/api/people").json()] == ["Me", "Alex"]
    # Same exercises, separate numbers.
    assert client.patch("/api/sets/1", json={"weight_lb": 300}).status_code == 200
    me_t = client.get("/api/trend", params={"name": "Belt squat"}).json()["sessions"]
    alex_t = client.get("/api/trend", params={"name": "Belt squat", "person": "alex"}).json()["sessions"]
    assert me_t[0]["top_weight"] == 270 and alex_t[0]["top_weight"] == 270  # set 1 is a warmup
    assert len(client.get("/api/sets", params={"person": 2}).json()) == 11
    assert client.get("/api/summary", params={"person": "Alex"}).json()["person"]["name"] == "Alex"
    assert client.get("/api/summary", params={"person": "Nobody"}).status_code == 404
    # A measurement goes to whoever is picked.
    client.post("/api/measurements", params={"person": 2}, json={"date": "2026-11-10", "type": "bodyweight", "value": 150})
    assert client.get("/api/dunk").json()["series"]["bodyweight"] == []
    assert client.get("/api/dunk", params={"person": 2}).json()["series"]["bodyweight"][0]["value"] == 150
    # Import into the picked person via ?person=.
    r = client.post("/import", params={"person": 2}, json={"sessions": [{"date": "2026-11-20", "day": "C", "sets": [s("Row", 1, 50, 10)]}]}).json()
    assert r["person"] == "Alex"


def test_people_crud(client):
    client.post("/import", json=SAMPLE)
    assert client.post("/api/people", json={"name": "  Sam  "}).json() == {"id": 2, "name": "Sam"}
    assert client.post("/api/people", json={"name": "sam"}).status_code == 409
    assert client.post("/api/people", json={"name": " "}).status_code == 400
    assert client.patch("/api/people/1", json={"name": "Dan"}).json()["name"] == "Dan"
    sid = client.get("/api/sessions").json()[0]["id"]
    assert client.patch(f"/api/sessions/{sid}", json={"person_id": 2}).status_code == 200
    assert len(client.get("/api/sessions", params={"person": "Sam"}).json()) == 1
    assert client.delete("/api/people/1").status_code == 200  # takes their sessions and sets along
    conn = client.app.state.conn
    assert conn.execute("SELECT count(*) FROM sessions").fetchone()[0] == 1
    assert conn.execute("SELECT count(*) FROM sets s LEFT JOIN sessions ss ON ss.id = s.session_id WHERE ss.id IS NULL").fetchone()[0] == 0
    assert client.delete("/api/people/2").status_code == 409  # keep at least one


OLD_SCHEMA = """
CREATE TABLE exercises (id INTEGER PRIMARY KEY, name TEXT NOT NULL, variation TEXT NOT NULL DEFAULT '', muscle_group TEXT, equipment TEXT, UNIQUE (name, variation));
CREATE TABLE sessions (id INTEGER PRIMARY KEY, date TEXT NOT NULL, day_label TEXT NOT NULL DEFAULT '', notes TEXT, UNIQUE (date, day_label));
CREATE TABLE sets (id INTEGER PRIMARY KEY, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, exercise_id INTEGER NOT NULL REFERENCES exercises(id), set_number INTEGER NOT NULL, segment INTEGER NOT NULL DEFAULT 1, set_type TEXT NOT NULL DEFAULT 'working', weight_lb REAL, load_basis TEXT, reps INTEGER, duration_s REAL, height_in REAL, approx INTEGER NOT NULL DEFAULT 0, inferred INTEGER NOT NULL DEFAULT 0, notes TEXT, UNIQUE (session_id, exercise_id, set_number, segment));
CREATE TABLE measurements (id INTEGER PRIMARY KEY, date TEXT NOT NULL, type TEXT NOT NULL, value REAL NOT NULL, unit TEXT NOT NULL, approx INTEGER NOT NULL DEFAULT 0, notes TEXT, UNIQUE (date, type));
INSERT INTO exercises VALUES (1, 'Row', '', 'Back', NULL);
INSERT INTO sessions VALUES (7, '2026-11-03', 'A', 'old');
INSERT INTO sets (session_id, exercise_id, set_number, weight_lb, reps) VALUES (7, 1, 1, 100, 10);
INSERT INTO measurements VALUES (3, '2026-11-03', 'bodyweight', 180, 'lb', 0, NULL);
"""


def test_migrates_a_database_from_before_profiles(tmp_path, monkeypatch):
    path = tmp_path / "old.db"
    old = sqlite3.connect(path)
    old.executescript(OLD_SCHEMA)
    old.close()
    monkeypatch.setenv("LIFTING_DEFAULT_PERSON", "Dan")
    with TestClient(create_app(path)) as c:
        assert c.get("/api/people").json()[0]["name"] == "Dan"
        assert c.get("/api/sessions").json()[0]["id"] == 7
        assert c.get("/api/sets").json()[0]["weight_lb"] == 100
        assert c.get("/api/measurements").json()[0]["value"] == 180
        assert c.app.state.conn.execute("PRAGMA foreign_key_check").fetchall() == []
        assert c.delete("/api/sessions/7").status_code == 200
        assert c.get("/api/sets").json() == []


def test_insights(tmp_path):
    from lifting.db import connect
    from lifting.importer import run_import
    conn = connect(tmp_path / "i.db")
    days = ["2026-10-01", "2026-10-08", "2026-10-15", "2026-10-22"]
    run_import(conn, {"sessions": [
        {"date": d, "day": "A", "sets": [s("Belt squat", 1, 200 + 40 * n, 5), s("Lat pulldown", 1, 100, 10)]}
        for n, d in enumerate(days)
    ]})
    i = metrics.insights(conn, 1, today=date(2026, 10, 23), target=10)
    squat = next(x for x in i["lifts"] if x["name"] == "Belt squat")
    # +40 lb/session is ~47 lb/week of e1RM; the projection caps the weekly gain at 2% of best.
    assert squat["lb_per_week"] > 40 and squat["projection_capped"]
    assert squat["projected_4wk"] == round(squat["best_e1rm"] * 1.08, 1)
    pulldown = next(x for x in i["lifts"] if x["name"] == "Lat pulldown")
    assert pulldown["change_pct"] == 0.0 and pulldown["stalled"] is True
    kinds = [x["kind"] for x in i["shortcomings"]]
    assert kinds[0] == "stalled"
    assert {"group": "Quads", "sets": 1} == {k: next(x for x in i["shortcomings"] if x.get("group") == "Quads")[k] for k in ("group", "sets")}
    assert i["groups_7d"] == {"Back": 1, "Biceps": 0.5, "Glutes": 0.5, "Quads": 1}
    assert i["this_week"] == 2 and i["dunk"] is None


def test_review_fixes(tmp_path):
    from lifting.db import connect
    from lifting.importer import run_import
    assert metrics.epley(300, 1) == 300 and metrics.epley(300, 3) == 330
    conn = connect(tmp_path / "r.db")
    run_import(conn, {"sessions": [
        {"date": "2026-10-01", "day": "A", "sets": [s("Overhead press", 1, 50, 15)]},           # no e1RM (15 reps)
        {"date": "2026-10-03", "day": "B", "sets": [s("Overhead press", 1, 40, 8)]},            # first e1RM: baseline
        {"date": "2026-10-05", "day": "C", "sets": [s("Overhead press", 1, 60, 8, inferred=True)]},  # assumed numbers
        {"date": "2026-10-07", "day": "A", "sets": [s("Overhead press", 1, 45, 8)]},
    ]})
    h = next(iter(metrics.history(conn, 1).values()))["sessions"]
    assert h[1]["pr"] is None and h[2]["pr"] is None
    assert h[2]["e1rm"] == 76.0  # still charted
    assert h[3]["pr"] is None  # 45 x 8 doesn't beat the (assumed) 60 x 8
    assert metrics.next_day(conn, 1) == "B"  # A, B, C used; last was A
    run_import(conn, {"sessions": [{"date": "2026-10-08", "day": "C", "sets": [s("Overhead press", 1, 45, 8)]}]})
    assert metrics.next_day(conn, 1) == "A"  # no D ever logged, so C wraps to A
    # A group idle for 8+ days is flagged once, not also as low volume.
    i = metrics.insights(conn, 1, today=date(2026, 10, 20))
    assert [x["kind"] for x in i["shortcomings"] if x.get("group") == "Shoulders"] == ["idle"]


def test_measurement_edit_is_validated(client):
    client.post("/import", json=SAMPLE)
    mid = client.get("/api/measurements").json()[0]["id"]
    assert client.patch(f"/api/measurements/{mid}", json={"type": "wingspan"}).status_code == 400
    assert client.patch(f"/api/measurements/{mid}", json={"date": "2026-02-31"}).status_code == 400
    assert client.patch(f"/api/measurements/{mid}", json={"value": 112}).json()["value"] == 112
    assert client.post("/api/people", json={"name": "42"}).status_code == 400


def test_effort_changes_the_estimate_and_flags_rough_ones(tmp_path):
    from lifting.db import connect
    from lifting.importer import ImportError_, run_import
    conn = connect(tmp_path / "e.db")
    run_import(conn, {"sessions": [{"date": "2026-10-01", "day": "A", "sets": [
        s("Bench press", 1, 200, 8, rir=2),      # an honest 10-rep weight
        s("Bench press", 2, 200, 8, rpe=10),     # to failure: plain Epley
        s("Lat pulldown", 1, 100, 9, rpe=8),     # 11 effective reps: rough
        s("Leg extension", 1, 100, 12, rir=3),   # 15 effective reps: no estimate
    ]}]})
    rows = {(r["name"], r["set_number"]): r for r in metrics._rows(conn, 1)}
    assert metrics.set_e1rm(rows[("Bench press", 1)]) == pytest.approx(200 * (1 + 10 / 30))
    assert metrics.set_e1rm(rows[("Bench press", 2)]) == pytest.approx(200 * (1 + 8 / 30))
    assert metrics.is_rough(rows[("Lat pulldown", 1)]) and not metrics.is_rough(rows[("Bench press", 1)])
    assert metrics.set_e1rm(rows[("Leg extension", 1)]) is None
    h = {x["name"]: x["sessions"][0] for x in metrics.history(conn, 1).values()}
    assert h["Lat pulldown"]["e1rm_rough"] is True and h["Bench press"]["e1rm_rough"] is False
    assert h["Bench press"]["e1rm_set"]["rir"] == 2
    with pytest.raises(ImportError_):
        run_import(conn, {"sessions": [{"date": "2026-10-02", "sets": [s("Bench press", 1, 200, 8, rpe=11)]}]})


def test_old_database_gains_the_new_columns(tmp_path):
    from lifting.db import connect
    path = tmp_path / "old.db"
    conn = connect(path)
    conn.execute("INSERT INTO exercises (name, variation, muscle_group, secondary) VALUES ('Barbell row', '', 'Back', NULL)")
    conn.execute("ALTER TABLE sets DROP COLUMN rpe")
    conn.execute("ALTER TABLE sets DROP COLUMN rir")
    conn.close()
    conn = connect(path)
    assert {"rpe", "rir"} <= {r[1] for r in conn.execute("PRAGMA table_info(sets)")}
    assert conn.execute("SELECT secondary FROM exercises").fetchone()[0] == "Biceps, Rear delts"


def test_secondary_muscles_from_import_and_edit(client):
    payload = {"sessions": [{"date": "2026-11-03", "day": "A", "sets": [
        s("Cable thing", 1, 50, 10, muscle_group="Back", secondary_muscles=["biceps", "Core"])]}]}
    assert client.post("/import", json=payload).status_code == 200
    ex = client.get("/api/exercises").json()[0]
    assert ex["secondary"] == "Biceps, Core"
    assert client.patch(f"/api/exercises/{ex['id']}", json={"secondary": " rear delts ,, Back"}).json()["secondary"] == "Rear delts, Back"
    v = metrics.volume(client.app.state.conn, 1, 1, today=date(2026, 11, 5))["weeks"][0]
    assert v["groups"] == {"Back": 1, "Rear delts": 0.5} and v["total"] == 1


def test_merge_exercises_keeps_every_set(client):
    client.post("/import", json={"sessions": [{"date": "2026-11-03", "day": "A", "sets": [
        s("Belt squat", 1, 270, 8), s("Belt squat", 2, 270, 8),
        s("Belt squatt", 1, 290, 6), s("Belt squatt", 2, 290, 5),
    ]}, {"date": "2026-11-05", "day": "B", "sets": [s("Belt squatt", 1, 300, 5)]}]})
    ex = {e["name"]: e["id"] for e in client.get("/api/exercises").json()}
    r = client.post(f"/api/exercises/{ex['Belt squatt']}/merge", json={"into": ex["Belt squat"]})
    assert r.status_code == 200 and r.json()["moved"] == 3
    assert [e["name"] for e in client.get("/api/exercises").json()] == ["Belt squat"]
    sets = client.get("/api/sets", params={"from": "2026-11-03", "to": "2026-11-03"}).json()
    assert sorted((x["set_number"], x["weight_lb"]) for x in sets) == [(1, 270), (2, 270), (3, 290), (4, 290)]
    assert client.post(f"/api/exercises/{ex['Belt squat']}/merge", json={"into": ex["Belt squat"]}).status_code == 400
    assert client.post(f"/api/exercises/{ex['Belt squat']}/merge", json={"into": 999}).status_code == 404


def test_monthly_report(client):
    client.post("/import", json=SAMPLE)
    conn = client.app.state.conn
    r = metrics.report(conn, 1, "2026-11", today=date(2026, 11, 12))
    a = r["this"]
    assert a["sessions"] == 2 and a["days"] == ["2026-11-03", "2026-11-05"] and a["working_sets"] == 8
    # 270x8 + 270x10 + 360x5 + 300x12 squats, curls per hand count double
    assert a["volume_lb"] == 270 * 18 + 1800 + 3600 + 2 * (37.5 * 7 + 35 * 8)
    assert a["prs"] == 1 and r["previous"]["sessions"] == 0
    assert r["in_progress"] and r["next_month"] is None and r["previous_month"] is None
    assert client.get("/api/report?month=2026-13").status_code == 422
    assert client.get("/api/report?month=2026-10").json()["next_month"] == "2026-11"
