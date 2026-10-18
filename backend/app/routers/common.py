"""Shared query builders for alert/reading listings and CSV export."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from ..services.thresholds import PARAMETERS


def _utc(dt: Optional[datetime]) -> Optional[datetime]:
    if dt and dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt


def _date_range(field: str, date_from, date_to) -> dict:
    rng = {}
    if date_from:
        rng["$gte"] = _utc(date_from)
    if date_to:
        rng["$lte"] = _utc(date_to)
    return {field: rng} if rng else {}


def _search(q: Optional[str], fields: list[str]) -> dict:
    if not q or not q.strip():
        return {}
    rx = {"$regex": re.escape(q.strip()), "$options": "i"}
    return {"$or": [{f: rx} for f in fields]}


def _check_param(parameter: Optional[str]) -> None:
    if parameter and parameter not in PARAMETERS:
        raise HTTPException(422, f"Unknown parameter '{parameter}'")


def alert_query(*, type=None, parameter=None, node_id=None, severity=None, status=None,
                notification_status=None, active=None, q=None, date_from=None, date_to=None) -> dict:
    _check_param(parameter)
    f: dict = {}
    if type:
        f["type"] = type
    if parameter:
        f["parameter"] = parameter
    if node_id:
        f["node_id"] = node_id.upper()
    if severity:
        f["severity"] = {"$in": severity.split(",")}
    if status:
        f["status"] = status
    if notification_status:
        f["notification_status"] = notification_status
    if active is not None:
        f["active"] = active
    f.update(_date_range("created_at", date_from, date_to))
    f.update(_search(q, ["id", "location", "node_id", "label", "parameter", "reason"]))
    return f


def reading_query(*, parameter=None, node_id=None, status=None, source=None, q=None,
                  date_from=None, date_to=None) -> dict:
    _check_param(parameter)
    f: dict = {}
    if parameter:
        f["parameter"] = parameter
    if node_id:
        f["node_id"] = node_id.upper()
    if status:
        f["status"] = {"$in": status.split(",")}
    if source:
        f["source"] = source
    f.update(_date_range("timestamp", date_from, date_to))
    f.update(_search(q, ["location", "node_id", "label", "parameter"]))
    return f
