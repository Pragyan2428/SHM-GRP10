"""The signed-in user's own profile: display name, password, profile picture and device key."""
from __future__ import annotations

import base64
import binascii
import re
import secrets

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status

from datetime import timedelta

from ..config import get_settings
from ..db import as_utc, audit, get_db, utcnow
from ..models import AlertPrefs, AvatarUpdate, BuildingName, BuildingPhoto, PasswordChange, ProfileUpdate
from ..services import notifications
from ..security import current_user, hash_password, public_user, verify_password

router = APIRouter(prefix="/api/profile", tags=["profile"])

MAX_AVATAR_BYTES = 300_000  # the web app resizes photos to 256x256 before upload (~20-60 KB)
MAX_BUILDING_PHOTO_BYTES = 1_000_000  # building photos are shrunk to 1280 px (~100-300 KB)
DATA_URL = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$")
MAGIC = {
    "image/png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
    "image/webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
}


def _decode_image(image: str, max_bytes: int) -> tuple[str, bytes]:
    """Check a data-URL upload: PNG, JPEG or WebP, really that format, and not too big."""
    m = DATA_URL.match(image.strip())
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload a PNG, JPEG or WebP image")
    content_type = m.group(1)
    try:
        data = base64.b64decode(re.sub(r"\s", "", m.group(2)), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The image could not be read")
    if len(data) > max_bytes:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, f"Image is too large (max {max_bytes // 1000} KB)")
    if not MAGIC[content_type](data):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is not a valid image")
    return content_type, data


async def _save_user(user_id: str, changes: dict) -> dict:
    db = get_db()
    await db.users.update_one({"id": user_id}, {"$set": changes})
    return await db.users.find_one({"id": user_id}, {"_id": 0})


