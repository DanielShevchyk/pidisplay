"""Nightly backup: copies the live database (safely, while the service runs) to a dated file.

python3 -m lifting.backup  ->  $PIDISPLAY_DATA/lifting-backups/lifting-YYYY-MM-DD.db
Keeps the newest LIFTING_BACKUP_KEEP (default 60) backups. Uses only the standard library.
"""
from __future__ import annotations

import os
import sqlite3
import sys
from datetime import date
from pathlib import Path

from .db import db_path


def backup(src: Path, dest_dir: Path, keep: int = 60, today: date | None = None) -> Path:
    if not src.exists():
        raise FileNotFoundError(f"No database at {src}")
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / f"lifting-{(today or date.today()).isoformat()}.db"
    tmp = dest.with_suffix(".db.tmp")
    tmp.unlink(missing_ok=True)
    live, out = sqlite3.connect(src), sqlite3.connect(tmp)
    try:
        live.backup(out)
        # A plain single-file copy: no -wal/-shm files next to the backups.
        out.execute("PRAGMA journal_mode = DELETE")
        ok = out.execute("PRAGMA integrity_check").fetchone()[0]
    finally:
        live.close()
        out.close()
    if ok != "ok":
        tmp.unlink(missing_ok=True)
        raise RuntimeError(f"Backup failed integrity check: {ok}")
    tmp.replace(dest)
    for old in sorted(dest_dir.glob("lifting-*.db"))[:-keep] if keep > 0 else []:
        old.unlink()
    return dest


def main() -> int:
    src = db_path()
    dest_dir = Path(os.environ.get("LIFTING_BACKUP_DIR") or src.parent / "lifting-backups")
    dest = backup(src, dest_dir, int(os.environ.get("LIFTING_BACKUP_KEEP", "60")))
    print(f"Backed up {src} to {dest}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
