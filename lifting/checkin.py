"""Morning weigh-ins from PiDisplay's check-in, for the bodyweight chart.

The check-in (server/checkin.js) asks for the morning weight and owns those answers;
this only reads them from PiDisplay's GET /api/checkin/weights?person=<name>, so Dan
doesn't log his weight twice. Nothing is copied into the lifting database. When
PiDisplay is down, slow or has nobody matching, there are simply no check-in weights.
"""
from __future__ import annotations

import asyncio
import json
import os
import time
import urllib.parse
import urllib.request
from typing import Awaitable, Callable

DEFAULT_URL = "http://127.0.0.1:8080"
TIMEOUT_S = 2.0
TTL_S = 60.0

# name -> [{date, value}] (pounds, oldest first); [] for no weigh-ins or no answer.
CheckinWeights = Callable[[str], Awaitable[list[dict]]]


def _fetch(url: str, timeout: float) -> object:
    with urllib.request.urlopen(url, timeout=timeout) as res:
        return json.loads(res.read().decode("utf-8"))


def _clean(data: object) -> list[dict]:
    weights = data.get("weights") if isinstance(data, dict) else None
    out = []
    for w in weights if isinstance(weights, list) else []:
        if not isinstance(w, dict) or not isinstance(w.get("date"), str):
            continue
        v = w.get("value")
        if isinstance(v, (int, float)) and not isinstance(v, bool) and v > 0:
            out.append({"date": w["date"], "value": float(v)})
    return sorted(out, key=lambda w: w["date"])


def checkin_weights(base_url: str | None = None, timeout: float = TIMEOUT_S, ttl: float = TTL_S,
                    fetch: Callable[[str, float], object] = _fetch, clock: Callable[[], float] = time.monotonic) -> CheckinWeights | None:
    """A reader for one PiDisplay (base_url, else $PIDISPLAY_URL, else port 8080 here).
    PIDISPLAY_URL set to empty turns it off (None). Answers, failures included, are
    cached for ttl seconds so a dead PiDisplay isn't asked on every page load."""
    base = os.environ.get("PIDISPLAY_URL", DEFAULT_URL) if base_url is None else base_url
    if not base:
        return None
    cache: dict[str, tuple[float, list[dict]]] = {}

    async def get(name: str) -> list[dict]:
        hit = cache.get(name.lower())
        if hit and clock() - hit[0] < ttl:
            return hit[1]
        url = f"{base.rstrip('/')}/api/checkin/weights?{urllib.parse.urlencode({'person': name})}"
        try:
            # urllib blocks, so it runs on a worker thread and the event loop (and the
            # SQLite connection's handlers) keep going meanwhile.
            weights = _clean(await asyncio.to_thread(fetch, url, timeout))
        except Exception:
            weights = []
        cache[name.lower()] = (clock(), weights)
        return weights

    return get
