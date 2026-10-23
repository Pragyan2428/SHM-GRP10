"""Telemetry, ingestion, alert events, sensor nodes and anomaly endpoints."""
from __future__ import annotations

from datetime import datetime, timedelta
from typing import Literal, Optional

from fastapi import APIRouter, Depends, Header, HTTPException, Query, Request, Response
from pydantic import ValidationError

from ..config import Settings, get_settings
from ..db import as_utc, audit, clean, get_db, get_setting, utcnow
from ..models import AckRequest, IngestPayload, MqttTest, NodeCreate, NodeUpdate
from ..security import current_user, device_owner, require_admin
from ..services import pipeline, sheets, tasks
from ..services.floors import floor_from_location
from ..services.thresholds import DEFAULTS, PARAMETERS, get_thresholds
from .common import alert_query, reading_query

router = APIRouter(prefix="/api", tags=["monitoring"])

CALIBRATION_INTERVAL_DAYS = 180


def _node_view(node: dict, settings: Settings) -> dict:
    now = utcnow()
    last_seen = as_utc(node.get("last_seen"))
    online = bool(last_seen and (now - last_seen).total_seconds() <= settings.node_offline_seconds)
    calibrated_at = as_utc(node.get("calibrated_at"))
    cal_due = calibrated_at and now - calibrated_at > timedelta(days=CALIBRATION_INTERVAL_DAYS)
    battery = node.get("battery")
    error = node.get("error")
    if not error and battery is not None and battery < 15:
        error = "Low battery"
    return clean({
        "node_id": node["node_id"], "label": node.get("label", node["node_id"]),
        "location": node.get("location"), "online": online,
        "status": "online" if online else "offline", "last_seen": last_seen,
        "battery": battery, "rssi": node.get("rssi"),
        "firmware": node.get("firmware") or node.get("firmware_default", "unknown"),
        "data_source": node.get("data_source"), "condition": node.get("condition", "nominal") if online else "offline",
        "calibration_status": "due" if cal_due else "calibrated", "calibrated_at": calibrated_at,
        "latest": node.get("latest", {}), "last_reading_at": node.get("last_reading_at"),
        "error": error, "map_x": node.get("map_x"), "map_y": node.get("map_y"),
        "floor": node.get("floor") if node.get("floor") is not None else floor_from_location(node.get("location")),
        "plan_x": node.get("plan_x"), "plan_y": node.get("plan_y"), "owner_id": node.get("owner_id"),
    })


async def visible_node_ids(user: dict) -> Optional[list[str]]:
    """None = every node (administrators); otherwise the nodes this account's own devices sent."""
    if user.get("role") == "admin":
        return None
    return [n["node_id"] for n in await get_db().sensor_nodes.find({"owner_id": user["id"]}, {"_id": 0, "node_id": 1}).to_list(None)]


def _restrict(f: dict, ids: Optional[list[str]]) -> dict:
    if ids is None:
        return f
    wanted = f.get("node_id")
    f["node_id"] = (wanted if wanted in ids else {"$in": []}) if isinstance(wanted, str) else {"$in": ids}
    return f


async def _connection(settings: Settings, last: Optional[datetime] = None, own: bool = False) -> tuple[str, Optional[datetime]]:
    if not own:
        meta = await get_setting("telemetry_meta")
        last = as_utc(meta.get("last_reading_at"))
    if not last:
        return "no_data", None
    age = (utcnow() - last).total_seconds()
    if age <= max(15, settings.simulator_interval_seconds * 3):
        return "healthy", last
    if age <= settings.node_offline_seconds * 2:
        return "degraded", last
    return "stale", last


