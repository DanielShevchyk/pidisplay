"""SQLite schema and connection helpers. Weights are stored in lb."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

PLATE_LB = 45
SET_TYPES = ("warmup", "working", "mechanical_drop")
LOAD_BASES = ("total", "per_hand", "per_arm", "per_side")
MEASUREMENT_TYPES = ("bodyweight", "standing_touch_height", "approach_touch_height", "box_jump_height")

SCHEMA = """
CREATE TABLE IF NOT EXISTS people (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE COLLATE NOCASE
);
CREATE TABLE IF NOT EXISTS exercises (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  variation TEXT NOT NULL DEFAULT '',
  muscle_group TEXT,
  equipment TEXT,
  UNIQUE (name, variation)
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  day_label TEXT NOT NULL DEFAULT '',
  notes TEXT,
  UNIQUE (person_id, date, day_label)
);
CREATE INDEX IF NOT EXISTS sessions_person ON sessions (person_id, date);
CREATE TABLE IF NOT EXISTS sets (
  id INTEGER PRIMARY KEY,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  exercise_id INTEGER NOT NULL REFERENCES exercises(id),
  set_number INTEGER NOT NULL,
  segment INTEGER NOT NULL DEFAULT 1,
  set_type TEXT NOT NULL DEFAULT 'working' CHECK (set_type IN ('warmup', 'working', 'mechanical_drop')),
  weight_lb REAL,
  load_basis TEXT CHECK (load_basis IS NULL OR load_basis IN ('total', 'per_hand', 'per_arm', 'per_side')),
  reps INTEGER,
  duration_s REAL,
  height_in REAL,
  approx INTEGER NOT NULL DEFAULT 0,
  inferred INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (session_id, exercise_id, set_number, segment)
);
CREATE INDEX IF NOT EXISTS sets_exercise ON sets (exercise_id);
CREATE TABLE IF NOT EXISTS measurements (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  approx INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (person_id, date, type)
);
"""

# Before profiles, sessions and measurements had no person; they go to the default person.
MIGRATE_TO_PEOPLE = """
CREATE TABLE people (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
INSERT INTO people (id, name) VALUES (1, :name);
CREATE TABLE sessions_new (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  day_label TEXT NOT NULL DEFAULT '',
  notes TEXT,
  UNIQUE (person_id, date, day_label)
);
INSERT INTO sessions_new (id, person_id, date, day_label, notes) SELECT id, 1, date, day_label, notes FROM sessions;
DROP TABLE sessions;
ALTER TABLE sessions_new RENAME TO sessions;
CREATE TABLE measurements_new (
  id INTEGER PRIMARY KEY,
  person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  approx INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (person_id, date, type)
);
INSERT INTO measurements_new (id, person_id, date, type, value, unit, approx, notes)
  SELECT id, 1, date, type, value, unit, approx, notes FROM measurements;
DROP TABLE measurements;
ALTER TABLE measurements_new RENAME TO measurements;
"""


def default_person_name() -> str:
    return (os.environ.get("LIFTING_DEFAULT_PERSON") or "Me").strip() or "Me"


def _migrate(conn: sqlite3.Connection) -> None:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(sessions)")]
    if not cols or "person_id" in cols:
        return
    # Foreign keys off so dropping the old sessions table doesn't cascade into sets.
    conn.execute("PRAGMA foreign_keys = OFF")
    conn.execute("BEGIN IMMEDIATE")
    try:
        for stmt in MIGRATE_TO_PEOPLE.split(";"):
            if stmt.strip():
                conn.execute(stmt, {"name": default_person_name()} if ":name" in stmt else {})
        conn.execute("COMMIT")
    except Exception:
        conn.execute("ROLLBACK")
        raise
    finally:
        conn.execute("PRAGMA foreign_keys = ON")


def db_path() -> Path:
    if os.environ.get("LIFTING_DB"):
        return Path(os.environ["LIFTING_DB"])
    data = os.environ.get("PIDISPLAY_DATA") or str(Path(__file__).resolve().parent.parent / "data")
    return Path(data) / "lifting.db"


def connect(path: Path | str | None = None) -> sqlite3.Connection:
    path = Path(path) if path else db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(path, isolation_level=None, check_same_thread=False, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 5000")
    _migrate(conn)
    conn.execute("PRAGMA foreign_keys = ON")
    conn.executescript(SCHEMA)
    return conn


def default_person(conn: sqlite3.Connection) -> int:
    """The first person; created (named by LIFTING_DEFAULT_PERSON, else "Me") when there are none."""
    row = conn.execute("SELECT id FROM people ORDER BY id LIMIT 1").fetchone()
    if row:
        return row["id"]
    return conn.execute("INSERT INTO people (name) VALUES (?)", (default_person_name(),)).lastrowid


def find_person(conn: sqlite3.Connection, ref: str | int | None) -> int | None:
    """A person by id or name (any case); the default person when ref is empty; None if not found."""
    if ref is None or str(ref).strip() == "":
        return default_person(conn)
    ref = str(ref).strip()
    if ref.isdigit():
        row = conn.execute("SELECT id FROM people WHERE id = ?", (int(ref),)).fetchone()
        if row:
            return row["id"]
    row = conn.execute("SELECT id FROM people WHERE name = ?", (ref,)).fetchone()
    return row["id"] if row else None


class Tx:
    """BEGIN IMMEDIATE ... COMMIT, rolled back on any exception."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self) -> sqlite3.Connection:
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb) -> None:
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
