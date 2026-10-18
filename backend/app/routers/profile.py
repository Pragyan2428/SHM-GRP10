"""The signed-in user's own profile: display name, password and profile picture."""
from __future__ import annotations

import base64
import binascii
import re

from fastapi import APIRouter, Depends, HTTPException, Response, status

from ..db import audit, get_db, utcnow
from ..models import AvatarUpdate, PasswordChange, ProfileUpdate
from ..security import current_user, hash_password, public_user, verify_password

router = APIRouter(prefix="/api/profile", tags=["profile"])

MAX_AVATAR_BYTES = 300_000  # the web app resizes photos to 256x256 before upload (~20-60 KB)
DATA_URL = re.compile(r"^data:(image/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$")
MAGIC = {
    "image/png": lambda b: b.startswith(b"\x89PNG\r\n\x1a\n"),
    "image/jpeg": lambda b: b.startswith(b"\xff\xd8\xff"),
    "image/webp": lambda b: b[:4] == b"RIFF" and b[8:12] == b"WEBP",
}


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

    m = DATA_URL.match(body.image.strip())
    if not m:
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "Upload a PNG, JPEG or WebP image")
    content_type = m.group(1)
    try:
        data = base64.b64decode(re.sub(r"\s", "", m.group(2)), validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The image could not be read")
    if len(data) > MAX_AVATAR_BYTES:
        raise HTTPException(status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, "Image is too large (max 300 KB)")
    if not MAGIC[content_type](data):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, "The file is not a valid image")
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
