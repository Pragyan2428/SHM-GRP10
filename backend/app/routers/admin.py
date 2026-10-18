"""Thresholds, notifications, exports, Google Sheets, users and system settings."""
from __future__ import annotations

import csv
import io
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import StreamingResponse
from pymongo.errors import DuplicateKeyError

from ..config import Settings, get_settings
from ..db import as_utc, audit, clean, get_db, new_id, ping, utcnow
from ..models import (CsvExportRequest, NotificationSettings, NotificationTest, SheetsSettings,
                      SimulatorToggle, ThresholdsPut, UserCreate, UserUpdate)
from ..security import current_user, hash_password, public_user, require_admin
from ..services import notifications, sheets
from ..services import thresholds as th_service
from .common import alert_query, reading_query

router = APIRouter(prefix="/api", tags=["admin"])


# ---- thresholds ------------------------------------------------------------------
@router.get("/thresholds")
async def get_thresholds(user: dict = Depends(current_user)):
    ths = await th_service.get_thresholds()
    return {"items": clean([ths[p] for p in th_service.PARAMETERS])}


@router.put("/thresholds")
async def put_thresholds(body: ThresholdsPut, user: dict = Depends(require_admin)):
    current = await th_service.get_thresholds()
    changes = []
    for upd in body.thresholds:
        old = current[upd.parameter]
        new = {k: v for k, v in upd.model_dump(exclude={"parameter"}).items() if v is not None}
        merged = {**old, **new}
        for k in ("safe_threshold", "warning_threshold", "critical_threshold"):
            if merged[k] <= 0:
                raise HTTPException(422, f"{upd.parameter}: {k} must be greater than zero")
        if not merged["warning_threshold"] < merged["safe_threshold"] < merged["critical_threshold"]:
            raise HTTPException(422, f"{upd.parameter}: thresholds must satisfy warning < safe < critical")
        diff = {k: {"from": old.get(k), "to": v} for k, v in new.items() if old.get(k) != v}
        if not diff:
            continue
        now = utcnow()
        await get_db().thresholds.update_one(
            {"parameter": upd.parameter},
            {"$set": {**new, "updated_by": user["email"], "updated_at": now}}, upsert=True)
        await audit(user, "threshold_updated", upd.parameter, diff)
        changes.append({"parameter": upd.parameter, "changes": diff})
    th_service.invalidate()
    ths = await th_service.get_thresholds()
    return {"items": clean([ths[p] for p in th_service.PARAMETERS]), "changed": changes}


@router.get("/thresholds/audit")
async def threshold_audit(user: dict = Depends(current_user), limit: int = Query(50, ge=1, le=200)):
    rows = await get_db().audit_logs.find({"action": "threshold_updated"}, {"_id": 0}) \
        .sort("created_at", -1).limit(limit).to_list(None)
    return {"items": clean(rows)}


# ---- notifications ---------------------------------------------------------------
@router.get("/notifications/status")
async def notification_status(user: dict = Depends(current_user)):
    cfg = await notifications.get_notification_settings()
    db = get_db()
    counts = {s: await db.alert_events.count_documents({"notification_status": s})
              for s in ("pending", "sent", "failed", "disabled")}
    out = {"providers": notifications.provider_status(), "delivery_counts": counts,
           "settings": cfg if user["role"] == "admin" else
           {k: cfg[k] for k in ("browser_enabled", "min_severity")}}
    if user["role"] == "admin":
        out["recent_logs"] = clean(await db.notification_logs.find({}, {"_id": 0})
                                   .sort("created_at", -1).limit(25).to_list(None))
    return out


@router.put("/notifications/settings")
async def update_notification_settings(body: NotificationSettings, user: dict = Depends(require_admin)):
    values = body.model_dump(exclude_none=True)
    saved = await notifications.save_notification_settings(values)
    await audit(user, "notification_settings_updated", "notifications", values)
    return {"settings": saved}


@router.post("/notifications/test")
async def test_notification(body: NotificationTest, user: dict = Depends(require_admin)):
    result = await notifications.send_test(body.channel)
    await audit(user, "notification_test", body.channel, {"status": result["status"]})
    return result


# ---- exports ---------------------------------------------------------------------
CSV_COLUMNS = ["Timestamp", "Parameter", "Value", "Unit", "Threshold", "Node ID", "Location",
               "Severity", "Status", "Anomaly score"]


