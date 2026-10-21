"""Which floor a sensor node is on, so the building view can be drawn from the nodes that report.

A node's floor is an int (0 = ground, 1 = first floor, -1 = basement, ...) or "roof". Devices
can send it as `floor`; otherwise it is read from the location text they send, for example
"Ground floor - column C2", "2nd floor slab", "Floor 3", "Level 4", "GF", "3F", "Basement 2" or
"Roof - water tank". Unknown -> None (the node is shown beside the building).
"""
from __future__ import annotations

import re
from typing import Optional, Union

Floor = Union[int, str]  # int floor number or "roof"
ROOF = "roof"
MIN_FLOOR, MAX_FLOOR = -5, 200

_WORDS = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5, "sixth": 6, "seventh": 7, "eighth": 8,
          "ninth": 9, "tenth": 10, "eleventh": 11, "twelfth": 12}
_WORD_RE = "|".join(_WORDS)
_PATTERNS: list[tuple[re.Pattern, object]] = [
    (re.compile(r"\b(roof|rooftop|terrace)\b"), ROOF),
    (re.compile(r"\b(lower\s+ground|basement|cellar)(?:\s*(\d+))?\b"), "basement"),
    (re.compile(r"\b(ground|gf|g/f|plinth|foundation|footing|pile\s*cap)\b"), 0),
    (re.compile(rf"\b({_WORD_RE})\s+(floor|storey|story|level)\b"), "word"),
    (re.compile(r"\b(\d{1,3})\s*(?:st|nd|rd|th)?\s*(?:floor|storey|story|level)\b"), "number"),
    (re.compile(r"\b(?:floor|storey|story|level)\s*(?:no\.?\s*)?(\d{1,3})\b"), "number"),
    (re.compile(r"\b(\d{1,3})f\b"), "number"),
]


def _clamp(n: int) -> Optional[int]:
    return n if MIN_FLOOR <= n <= MAX_FLOOR else None


def floor_from_location(location: Optional[str]) -> Optional[Floor]:
    text = (location or "").lower()
    for pattern, kind in _PATTERNS:
        m = pattern.search(text)
        if not m:
            continue
        if kind == ROOF or kind == 0:
            return kind
        if kind == "basement":
            return _clamp(-(int(m.group(2)) if m.group(2) else 1))
        if kind == "word":
            return _WORDS[m.group(1)]
        return _clamp(int(m.group(1)))
    return None


def normalise_floor(value) -> Optional[Floor]:
    """A `floor` sent by a device: a number, a numeric string, "roof", or text like "2nd floor"."""
    if value is None or isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return _clamp(int(value))
    text = str(value).strip().lower()
    if not text:
        return None
    if re.fullmatch(r"-?\d{1,3}", text):
        return _clamp(int(text))
    return floor_from_location(text)
