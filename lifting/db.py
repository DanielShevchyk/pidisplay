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
  date TEXT NOT NULL,
  day_label TEXT NOT NULL DEFAULT '',
  notes TEXT,
  UNIQUE (date, day_label)
);
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
  date TEXT NOT NULL,
  type TEXT NOT NULL,
  value REAL NOT NULL,
  unit TEXT NOT NULL,
  approx INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  UNIQUE (date, type)
);
"""


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
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 5000")
    conn.executescript(SCHEMA)
    return conn


class Tx:
    """BEGIN IMMEDIATE ... COMMIT, rolled back on any exception."""

    def __init__(self, conn: sqlite3.Connection):
        self.conn = conn

    def __enter__(self) -> sqlite3.Connection:
        self.conn.execute("BEGIN IMMEDIATE")
        return self.conn

    def __exit__(self, exc_type, exc, tb) -> None:
        self.conn.execute("ROLLBACK" if exc_type else "COMMIT")
