"""Wireless pairing: ESP32s that are on Wi-Fi but not yet part of the site.

1. A new ESP32 gets the Wi-Fi name/password over Bluetooth (the website's "Set up over
   Bluetooth" step, or secrets.h), joins the network and calls POST /api/devices/announce
   every few seconds with its MAC address and a random secret it keeps in flash.
2. Administrators see those devices under Add node. Devices whose public IP matches the
   admin's own (i.e. the same Wi-Fi / router) are listed first; this works when the API is
   hosted in the cloud (Vercel) as well as when it runs on a PC on the same network.
3. "Connect" creates the sensor node with a fresh per-node device key. The ESP32 receives
   that key in the reply to its next announce and starts sending readings to /api/ingest.
"""
from __future__ import annotations

import hashlib
import hmac
import ipaddress
import re
import secrets
from datetime import timedelta
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from pydantic import BaseModel, Field, field_validator

from ..config import Settings, get_settings
from ..db import as_utc, audit, clean, get_db, utcnow
from ..models import NodeCreate
from ..security import current_user, require_admin

router = APIRouter(prefix="/api/devices", tags=["devices"])

LIVE_SECONDS = 30            # a device that has not announced for this long is no longer listed
FORGET_AFTER = timedelta(hours=24)
MAX_WAITING_PER_IP = 25      # unauthenticated endpoint: cap what one network can add
MAC_PATTERN = r"^[0-9A-F]{2}(:[0-9A-F]{2}){5}$"


def hash_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


def client_ip(request: Request) -> str:
    """The caller's public address. Vercel (and most proxies) put it first in X-Forwarded-For."""
    for header in ("x-forwarded-for", "x-real-ip"):
        value = request.headers.get(header)
        if value:
            return value.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def _private(ip: str) -> bool:
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return ip in ("testclient", "localhost")
    return a.is_private or a.is_loopback or a.is_link_local


def same_network(device_ip: Optional[str], admin_ip: str) -> bool:
    if not device_ip:
        return False
    if device_ip == admin_ip:
        return True  # cloud-hosted API: both are behind the same router / public IP
    return _private(device_ip) and _private(admin_ip)  # API on a PC on the local network


def suggested_node_id(mac: str) -> str:
    return "ESP32-" + mac.replace(":", "")[-6:]


class Announce(BaseModel):
    mac: str = Field(max_length=17)
    claim_secret: str = Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_\-]+$")
    firmware: Optional[str] = Field(default=None, max_length=32)
    rssi: Optional[int] = Field(default=None, ge=-120, le=0)
    local_ip: Optional[str] = Field(default=None, max_length=45)
    ssid: Optional[str] = Field(default=None, max_length=32)
    sensors: Optional[list[str]] = Field(default=None, max_length=8)

    @field_validator("mac")
    @classmethod
    def _mac(cls, v: str) -> str:
        v = v.strip().upper().replace("-", ":")
        if not re.fullmatch(MAC_PATTERN, v):
            raise ValueError("mac must look like AA:BB:CC:DD:EE:FF")
        return v

    @field_validator("sensors")
    @classmethod
    def _sensors(cls, v):
        return None if v is None else [str(s)[:20] for s in v]


def _view(d: dict, admin_ip: str) -> dict:
    last = as_utc(d.get("last_seen"))
    return clean({
        "mac": d["mac"], "suggested_node_id": suggested_node_id(d["mac"]), "firmware": d.get("firmware"),
        "rssi": d.get("rssi"), "local_ip": d.get("local_ip"), "ssid": d.get("ssid"), "sensors": d.get("sensors"),
        "first_seen": as_utc(d.get("first_seen")), "last_seen": last,
        "seconds_ago": int((utcnow() - last).total_seconds()) if last else None,
        "same_network": same_network(d.get("public_ip"), admin_ip),
    })


