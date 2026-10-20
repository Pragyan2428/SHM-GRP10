"""Threshold configuration and reading classification.

Semantics per parameter:
  value <  warning_threshold              -> status "nominal"
  warning_threshold <= value < safe       -> status "warning"  (approaching the limit)
  value >= safe_threshold                 -> status "critical" (limit exceeded -> threshold alert)
  value >= critical_threshold             -> the threshold alert is escalated to severity "critical"
                                             (between safe and critical it is severity "major")
"""
from __future__ import annotations

from typing import Optional

from pymongo.errors import DuplicateKeyError

from ..db import get_db, utcnow

# The three sensors on each node (project hardware): HX711 strain gauge amplifier,
# ADXL345 3-axis accelerometer and DS18B20 digital temperature sensor.
PARAMETERS = ["strain", "vibration", "temperature"]

DEFAULTS = {
    "strain": {"label": "Strain", "unit": "με", "safe_threshold": 620.0, "decimals": 1,
               "sensor": "HX711 strain gauge"},
    "vibration": {"label": "Vibration", "unit": "g", "safe_threshold": 1.8, "decimals": 3,
                  "sensor": "ADXL345 accelerometer"},
    "temperature": {"label": "Temperature", "unit": "°C", "safe_threshold": 42.0, "decimals": 1,
                    "sensor": "DS18B20 temperature sensor"},
}

SEVERITY_RANK = {"early_warning": 1, "major": 2, "critical": 3}

_cache: Optional[dict] = None


def default_doc(param: str) -> dict:
    d = DEFAULTS[param]
    safe = d["safe_threshold"]
    return {
        "parameter": param, "label": d["label"], "unit": d["unit"], "decimals": d["decimals"], "sensor": d["sensor"],
        "safe_threshold": safe,
        "warning_threshold": round(safe * 0.8, 3),
        "critical_threshold": round(safe * 1.25, 3),
        "debounce_seconds": 0, "cooldown_seconds": 300, "enabled": True,
        "updated_by": "system", "updated_at": utcnow(),
    }


async def seed_thresholds() -> None:
    for p in PARAMETERS:
        if not await get_db().thresholds.find_one({"parameter": p}):
            try:
                await get_db().thresholds.insert_one(default_doc(p))
            except DuplicateKeyError:
                pass  # another API instance starting at the same moment seeded it first
    invalidate()


def invalidate() -> None:
    global _cache
    _cache = None


async def get_thresholds() -> dict[str, dict]:
    global _cache
    if _cache is None:
        docs = await get_db().thresholds.find({}, {"_id": 0}).to_list(None)
        cache = {d["parameter"]: d for d in docs}
        for p in PARAMETERS:  # never fail processing because a doc is missing
            cache.setdefault(p, default_doc(p))
        _cache = cache
    return _cache


def classify(value: float, th: dict) -> str:
    if value >= th["safe_threshold"]:
        return "critical"
    if value >= th["warning_threshold"]:
        return "warning"
    return "nominal"


def alert_severity(value: float, th: dict) -> str:
    return "critical" if value >= th["critical_threshold"] else "major"