@router.patch("")
async def update_profile(body: ProfileUpdate, user: dict = Depends(current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Name cannot be empty")
    saved = await _save_user(user["id"], {"name": name})
    await audit(user, "profile_updated", user["email"], {"name": name})
    return {"user": public_user(saved)}


@router.post("/password")
async def change_password(body: PasswordChange, user: dict = Depends(current_user)):
    stored = await get_db().users.find_one({"id": user["id"]}, {"_id": 0, "password_hash": 1})
    if not stored or not verify_password(body.current_password, stored["password_hash"]):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Your current password is not correct")
    if body.new_password == body.current_password:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Choose a password you have not used just now")
    await _save_user(user["id"], {"password_hash": hash_password(body.new_password), "password_changed_at": utcnow()})
    await audit(user, "password_changed", user["email"])
    return {"ok": True, "message": "Password changed"}


@router.put("/avatar")
async def set_avatar(body: AvatarUpdate, user: dict = Depends(current_user)):
    db = get_db()
    if (body.preset is None) == (body.image is None):
        raise HTTPException(status.HTTP_422_UNPROCESSABLE_ENTITY, "Send either a preset (1-4) or an image")
    if body.preset is not None:
        await db.user_avatars.delete_one({"user_id": user["id"]})
        saved = await _save_user(user["id"], {"avatar": f"preset:{body.preset}"})
        await audit(user, "avatar_changed", user["email"], {"preset": body.preset})
        return {"user": public_user(saved)}

    content_type, data = _decode_image(body.image, MAX_AVATAR_BYTES)
    version = int(utcnow().timestamp() * 1000)
    await db.user_avatars.update_one(
        {"user_id": user["id"]},
        {"$set": {"user_id": user["id"], "content_type": content_type, "data": data, "updated_at": utcnow()}},
        upsert=True)
    saved = await _save_user(user["id"], {"avatar": f"upload:{version}"})
    await audit(user, "avatar_changed", user["email"], {"upload_bytes": len(data)})
    return {"user": public_user(saved)}


@router.delete("/avatar")
async def remove_avatar(user: dict = Depends(current_user)):
    await get_db().user_avatars.delete_one({"user_id": user["id"]})
    saved = await _save_user(user["id"], {"avatar": None})
    await audit(user, "avatar_removed", user["email"])
    return {"user": public_user(saved)}


@router.get("/avatar")
async def get_avatar(user: dict = Depends(current_user)):
    doc = await get_db().user_avatars.find_one({"user_id": user["id"]}, {"_id": 0})
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No uploaded picture")
    # URLs carry a version (?v=...), so the browser may cache each picture privately.
    return Response(content=bytes(doc["data"]), media_type=doc["content_type"],
                    headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})


# ---- personal device key --------------------------------------------------------------------
# An ESP32 that sends this key in X-Device-Key belongs to this account: its readings, the
# building drawing and its alerts show up for this account only (administrators see every node).
def _new_device_key() -> str:
    return "shm_" + secrets.token_urlsafe(24)


async def _device_info(user_id: str, key: str) -> dict:
    nodes = await get_db().sensor_nodes.find({"owner_id": user_id}, {"_id": 0, "node_id": 1}).sort("node_id", 1).to_list(None)
    return {"device_key": key, "ingest_path": "/api/ingest", "nodes": [n["node_id"] for n in nodes]}


@router.get("/device")
async def get_device_key(user: dict = Depends(current_user)):
    db = get_db()
    stored = await db.users.find_one({"id": user["id"]}, {"_id": 0, "device_key": 1})
    key = (stored or {}).get("device_key")
    if not key:
        key = _new_device_key()
        await db.users.update_one({"id": user["id"], "device_key": {"$exists": False}}, {"$set": {"device_key": key}})
        key = (await db.users.find_one({"id": user["id"]}, {"_id": 0, "device_key": 1}))["device_key"]
    return await _device_info(user["id"], key)


@router.post("/device/rotate")
async def rotate_device_key(user: dict = Depends(current_user)):
    key = _new_device_key()
    await get_db().users.update_one({"id": user["id"]}, {"$set": {"device_key": key}})
    await audit(user, "device_key_rotated", user["id"])
    return await _device_info(user["id"], key)


# ---- the user's own alerts ---------------------------------------------------------------------------
# Alerts for this account's own nodes go to its email address and, once linked, its Telegram.
def _alerts_view(u: dict) -> dict:
    s = get_settings()
    return {
        "email": {"available": s.email_configured, "enabled": u.get("alert_email", True), "address": u["email"]},
        "telegram": {"available": s.telegram_configured, "linked": bool(u.get("telegram_chat_id")),
                     "name": u.get("telegram_name"), "enabled": u.get("alert_telegram", True)},
    }


async def _me(user_id: str) -> dict:
    return await get_db().users.find_one({"id": user_id}, {"_id": 0})


@router.get("/alerts")
async def my_alerts(user: dict = Depends(current_user)):
    return _alerts_view(await _me(user["id"]))


@router.put("/alerts")
async def set_my_alerts(body: AlertPrefs, user: dict = Depends(current_user)):
    changes = {}
    if body.email_enabled is not None:
        changes["alert_email"] = body.email_enabled
    if body.telegram_enabled is not None:
        changes["alert_telegram"] = body.telegram_enabled
    if changes:
        await get_db().users.update_one({"id": user["id"]}, {"$set": changes})
    return _alerts_view(await _me(user["id"]))


@router.post("/telegram/link")
async def telegram_link(user: dict = Depends(current_user)):
    """A personal t.me link: pressing Start through it connects this account's Telegram."""
    if not get_settings().telegram_configured:
        raise HTTPException(409, "Telegram alerts are not set up on this site yet")
    try:
        bot = await notifications.telegram_bot_username()
    except notifications.NotificationError as exc:
        raise HTTPException(502, str(exc))
    code = secrets.token_urlsafe(12).replace("-", "a").replace("_", "b")  # t.me start codes: A-Z a-z 0-9 _ -
    await get_db().users.update_one({"id": user["id"]}, {"$set": {
        "telegram_link_code": code, "telegram_link_expires": utcnow() + timedelta(minutes=30)}})
    return {"url": f"https://t.me/{bot}?start={code}", "bot": bot}


@router.post("/telegram/check")
async def telegram_check(user: dict = Depends(current_user)):
    """Called by the page after the user opened the link: has Start been pressed yet?"""
    u = await _me(user["id"])
    code, expires = u.get("telegram_link_code"), as_utc(u.get("telegram_link_expires"))
    if code and expires and expires > utcnow() and get_settings().telegram_configured:
        chat = await notifications.find_start_code(code)
        if chat:
            await get_db().users.update_one({"id": user["id"]}, {
                "$set": {"telegram_chat_id": chat["id"], "telegram_name": chat["name"], "alert_telegram": True},
                "$unset": {"telegram_link_code": "", "telegram_link_expires": ""}})
            await audit(user, "telegram_linked", user["id"])
            u = await _me(user["id"])
    return _alerts_view(u)


@router.delete("/telegram")
async def telegram_unlink(user: dict = Depends(current_user)):
    await get_db().users.update_one({"id": user["id"]}, {"$unset": {"telegram_chat_id": "", "telegram_name": ""}})
    return _alerts_view(await _me(user["id"]))


@router.put("/building")
async def set_building_name(body: BuildingName, user: dict = Depends(current_user)):
    """The name of this account's building, shown on its dashboard and to administrators."""
    name = body.building_name.strip()
    if not name:
        raise HTTPException(422, "Enter a building name")
    await get_db().users.update_one({"id": user["id"]}, {"$set": {"building_name": name}})
    return {"building_name": name}


# ---- a photo of the account's building, shown in the Building map card ----------------------
@router.put("/building/photo")
async def set_building_photo(body: BuildingPhoto, user: dict = Depends(current_user)):
    content_type, data = _decode_image(body.image, MAX_BUILDING_PHOTO_BYTES)
    db = get_db()
    await db.building_photos.update_one(
        {"user_id": user["id"]},
        {"$set": {"user_id": user["id"], "content_type": content_type, "data": data, "updated_at": utcnow()}},
        upsert=True)
    version = int(utcnow().timestamp() * 1000)
    await db.users.update_one({"id": user["id"]}, {"$set": {"building_photo": version}})
    await audit(user, "building_photo_changed", user["email"], {"upload_bytes": len(data)})
    return {"building_photo": version}


@router.delete("/building/photo")
async def remove_building_photo(user: dict = Depends(current_user)):
    db = get_db()
    await db.building_photos.delete_one({"user_id": user["id"]})
    await db.users.update_one({"id": user["id"]}, {"$unset": {"building_photo": ""}})
    await audit(user, "building_photo_removed", user["email"])
    return {"building_photo": None}


@router.get("/building/photo")
async def get_building_photo(user: dict = Depends(current_user),
                             user_id: Optional[str] = Query(None, max_length=64, description="admins: another account's photo")):
    who = user["id"]
    if user_id and user_id != user["id"]:
        if user.get("role") != "admin":
            raise HTTPException(status.HTTP_403_FORBIDDEN, "Only administrators can see other buildings")
        who = user_id
    doc = await get_db().building_photos.find_one({"user_id": who}, {"_id": 0})
    if not doc:
        raise HTTPException(status.HTTP_404_NOT_FOUND, "No building photo")
    return Response(content=bytes(doc["data"]), media_type=doc["content_type"],
                    headers={"Cache-Control": "private, max-age=86400", "X-Content-Type-Options": "nosniff"})
