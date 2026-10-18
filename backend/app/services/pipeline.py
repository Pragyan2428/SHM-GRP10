"""Single processing path for every reading, whatever its source (simulated / HTTP / MQTT):
validate -> classify -> anomaly score -> store -> threshold & early-warning alerts -> node status.
"""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Optional

from pymongo.errors import DuplicateKeyError

from ..db import as_utc, clean, get_db, new_id, utcnow
from . import anomaly, tasks
from .sheets import row_changed
from .thresholds import alert_severity, classify, get_thresholds

log = logging.getLogger("shm.pipeline")

SOURCES = ("simulated", "http", "mqtt")
CLEAR_HYSTERESIS = 0.97      # a breach clears once value < 97% of the safe limit
EW_CLEAR_SCORE = 55          # an early warning clears once the score falls below this
STATUS_RANK = {"nominal": 0, "warning": 1, "critical": 2}

_node_locks: dict[str, asyncio.Lock] = defaultdict(asyncio.Lock)


def reset_locks() -> None:
    _node_locks.clear()


def _alert_id() -> str:
    return "ALT-" + new_id()[:8].upper()


async def process_payload(payload, source: str) -> dict:
    """`payload` is a validated IngestPayload. Returns the processed readings + alert info."""
    assert source in SOURCES
    async with _node_locks[payload.node_id]:
        return await _process(payload, source)


async def _process(payload, source: str) -> dict:
    db = get_db()
    now = utcnow()
    ts: datetime = payload.timestamp or now
    node_id = payload.node_id

    # Device retries with an identical timestamp must not create duplicate readings/alerts.
    if payload.timestamp is not None:
        dup = await db.sensor_readings.find_one({"node_id": node_id, "timestamp": ts}, {"_id": 0})
        if dup:
            existing = await db.sensor_readings.find({"node_id": node_id, "timestamp": ts}, {"_id": 0}).to_list(None)
            return {"node_id": node_id, "duplicate": True, "readings": clean(existing),
                    "alerts": [], "alert_triggered": False}

    node = await db.sensor_nodes.find_one({"node_id": node_id}, {"_id": 0}) or {}
    location = payload.location or node.get("location") or "Unassigned location"
    thresholds = await get_thresholds()

    # 1. anomaly state per parameter
    prev_states = {d["parameter"]: d for d in await db.anomaly_scores.find(
        {"node_id": node_id, "parameter": {"$in": list(payload.readings)}}, {"_id": 0}).to_list(None)}
    states: dict[str, dict] = {}
    for param, value in payload.readings.items():
        states[param] = anomaly.compute(prev_states.get(param), value, thresholds[param])
    anomaly.apply_correlation({p: s for p, s in states.items() if thresholds[p]["enabled"]})

    # 2. readings
    docs = []
    for param, value in payload.readings.items():
        th, st = thresholds[param], states[param]
        docs.append({
            "id": new_id("rd_"), "node_id": node_id, "location": location,
            "parameter": param, "label": th["label"], "value": value, "unit": th["unit"],
            "safe_threshold": th["safe_threshold"], "warning_threshold": th["warning_threshold"],
            "critical_threshold": th["critical_threshold"],
            "status": classify(value, th), "parameter_enabled": th["enabled"],
            "anomaly_score": st["score"], "anomaly_level": st["level"],
            "rolling_avg": st["rolling_avg"], "trend": st["trend"],
            "source": source, "timestamp": ts, "received_at": now,
        })
    if docs:
        await db.sensor_readings.insert_many([dict(d) for d in docs])

    # 3. alerts
    alerts: list[dict] = []
    touched: set[str] = set()  # existing alerts whose Google Sheets row is now out of date
    for doc in docs:
        param = doc["parameter"]
        th, st = thresholds[param], states[param]
        created = await _evaluate_threshold(doc, th, st, now, touched)
        if created:
            alerts.append(created)
        ew = await _evaluate_early_warning(doc, th, st, now, touched)
        if ew:
            alerts.append(ew)

    # 4. persist anomaly state
    for param, st in states.items():
        st.update({"node_id": node_id, "parameter": param, "location": location,
                   "unit": thresholds[param]["unit"], "updated_at": now, "timestamp": ts})
        await db.anomaly_scores.update_one({"node_id": node_id, "parameter": param},
                                           {"$set": st}, upsert=True)

    # 5. node status
    latest = dict(node.get("latest") or {})
    for d in docs:
        latest[d["parameter"]] = {k: d[k] for k in (
            "value", "unit", "status", "anomaly_score", "timestamp", "safe_threshold", "trend")}
    worst = max((STATUS_RANK[v["status"]] for v in latest.values()), default=0)
    node_update = {
        "node_id": node_id, "location": location, "last_seen": now, "last_reading_at": ts,
        "data_source": source, "latest": latest,
        "condition": [k for k, v in STATUS_RANK.items() if v == worst][0],
        "error": payload.error,
    }
    if payload.battery is not None:
        node_update["battery"] = payload.battery
    if payload.rssi is not None:
        node_update["rssi"] = payload.rssi
    if payload.firmware:
        node_update["firmware"] = payload.firmware
    await db.sensor_nodes.update_one(
        {"node_id": node_id},
        {"$set": node_update,
         "$setOnInsert": {"created_at": now, "firmware_default": "unknown",
                          "calibrated_at": now, "label": node_id}},
        upsert=True)
    await db.integration_settings.update_one(
        {"key": "telemetry_meta"}, {"$set": {"value": {"last_reading_at": now, "last_source": source}}},
        upsert=True)

    if alerts:
        tasks.spawn(_after_alerts([a["id"] for a in alerts]), name="alert-followup")
    elif touched:
        from . import sheets
        tasks.spawn(sheets.auto_sync(), name="sheets-sync")

    return {"node_id": node_id, "duplicate": False, "readings": clean(docs),
            "alerts": clean(alerts), "alert_triggered": any(a["type"] == "threshold" for a in alerts)}