@router.get("/telemetry")
async def telemetry(user: dict = Depends(current_user), settings: Settings = Depends(get_settings),
                    points: int = Query(30, ge=5, le=200),
                    owner: Optional[str] = Query(None, max_length=64, description="admins: one account's nodes ('site' = the site's own)")):
    db = get_db()
    thresholds = await get_thresholds()
    ids = await visible_node_ids(user)
    # each account names its own building; admins see the site's name (or the account's they look at)
    structure_name = settings.structure_name
    building_photo = None
    who = user["id"] if ids is not None else (owner if owner and owner != "site" else None)
    if who:
        u = await db.users.find_one({"id": who}, {"_id": 0, "building_name": 1, "building_photo": 1})
        structure_name = (u or {}).get("building_name") or "My building"
        building_photo = (u or {}).get("building_photo")
    if owner and ids is None:  # an administrator looking at one account's building
        ids = [n["node_id"] for n in await db.sensor_nodes.find(
            {"owner_id": None if owner == "site" else owner}, {"_id": 0, "node_id": 1}).to_list(None)]
    mine = _restrict({}, ids)
    nodes = [_node_view(n, settings) for n in await db.sensor_nodes.find(mine, {"_id": 0}).to_list(None)]
    states = {(s["node_id"], s["parameter"]): s for s in await db.anomaly_scores.find(
        mine, {"_id": 0, "recent": 0, "baseline_var": 0}).to_list(None)}

    params = []
    for p in PARAMETERS:
        th = thresholds[p]
        per_node = []
        for n in nodes:
            r = n["latest"].get(p)
            if r:
                per_node.append({"node_id": n["node_id"], "location": n["location"], "online": n["online"], **r})
        focal = max(per_node, key=lambda r: (r["online"], r["value"] / th["safe_threshold"]), default=None)
        series, anomaly = [], None
        if focal:
            rows = await db.sensor_readings.find(
                {"node_id": focal["node_id"], "parameter": p}, {"_id": 0, "value": 1, "timestamp": 1}
            ).sort("timestamp", -1).limit(points).to_list(None)
            series = [{"t": as_utc(r["timestamp"]), "v": r["value"]} for r in reversed(rows)]
            st = states.get((focal["node_id"], p))
            if st:
                anomaly = {k: st.get(k) for k in ("score", "level", "trend", "rolling_avg", "rolling_std",
                                                  "confidence", "reason", "reasons", "consecutive_rises",
                                                  "ratio", "early_warning")}
        params.append({
            "parameter": p, "label": th["label"], "unit": th["unit"], "decimals": th.get("decimals", 2),
            "sensor": th.get("sensor") or DEFAULTS[p]["sensor"],
            "safe_threshold": th["safe_threshold"], "warning_threshold": th["warning_threshold"],
            "critical_threshold": th["critical_threshold"], "enabled": th["enabled"],
            "current": focal, "readings": per_node, "series": series, "anomaly": anomaly,
        })

    own_last = max((n["last_seen"] for n in nodes if n.get("last_seen")), default=None)
    connection, last = await _connection(settings, own_last, own=ids is not None)
    system = await get_setting("system", {"simulator_enabled": settings.simulator_enabled})
    recent_states = [s for s in states.values()
                     if as_utc(s.get("updated_at")) and utcnow() - as_utc(s["updated_at"]) < timedelta(minutes=5)]
    open_alerts = await db.alert_events.count_documents({"status": "open", "type": "threshold", **mine})
    open_warnings = await db.alert_events.count_documents({"status": "open", "type": "early_warning", **mine})
    active_nodes = sum(1 for n in nodes if n["online"])
    critical_now = any(r["status"] == "critical" for p in params for r in p["readings"] if r["online"])
    system_status = ("critical" if critical_now or open_alerts else
                     "warning" if open_warnings or connection != "healthy" else "nominal")
    return clean({
        "server_time": utcnow(), "structure_name": structure_name, "building_photo": building_photo, "building_owner": who,
        "connection": connection, "last_reading_at": last,
        "simulator_enabled": system.get("simulator_enabled"),
        "system_status": system_status,
        "active_nodes": active_nodes, "total_nodes": len(nodes),
        "open_alerts": open_alerts, "open_early_warnings": open_warnings,
        "overall_anomaly_score": round(max((s["score"] for s in recent_states), default=0), 1),
        "parameters": params,
        "nodes": [{k: n[k] for k in ("node_id", "location", "online", "condition", "map_x", "map_y", "floor",
                                     "plan_x", "plan_y", "owner_id",
                                     "latest", "last_seen", "battery", "rssi")} for n in nodes],
    })