@router.post("/announce")
async def announce(body: Announce, request: Request):
    """Called by unpaired ESP32s. No device key yet: the claim secret proves it is the same device."""
    db = get_db()
    now = utcnow()
    ip = client_ip(request)
    secret_hash = hash_key(body.claim_secret)
    doc = await db.pending_devices.find_one({"mac": body.mac}, {"_id": 0})

    if doc and not hmac.compare_digest(doc["claim_hash"], secret_hash):
        recent = (now - as_utc(doc["last_seen"])).total_seconds() < LIVE_SECONDS * 4
        if doc.get("status") == "approved" or recent:
            raise HTTPException(409, "Another device with this MAC address is already waiting")
        doc = None  # stale entry (e.g. the board was erased): start over
    if not doc and await db.pending_devices.count_documents(
            {"public_ip": ip, "status": "waiting", "last_seen": {"$gte": now - timedelta(seconds=LIVE_SECONDS)}}) >= MAX_WAITING_PER_IP:
        raise HTTPException(429, "Too many unpaired devices on this network")

    fields = {k: v for k, v in body.model_dump(exclude={"mac", "claim_secret"}).items() if v is not None}
    await db.pending_devices.update_one(
        {"mac": body.mac},
        {"$set": {**fields, "public_ip": ip, "last_seen": now, "claim_hash": secret_hash,
                  "expires_at": now + FORGET_AFTER},
         "$setOnInsert": {"first_seen": now, "status": "waiting"}},
        upsert=True)
    doc = await db.pending_devices.find_one({"mac": body.mac}, {"_id": 0})
    if doc.get("status") == "approved":
        # Delivered on every announce until the first reading with the key arrives
        # (then this entry is removed), so a lost reply does not strand the device.
        return {"status": "approved", "node_id": doc["node_id"], "location": doc.get("location") or "",
                "device_key": doc["device_key"], "ingest_path": "/api/ingest"}
    return {"status": "waiting", "suggested_node_id": suggested_node_id(body.mac), "retry_seconds": 5}


@router.get("/discovered")
async def discovered(request: Request, user: dict = Depends(current_user),
                     scope: str = Query("network", pattern="^(network|all)$")):
    """Unpaired ESP32s that announced in the last few seconds; by default only those on the caller's network.
    Users can only ever see devices on their own network; admins can also list every waiting device."""
    if scope == "all" and user.get("role") != "admin":
        raise HTTPException(403, "Only administrators can list devices on other networks")
    admin_ip = client_ip(request)
    since = utcnow() - timedelta(seconds=LIVE_SECONDS)
    rows = await get_db().pending_devices.find({"status": "waiting", "last_seen": {"$gte": since}}, {"_id": 0}) \
        .sort("first_seen", 1).to_list(200)
    items = [_view(d, admin_ip) for d in rows]
    others = sum(1 for i in items if not i["same_network"])
    if scope == "network":
        items = [i for i in items if i["same_network"]]
    if user.get("role") != "admin":
        return {"items": items, "other_networks": 0}
    return {"items": items, "other_networks": others, "your_ip": admin_ip}


@router.post("/{mac}/approve", status_code=201)
async def approve(mac: str, body: NodeCreate, request: Request, user: dict = Depends(current_user),
                  settings: Settings = Depends(get_settings)):
    """Turn a discovered ESP32 into a sensor node. The device picks up its key on its next announce.
    A user connects a device on their own network to themselves; an admin can connect any and pick the owner."""
    from .monitoring import _node_view, _owner_or_none  # avoid an import cycle at module load

    db = get_db()
    mac = mac.strip().upper().replace("-", ":")
    pending = await db.pending_devices.find_one({"mac": mac}, {"_id": 0})
    if not pending or pending.get("status") != "waiting":
        raise HTTPException(404, "That device is no longer waiting to be connected. Check it is powered and on Wi-Fi.")
    if user.get("role") != "admin":
        if not same_network(pending.get("public_ip"), client_ip(request)):
            raise HTTPException(404, "That device is not on your Wi-Fi")
        body.owner_id = user["id"]  # a user's device is always theirs
    if await db.sensor_nodes.find_one({"node_id": body.node_id}, {"_id": 1}):
        raise HTTPException(409, f"A node called {body.node_id} already exists")

    key = secrets.token_urlsafe(24)
    now = utcnow()
    location = (body.location or "").strip() or "Unassigned location"
    doc = {"node_id": body.node_id, "label": body.node_id, "location": location,
           "owner_id": await _owner_or_none(body.owner_id), "plan_x": body.plan_x, "plan_y": body.plan_y,
           "created_at": now, "calibrated_at": now, "firmware_default": pending.get("firmware") or "unknown",
           "latest": {}, "registered_by": user["email"], "mac": mac, "rssi": pending.get("rssi"),
           "device_key_hash": hash_key(key), "paired_at": now, "data_source": "http"}
    if body.floor is not None:
        doc["floor"] = body.floor
    await db.sensor_nodes.insert_one(dict(doc))
    await db.pending_devices.update_one({"mac": mac}, {"$set": {
        "status": "approved", "node_id": body.node_id, "location": location, "device_key": key,
        "approved_by": user["email"], "approved_at": now}})
    await audit(user, "node_paired", body.node_id, {"mac": mac, "owner_id": doc["owner_id"], "floor": body.floor})
    return {**_node_view(doc, settings), "mac": mac, "pairing": "sent"}


@router.delete("/{mac}", status_code=204)
async def forget(mac: str, user: dict = Depends(require_admin)):
    """Drop a waiting device from the list (it reappears if it keeps announcing)."""
    await get_db().pending_devices.delete_one({"mac": mac.strip().upper().replace("-", ":"), "status": "waiting"})
    return Response(status_code=204)