async def _after_alerts(alert_ids: list[str]) -> None:
    """Notify first, then append to Google Sheets so the row carries the delivery status."""
    from . import notifications, sheets
    for aid in alert_ids:
        try:
            await notifications.dispatch_alert(aid)
        except Exception:  # noqa: BLE001
            log.exception("Notification dispatch failed for %s", aid)
            await get_db().alert_events.update_one({"id": aid}, row_changed({"notification_status": "failed"}))
    await sheets.auto_sync()


def _base_alert(doc: dict, th: dict, st: dict, now: datetime, kind: str, severity: str, key: str) -> dict:
    return {
        "id": _alert_id(), "type": kind, "parameter": doc["parameter"], "label": th["label"],
        "value": doc["value"], "peak_value": doc["value"], "unit": th["unit"],
        "threshold": th["safe_threshold"], "warning_threshold": th["warning_threshold"],
        "critical_threshold": th["critical_threshold"],
        "node_id": doc["node_id"], "location": doc["location"], "severity": severity,
        "anomaly_score": st["score"], "confidence": st["confidence"], "rolling_avg": st["rolling_avg"],
        "trend": st["trend"], "reason": st["reason"], "reasons": st["reasons"],
        "reading_id": doc["id"], "source": doc["source"], "reading_timestamp": doc["timestamp"],
        "created_at": now, "last_seen_at": now, "occurrences": 1, "active": True, "cleared_at": None,
        "status": "open", "acknowledged_by": None, "acknowledged_at": None, "ack_note": None,
        "notification_status": "pending",
        "notifications": {"email": {"status": "pending"}, "sms": {"status": "pending"},
                          "whatsapp": {"status": "pending"}},
        "sheets_synced": False, "sheets_synced_at": None, "dedupe_key": key,
    }