def _csv_safe(v):
    # Neutralise spreadsheet formula injection in free-text cells.
    if isinstance(v, str) and v[:1] in ("=", "+", "-", "@"):
        return "'" + v
    return v


@router.post("/exports/csv")
async def export_csv(body: CsvExportRequest, user: dict = Depends(require_admin)):
    db = get_db()
    direction = -1 if body.sort == "newest" else 1
    if body.dataset == "alerts":
        f = alert_query(parameter=body.parameter, node_id=body.node_id, severity=body.severity,
                        status=body.status, q=body.q, date_from=body.date_from, date_to=body.date_to)
        rows = await db.alert_events.find(f, {"_id": 0}).sort("created_at", direction).limit(body.limit).to_list(None)
        records = [[as_utc(a["created_at"]).isoformat(), a["label"], a["value"], a["unit"], a["threshold"],
                    a["node_id"], a["location"], a["severity"], a["status"], a.get("anomaly_score")] for a in rows]
    else:
        f = reading_query(parameter=body.parameter, node_id=body.node_id, status=body.status, q=body.q,
                          date_from=body.date_from, date_to=body.date_to)
        rows = await db.sensor_readings.find(f, {"_id": 0}).sort("timestamp", direction).limit(body.limit).to_list(None)
        records = [[as_utc(r["timestamp"]).isoformat(), r["label"], r["value"], r["unit"], r["safe_threshold"],
                    r["node_id"], r["location"], r["status"], r["status"], r.get("anomaly_score")] for r in rows]
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(CSV_COLUMNS)
    for rec in records:
        w.writerow([_csv_safe(v) for v in rec])
    await audit(user, "csv_export", body.dataset, {"rows": len(records)})
    name = f"shm-{body.dataset}-{utcnow().strftime('%Y%m%dT%H%M%SZ')}.csv"
    return StreamingResponse(iter([buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{name}"',
                                      "X-Row-Count": str(len(records))})


@router.post("/exports/google-sheets")
async def export_google_sheets(user: dict = Depends(require_admin)):
    result = await sheets.sync(manual=True)
    await audit(user, "google_sheets_export", "google_sheets", {"ok": result["ok"], "synced": result["synced"]})
    return result


# ---- google sheets ---------------------------------------------------------------
@router.get("/google-sheets/status")
async def google_sheets_status(user: dict = Depends(current_user)):
    return clean(await sheets.status())


@router.put("/google-sheets/settings")
async def google_sheets_settings(body: SheetsSettings, user: dict = Depends(require_admin)):
    values: dict = {}
    if body.spreadsheet is not None:
        if body.spreadsheet.strip() == "":
            values["spreadsheet_id"] = None
        else:
            sid = sheets.extract_spreadsheet_id(body.spreadsheet)
            if not sid:
                raise HTTPException(422, "Enter a Google Sheets URL or spreadsheet ID")
            values["spreadsheet_id"] = sid
    if body.auto_sync is not None:
        values["auto_sync"] = body.auto_sync
    from ..db import put_setting
    await put_setting("google_sheets", values)
    await audit(user, "google_sheets_settings_updated", "google_sheets", values)
    return clean(await sheets.status())


@router.post("/google-sheets/test")
async def google_sheets_test(user: dict = Depends(require_admin)):
    result = await sheets.check_connection()
    await audit(user, "google_sheets_test", "google_sheets", {"ok": result["ok"]})
    return clean(result)


@router.get("/google-sheets/apps-script")
async def google_sheets_apps_script(user: dict = Depends(require_admin)):
    """The Apps Script code to paste into the spreadsheet (Extensions > Apps Script)."""
    return {"code": sheets.apps_script_source(), "secret_env": "GOOGLE_SHEETS_WEBHOOK_SECRET",
            "url_env": "GOOGLE_SHEETS_WEBHOOK_URL"}


@router.post("/google-sheets/sync")
async def google_sheets_sync(user: dict = Depends(require_admin)):
    result = await sheets.sync(manual=True)
    await audit(user, "google_sheets_sync", "google_sheets", {"ok": result["ok"], "synced": result["synced"]})
    return clean(result)


# ---- users -----------------------------------------------------------------------
@router.get("/users")
async def list_users(user: dict = Depends(require_admin)):
    users = await get_db().users.find({}, {"_id": 0}).sort("created_at", 1).to_list(None)
    return {"items": clean([public_user(u) for u in users])}


@router.post("/users", status_code=201)
async def create_user(body: UserCreate, user: dict = Depends(require_admin)):
    doc = {"id": new_id("usr_"), "email": body.email.lower(), "name": body.name, "role": body.role,
           "password_hash": hash_password(body.password), "active": True, "created_at": utcnow()}
    try:
        await get_db().users.insert_one(dict(doc))
    except DuplicateKeyError:
        raise HTTPException(409, "A user with this email already exists")
    await audit(user, "user_created", doc["email"], {"role": body.role})
    return clean(public_user(doc))


async def _admin_count() -> int:
    return await get_db().users.count_documents({"role": "admin", "active": True})


@router.put("/users/{user_id}")
async def update_user(user_id: str, body: UserUpdate, user: dict = Depends(require_admin)):
    db = get_db()
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    upd = body.model_dump(exclude_none=True)
    demoting = target["role"] == "admin" and (upd.get("role") == "viewer" or upd.get("active") is False)
    if demoting and await _admin_count() <= 1:
        raise HTTPException(409, "Cannot demote or deactivate the last active administrator")
    if user_id == user["id"] and (upd.get("role") == "viewer" or upd.get("active") is False):
        raise HTTPException(409, "You cannot demote or deactivate your own account")
    if "password" in upd:
        upd["password_hash"] = hash_password(upd.pop("password"))
    if upd:
        await db.users.update_one({"id": user_id}, {"$set": {**upd, "updated_at": utcnow()}})
    await audit(user, "user_updated", target["email"],
                {k: v for k, v in upd.items() if k != "password_hash"} | ({"password": "changed"} if "password_hash" in upd else {}))
    return clean(public_user(await db.users.find_one({"id": user_id}, {"_id": 0})))


@router.delete("/users/{user_id}")
async def delete_user(user_id: str, user: dict = Depends(require_admin)):
    db = get_db()
    target = await db.users.find_one({"id": user_id}, {"_id": 0})
    if not target:
        raise HTTPException(404, "User not found")
    if user_id == user["id"]:
        raise HTTPException(409, "You cannot delete your own account")
    if target["role"] == "admin" and await _admin_count() <= 1:
        raise HTTPException(409, "Cannot delete the last active administrator")
    await db.users.delete_one({"id": user_id})
    await db.user_avatars.delete_one({"user_id": user_id})
    await audit(user, "user_deleted", target["email"])
    return {"ok": True}


# ---- system ----------------------------------------------------------------------
@router.get("/system/status")
async def system_status(request: Request, user: dict = Depends(current_user),
                        settings: Settings = Depends(get_settings)):
    from ..db import get_setting
    system = await get_setting("system", {"simulator_enabled": settings.simulator_enabled})
    meta = await get_setting("telemetry_meta")
    out = {
        "structure_name": settings.structure_name,
        "database": {"connected": await ping(), "name": settings.db_name,
                     "in_memory": settings.mongo_url.startswith("mongomock://")},
        "simulator": {"enabled": system.get("simulator_enabled"),
                      "interval_seconds": settings.simulator_interval_seconds},
        "last_reading_at": as_utc(meta.get("last_reading_at")),
        "last_source": meta.get("last_source"),
        "mqtt": request.app.state.mqtt.status(),
        "http_ingest": {"device_auth_configured": settings.device_auth_configured,
                        "endpoint": "/api/ingest", "header": "X-Device-Key"},
    }
    if user["role"] == "admin":
        out["integrations"] = {
            "email": settings.email_configured, "sms": settings.sms_configured,
            "whatsapp": settings.whatsapp_configured, "google_sheets": settings.google_configured, "mqtt": settings.mqtt_configured,
            "device_auth": settings.device_auth_configured,
        }
        out["recent_audit"] = clean(await get_db().audit_logs.find({}, {"_id": 0})
                                    .sort("created_at", -1).limit(30).to_list(None))
    return clean(out)


@router.post("/system/simulator")
async def toggle_simulator(body: SimulatorToggle, request: Request, user: dict = Depends(require_admin)):
    await request.app.state.simulator.set_enabled(body.enabled)
    await audit(user, "simulator_toggled", "simulator", {"enabled": body.enabled})
    return {"enabled": body.enabled}