@router.get("/telemetry/history")
async def telemetry_history(
    user: dict = Depends(current_user),
    parameter: Optional[str] = None, node_id: Optional[str] = None, status: Optional[str] = None,
    source: Optional[str] = None, q: Optional[str] = Query(None, max_length=100),
    date_from: Optional[datetime] = None, date_to: Optional[datetime] = None,
    sort: Literal["newest", "oldest"] = "newest",
    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=500),
):
    f = _restrict(reading_query(parameter=parameter, node_id=node_id, status=status, source=source, q=q,
                                date_from=date_from, date_to=date_to), await visible_node_ids(user))
    coll = get_db().sensor_readings
    total = await coll.count_documents(f)
    items = await coll.find(f, {"_id": 0}).sort("timestamp", -1 if sort == "newest" else 1) \
        .skip((page - 1) * page_size).limit(page_size).to_list(None)
    return {"items": clean(items), "total": total, "page": page, "page_size": page_size,
            "pages": max(1, -(-total // page_size))}


# ---- ingestion -------------------------------------------------------------------
@router.post("/ingest")
async def ingest(payload: IngestPayload, x_device_key: Optional[str] = Header(default=None),
                 settings: Settings = Depends(get_settings)):
    owner = await device_owner(payload.node_id, x_device_key, settings)
    try:
        result = await pipeline.process_payload(payload, "http", owner["id"] if owner else None)
    except pipeline.NodeOwnershipError as exc:
        raise HTTPException(409, str(exc))
    return {"ok": True, **result}


@router.post("/mqtt/test")
async def mqtt_test(body: MqttTest, request: Request, user: dict = Depends(require_admin)):
    svc = request.app.state.mqtt
    out: dict = {"status": svc.status()}
    if body.payload is not None:
        topic = body.topic or f"shm/{body.payload.get('node_id', 'ESP32-TEST')}/telemetry"
        try:
            out["processed"] = await svc.handle_message(topic, dict(body.payload))
            out["ok"] = True
            out["message"] = f"Payload on {topic} processed through the MQTT pipeline"
        except (ValueError, ValidationError) as exc:
            raise HTTPException(422, f"MQTT payload rejected: {exc}")
    else:
        out.update(await svc.test_connection())
    await audit(user, "mqtt_test", "mqtt", {"ok": out.get("ok")})
    return out


# ---- alert events ----------------------------------------------------------------
@router.get("/events")
async def list_events(
    user: dict = Depends(current_user),
    type: Optional[Literal["threshold", "early_warning"]] = None,
    parameter: Optional[str] = None, node_id: Optional[str] = None,
    severity: Optional[str] = None, status: Optional[Literal["open", "acknowledged"]] = None,
    notification_status: Optional[Literal["pending", "sent", "failed", "disabled"]] = None,
    active: Optional[bool] = None, q: Optional[str] = Query(None, max_length=100),
    date_from: Optional[datetime] = None, date_to: Optional[datetime] = None,
    sort: Literal["newest", "oldest"] = "newest",
    page: int = Query(1, ge=1), page_size: int = Query(25, ge=1, le=200),
):
    f = _restrict(alert_query(type=type, parameter=parameter, node_id=node_id, severity=severity, status=status,
                              notification_status=notification_status, active=active, q=q,
                              date_from=date_from, date_to=date_to), await visible_node_ids(user))
    coll = get_db().alert_events
    total = await coll.count_documents(f)
    items = await coll.find(f, {"_id": 0, "dedupe_key": 0}).sort("created_at", -1 if sort == "newest" else 1) \
        .skip((page - 1) * page_size).limit(page_size).to_list(None)
    return {"items": clean(items), "total": total, "page": page, "page_size": page_size,
            "pages": max(1, -(-total // page_size))}


@router.post("/events/{event_id}/acknowledge")
async def acknowledge(event_id: str, body: Optional[AckRequest] = None, user: dict = Depends(require_admin)):
    coll = get_db().alert_events
    alert = await coll.find_one({"id": event_id}, {"_id": 0})
    if not alert:
        raise HTTPException(404, "Alert not found")
    if alert["status"] == "acknowledged":
        raise HTTPException(409, f"Already acknowledged by {alert.get('acknowledged_by')}")
    now = utcnow()
    upd = {"status": "acknowledged", "acknowledged_by": user["email"], "acknowledged_by_name": user.get("name"),
           "acknowledged_at": now, "ack_note": body.note if body else None}
    await coll.update_one({"id": event_id}, sheets.row_changed(upd))
    await audit(user, "alert_acknowledged", event_id, {"note": upd["ack_note"]})
    tasks.spawn(sheets.auto_sync(), name="sheets-sync")  # the alert's row now shows who acknowledged it
    alert.update(upd)
    alert.pop("dedupe_key", None)
    return clean(alert)


# ---- nodes -----------------------------------------------------------------------
@router.get("/nodes")
async def list_nodes(user: dict = Depends(current_user), settings: Settings = Depends(get_settings)):
    db = get_db()
    nodes = await db.sensor_nodes.find(_restrict({}, await visible_node_ids(user)), {"_id": 0}).sort("node_id", 1).to_list(None)
    items = [_node_view(n, settings) for n in nodes]
    if user.get("role") == "admin":
        emails = {u["id"]: u["email"] for u in await db.users.find({}, {"_id": 0, "id": 1, "email": 1}).to_list(None)}
        for it in items:
            it["owner_email"] = emails.get(it["owner_id"]) if it["owner_id"] else None
    return {"items": items}


async def _owner_or_none(owner_id: Optional[str]) -> Optional[str]:
    if not owner_id:
        return None
    if not await get_db().users.find_one({"id": owner_id}, {"_id": 1}):
        raise HTTPException(422, "That account does not exist")
    return owner_id


@router.post("/nodes", status_code=201)
async def create_node(body: NodeCreate, user: dict = Depends(require_admin), settings: Settings = Depends(get_settings)):
    """Register a node before it reports (it shows as offline until its first reading)."""
    db = get_db()
    if await db.sensor_nodes.find_one({"node_id": body.node_id}, {"_id": 1}):
        raise HTTPException(409, f"A node called {body.node_id} already exists")
    now = utcnow()
    doc = {"node_id": body.node_id, "label": body.node_id, "location": (body.location or "").strip() or "Unassigned location",
           "owner_id": await _owner_or_none(body.owner_id), "plan_x": body.plan_x, "plan_y": body.plan_y,
           "created_at": now, "calibrated_at": now, "firmware_default": "unknown", "latest": {}, "registered_by": user["email"]}
    if body.floor is not None:
        doc["floor"] = body.floor
    await db.sensor_nodes.insert_one(dict(doc))
    await audit(user, "node_created", body.node_id, {"owner_id": doc["owner_id"], "floor": body.floor})
    return _node_view(doc, settings)


@router.patch("/nodes/{node_id}")
async def update_node(node_id: str, body: NodeUpdate, user: dict = Depends(require_admin),
                      settings: Settings = Depends(get_settings)):
    db = get_db()
    node_id = node_id.upper()
    if not await db.sensor_nodes.find_one({"node_id": node_id}, {"_id": 1}):
        raise HTTPException(404, "Sensor node not found")
    sent = body.model_fields_set
    changes: dict = {}
    unset: dict = {}
    if "location" in sent and body.location is not None:
        changes["location"] = body.location.strip() or "Unassigned location"
    if "floor" in sent:
        if body.floor is None:
            unset["floor"] = ""  # back to reading it from the location text
        else:
            changes["floor"] = body.floor
    for k in ("plan_x", "plan_y"):
        if k in sent:
            changes[k] = getattr(body, k)
    if "owner_id" in sent:
        changes["owner_id"] = await _owner_or_none(body.owner_id)
    update = {**({"$set": changes} if changes else {}), **({"$unset": unset} if unset else {})}
    if update:
        await db.sensor_nodes.update_one({"node_id": node_id}, update)
    await audit(user, "node_updated", node_id, {k: v for k, v in changes.items()})
    return _node_view(await db.sensor_nodes.find_one({"node_id": node_id}, {"_id": 0}), settings)


@router.delete("/nodes/{node_id}", status_code=204)
async def delete_node(node_id: str, user: dict = Depends(require_admin)):
    """Remove a node from the site. Its past readings and alerts stay in the history."""
    db = get_db()
    node_id = node_id.upper()
    if (await db.sensor_nodes.delete_one({"node_id": node_id})).deleted_count == 0:
        raise HTTPException(404, "Sensor node not found")
    await db.anomaly_scores.delete_many({"node_id": node_id})
    await audit(user, "node_deleted", node_id)
    return Response(status_code=204)


@router.get("/nodes/{node_id}")
async def node_detail(node_id: str, user: dict = Depends(current_user), settings: Settings = Depends(get_settings),
                      points: int = Query(120, ge=10, le=1000)):
    db = get_db()
    node = await db.sensor_nodes.find_one({"node_id": node_id.upper()}, {"_id": 0})
    if not node or (user.get("role") != "admin" and node.get("owner_id") != user["id"]):
        raise HTTPException(404, "Sensor node not found")  # someone else's node looks the same as no node
    thresholds = await get_thresholds()
    series = {}
    for p in PARAMETERS:
        rows = await db.sensor_readings.find(
            {"node_id": node["node_id"], "parameter": p},
            {"_id": 0, "value": 1, "timestamp": 1, "status": 1, "anomaly_score": 1},
        ).sort("timestamp", -1).limit(points).to_list(None)
        series[p] = [{"t": as_utc(r["timestamp"]), "v": r["value"], "s": r["status"],
                      "a": r.get("anomaly_score")} for r in reversed(rows)]
    anomalies = await db.anomaly_scores.find({"node_id": node["node_id"]},
                                             {"_id": 0, "recent": 0, "baseline_var": 0}).to_list(None)
    alerts = await db.alert_events.find({"node_id": node["node_id"]}, {"_id": 0, "dedupe_key": 0}) \
        .sort("created_at", -1).limit(20).to_list(None)
    return clean({
        "node": _node_view(node, settings), "series": series,
        "thresholds": {p: {k: thresholds[p][k] for k in ("label", "unit", "safe_threshold", "warning_threshold",
                                                          "critical_threshold", "decimals")} for p in PARAMETERS},
        "anomaly": {a["parameter"]: a for a in anomalies}, "alerts": alerts,
    })


# ---- anomaly ---------------------------------------------------------------------
@router.get("/anomaly-summary")
async def anomaly_summary(user: dict = Depends(require_admin)):
    db = get_db()
    states = await db.anomaly_scores.find({}, {"_id": 0, "recent": 0, "baseline_var": 0}) \
        .sort("score", -1).to_list(None)
    fresh = [s for s in states if as_utc(s.get("updated_at"))
             and utcnow() - as_utc(s["updated_at"]) < timedelta(minutes=5)]
    levels = {"normal": 0, "watch": 0, "warning": 0, "critical": 0}
    for s in fresh:
        levels[s["level"]] += 1
    warnings = await db.alert_events.find({"type": "early_warning", "active": True}, {"_id": 0, "dedupe_key": 0}) \
        .sort("created_at", -1).limit(20).to_list(None)
    return clean({
        "overall_score": round(max((s["score"] for s in fresh), default=0), 1),
        "levels": levels, "sensors": fresh, "top": fresh[:8], "active_early_warnings": warnings,
        "bands": {"normal": [0, 39], "watch": [40, 69], "warning": [70, 89], "critical": [90, 100]},
    })