async def _insert_alert(alert: dict) -> Optional[dict]:
    try:
        await get_db().alert_events.insert_one(dict(alert))
        return alert
    except DuplicateKeyError:
        return None


async def _evaluate_threshold(doc: dict, th: dict, st: dict, now: datetime, touched: set[str]) -> Optional[dict]:
    if not th["enabled"]:
        return None
    db = get_db()
    value, safe = doc["value"], th["safe_threshold"]
    active_id = st.get("active_alert_id")

    if value >= safe:
        if active_id:  # same excursion: update the open event instead of duplicating it
            current = await db.alert_events.find_one({"id": active_id}, {"_id": 0})
            if current and current.get("active"):
                upd = {"last_seen_at": now, "value": value, "anomaly_score": st["score"]}
                inc = {"occurrences": 1}
                if value > current.get("peak_value", value):
                    upd["peak_value"] = value
                if current["severity"] != "critical" and alert_severity(value, th) == "critical":
                    upd["severity"] = "critical"
                    upd["escalated_at"] = now
                    await db.alert_events.update_one({"id": active_id}, row_changed(upd, inc))
                    touched.add(active_id)
                else:
                    await db.alert_events.update_one({"id": active_id}, {"$set": upd, "$inc": inc})
                return None
        started = as_utc(st.get("breach_started_at")) or doc["timestamp"]
        st["breach_started_at"] = started
        if (doc["timestamp"] - started).total_seconds() < th.get("debounce_seconds", 0):
            return None
        last = as_utc(st.get("last_alert_at"))
        if last and now - last < timedelta(seconds=th.get("cooldown_seconds", 0)):
            return None
        key = f"{doc['node_id']}:{doc['parameter']}:threshold:{started.isoformat()}"
        alert = await _insert_alert(_base_alert(doc, th, st, now, "threshold", alert_severity(value, th), key))
        if alert:
            st["active_alert_id"] = alert["id"]
            st["last_alert_at"] = now
            # A hard breach supersedes any early warning for the same sensor.
            if st.get("active_ew_id"):
                await db.alert_events.update_one({"id": st["active_ew_id"]},
                                                 row_changed({"active": False, "cleared_at": now,
                                                              "superseded_by": alert["id"]}))
                st["active_ew_id"] = None
        return alert

    if value < safe * CLEAR_HYSTERESIS:
        st["breach_started_at"] = None
        if active_id:
            await db.alert_events.update_one({"id": active_id}, row_changed({"active": False, "cleared_at": now}))
            touched.add(active_id)
            st["active_alert_id"] = None
    return None


async def _evaluate_early_warning(doc: dict, th: dict, st: dict, now: datetime, touched: set[str]) -> Optional[dict]:
    if not th["enabled"] or st.get("active_alert_id"):
        return None
    db = get_db()
    active_id = st.get("active_ew_id")
    if st["early_warning"]:
        if active_id:
            await db.alert_events.update_one(
                {"id": active_id},
                {"$set": {"last_seen_at": now, "value": doc["value"], "anomaly_score": st["score"],
                          "reason": st["reason"], "reasons": st["reasons"], "confidence": st["confidence"],
                          "rolling_avg": st["rolling_avg"], "trend": st["trend"]},
                 "$inc": {"occurrences": 1}})
            return None
        last = as_utc(st.get("last_ew_at"))
        if last and now - last < timedelta(seconds=th.get("cooldown_seconds", 0)):
            return None
        key = f"{doc['node_id']}:{doc['parameter']}:early_warning:{now.isoformat()}"
        alert = await _insert_alert(_base_alert(doc, th, st, now, "early_warning", "early_warning", key))
        if alert:
            st["active_ew_id"] = alert["id"]
            st["last_ew_at"] = now
        return alert
    if active_id and st["score"] < EW_CLEAR_SCORE:
        await db.alert_events.update_one({"id": active_id}, row_changed({"active": False, "cleared_at": now}))
        touched.add(active_id)
        st["active_ew_id"] = None
    return None
