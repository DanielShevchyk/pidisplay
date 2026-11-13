"""Best-guess muscle group and equipment for exercises the import doesn't describe.

Both can be changed on the Log page (Exercises tab); a value given in the import JSON
(muscle_group / equipment on a set) wins over these guesses.
"""
from __future__ import annotations

# Lowercase substrings of the exercise name, checked in order; first hit wins.
MUSCLE_GROUPS: list[tuple[str, str]] = [
    ("spider curl", "Biceps"),
    ("hammer curl", "Biceps"),
    ("preacher", "Biceps"),
    ("bicep", "Biceps"),
    ("leg curl", "Hamstrings"),
    ("hamstring", "Hamstrings"),
    ("romanian", "Hamstrings"),
    ("rdl", "Hamstrings"),
    ("nordic", "Hamstrings"),
    ("curl", "Biceps"),
    ("skull crusher", "Triceps"),
    ("pushdown", "Triceps"),
    ("tricep", "Triceps"),
    ("dip", "Triceps"),
    ("reverse pec deck", "Rear delts"),
    ("rear delt", "Rear delts"),
    ("face pull", "Rear delts"),
    ("lateral raise", "Side delts"),
    ("overhead press", "Shoulders"),
    ("shoulder press", "Shoulders"),
    ("bench", "Chest"),
    ("chest press", "Chest"),
    ("fly", "Chest"),
    ("pec deck", "Chest"),
    ("push-up", "Chest"),
    ("pushup", "Chest"),
    ("incline", "Chest"),
    ("pulldown", "Back"),
    ("pull-up", "Back"),
    ("pullup", "Back"),
    ("chin", "Back"),
    ("row", "Back"),
    ("squat", "Quads"),
    ("leg press", "Quads"),
    ("leg extension", "Quads"),
    ("lunge", "Quads"),
    ("split squat", "Quads"),
    ("step-up", "Quads"),
    ("hip abduction", "Glutes"),
    ("hip thrust", "Glutes"),
    ("glute", "Glutes"),
    ("deadlift", "Back"),
    ("calf", "Calves"),
    ("plank", "Core"),
    ("crunch", "Core"),
    ("ab ", "Core"),
    ("pallof", "Core"),
    ("box jump", "Plyometrics"),
    ("broad jump", "Plyometrics"),
    ("jump", "Plyometrics"),
    ("bound", "Plyometrics"),
]

EQUIPMENT: list[tuple[str, str]] = [
    ("dumbbell", "Dumbbell"),
    ("db ", "Dumbbell"),
    ("ez-bar", "EZ bar"),
    ("ez bar", "EZ bar"),
    ("barbell", "Barbell"),
    ("cable", "Cable"),
    ("pulldown", "Cable"),
    ("pushdown", "Cable"),
    ("fly", "Cable"),
    ("machine", "Machine"),
    ("plate-loaded", "Machine"),
    ("pec deck", "Machine"),
    ("leg curl", "Machine"),
    ("belt squat", "Machine"),
    ("hip abduction", "Machine"),
    ("leg press", "Machine"),
    ("box", "Box"),
    ("plank", "Bodyweight"),
    ("jump", "Bodyweight"),
]

# Muscles an exercise also works, each credited half a set in the weekly volume.
# Checked in order; first hit wins. An empty list means "nothing else worth counting".
SECONDARY: list[tuple[str, list[str]]] = [
    ("leg curl", []),
    ("curl", []),
    ("fly", []),
    ("pec deck", []),
    ("lateral raise", []),
    ("extension", []),
    ("pushdown", []),
    ("skull crusher", []),
    ("face pull", []),
    ("romanian", ["Glutes", "Back"]),
    ("rdl", ["Glutes", "Back"]),
    ("deadlift", ["Glutes", "Hamstrings"]),
    ("overhead press", ["Triceps"]),
    ("shoulder press", ["Triceps"]),
    ("bench", ["Triceps", "Shoulders"]),
    ("chest press", ["Triceps", "Shoulders"]),
    ("push-up", ["Triceps", "Shoulders"]),
    ("pushup", ["Triceps", "Shoulders"]),
    ("incline", ["Triceps", "Shoulders"]),
    ("dip", ["Chest", "Shoulders"]),
    ("pulldown", ["Biceps"]),
    ("pull-up", ["Biceps"]),
    ("pullup", ["Biceps"]),
    ("chin-up", ["Biceps"]),
    ("chin up", ["Biceps"]),
    ("chinup", ["Biceps"]),
    ("row", ["Biceps", "Rear delts"]),
    ("hip thrust", ["Hamstrings"]),
    ("squat", ["Glutes"]),
    ("leg press", ["Glutes"]),
    ("lunge", ["Glutes"]),
    ("step-up", ["Glutes"]),
]


def _match(table, text: str):
    text = f" {text.lower()} "
    for needle, value in table:
        if needle in text:
            return value
    return None


def guess_muscle_group(name: str, variation: str = "") -> str | None:
    return _match(MUSCLE_GROUPS, name) or _match(MUSCLE_GROUPS, variation)


def guess_equipment(name: str, variation: str = "") -> str | None:
    return _match(EQUIPMENT, f"{name} {variation}")


def guess_secondary(name: str, variation: str = "", primary: str | None = None) -> str:
    """Comma-separated secondary muscle groups ('' when none), never repeating the primary."""
    found = _match(SECONDARY, name)  # type: ignore[arg-type]
    return ", ".join(g for g in (found or []) if g != primary)


def clean_secondary(value, primary: str | None = None) -> str:
    """Normalizes a list or comma-separated string of muscle groups to 'A, B'."""
    if value is None:
        return ""
    parts = value if isinstance(value, (list, tuple)) else str(value).split(",")
    out: list[str] = []
    for p in parts:
        p = " ".join(str(p).split())
        if p and p.lower() not in [o.lower() for o in out] and p.lower() != (primary or "").lower():
            out.append(p[:1].upper() + p[1:])
    return ", ".join(out)
