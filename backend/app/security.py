"""Password hashing, JWT sessions in HttpOnly cookies, role checks, login lockout."""
from __future__ import annotations

import hashlib
import hmac
from datetime import timedelta
from typing import Optional

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request, Response, status

from .config import Settings, get_settings
from .db import as_utc, get_db, new_id, utcnow

COOKIE_NAME = "shm_session"
CSRF_HEADER = "x-shm-client"
ROLES = ("admin", "viewer")


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt(rounds=12)).decode("utf-8")


def verify_password(password: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(password.encode("utf-8"), hashed.encode("utf-8"))
    except ValueError:
        return False


# A real hash so unknown-user logins take as long as wrong-password logins.
_DUMMY_HASH = bcrypt.hashpw(b"timing-equaliser", bcrypt.gensalt(rounds=12)).decode()


def verify_dummy() -> None:
    verify_password("not-the-password", _DUMMY_HASH)


def create_token(user: dict, settings: Settings) -> tuple[str, int]:
    now = utcnow()
    max_age = settings.jwt_expire_minutes * 60
    payload = {
        "sub": user["id"],
        "role": user["role"],
        "jti": new_id(),
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(seconds=max_age)).timestamp()),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256"), max_age


def set_session_cookie(response: Response, token: str, max_age: int, settings: Settings) -> None:
    response.set_cookie(
        COOKIE_NAME, token, max_age=max_age, httponly=True,
        secure=settings.cookie_secure, samesite=settings.cookie_samesite, path="/")


def clear_session_cookie(response: Response, settings: Settings) -> None:
    response.delete_cookie(COOKIE_NAME, path="/", httponly=True,
                           secure=settings.cookie_secure, samesite=settings.cookie_samesite)


def short_id(user_id: str) -> str:
    """Short, readable account ID (e.g. U-7F3A9C) derived from the internal ID, so it never changes."""
    return "U-" + hashlib.sha256(user_id.encode()).hexdigest()[:6].upper()


def public_user(user: dict) -> dict:
    return {
        "id": user["id"], "short_id": short_id(user["id"]), "email": user["email"], "name": user.get("name", ""),
        "role": user["role"], "active": user.get("active", True),
        "created_at": as_utc(user.get("created_at")), "last_login_at": as_utc(user.get("last_login_at")),
        "avatar": user.get("avatar"),  # None, "preset:1".."preset:4", or "upload:<version>"
    }


async def _decode(request: Request, settings: Settings) -> dict:
    token = request.cookies.get(COOKIE_NAME)
    if not token:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Not authenticated")
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=["HS256"],
                             options={"require": ["exp", "sub", "jti"]})
    except jwt.ExpiredSignatureError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session expired")
    except jwt.PyJWTError:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid session")
    if await get_db().revoked_tokens.find_one({"jti": payload["jti"]}):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Session ended")
    return payload


async def current_user(request: Request, settings: Settings = Depends(get_settings)) -> dict:
    payload = await _decode(request, settings)
    user = await get_db().users.find_one({"id": payload["sub"]}, {"_id": 0})
    if not user or not user.get("active", True):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Account unavailable")
    # Cookie auth + state-changing request: require the custom client header.
    # Browsers cannot send it cross-site without a CORS preflight we do not allow.
    if request.method not in ("GET", "HEAD", "OPTIONS") and request.headers.get(CSRF_HEADER) != "web":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing client header")
    user["_token"] = payload
    return user


async def require_admin(user: dict = Depends(current_user)) -> dict:
    if user["role"] != "admin":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Administrator permission required")
    return user


async def revoke(payload: dict) -> None:
    from datetime import datetime, timezone
    await get_db().revoked_tokens.update_one(
        {"jti": payload["jti"]},
        {"$set": {"jti": payload["jti"],
                  "expires_at": datetime.fromtimestamp(payload["exp"], tz=timezone.utc)}},
        upsert=True)


# ---- brute-force protection -------------------------------------------------
async def check_lockout(keys: list[str]) -> Optional[int]:
    """Return seconds remaining if any key is locked."""
    now = utcnow()
    for key in keys:
        doc = await get_db().login_attempts.find_one({"key": key})
        locked_until = as_utc(doc.get("locked_until")) if doc else None
        if locked_until and locked_until > now:
            return int((locked_until - now).total_seconds()) + 1
    return None


async def record_failure(keys: list[str], settings: Settings) -> bool:
    """Record a failed login; return True if this failure triggered a lockout."""
    now = utcnow()
    window = timedelta(minutes=settings.login_window_minutes)
    locked = False
    for key in keys:
        coll = get_db().login_attempts
        doc = await coll.find_one({"key": key}) or {"failures": []}
        failures = [as_utc(f) for f in doc.get("failures", []) if as_utc(f) > now - window]
        failures.append(now)
        update: dict = {"key": key, "failures": failures}
        # The IP limit is looser so one office NAT can't lock everyone out.
        limit = settings.login_max_attempts * (4 if key.startswith("ip:") else 1)
        if len(failures) >= limit:
            update["locked_until"] = now + timedelta(minutes=settings.login_lockout_minutes)
            update["failures"] = []
            locked = True
        await coll.update_one({"key": key}, {"$set": update}, upsert=True)
    return locked


async def clear_failures(key: str) -> None:
    await get_db().login_attempts.delete_one({"key": key})


# ---- device authentication ----------------------------------------------------
async def device_owner(node_id: str, presented: Optional[str], settings: Settings) -> Optional[dict]:
    """The account whose personal device key was presented, or None for the site-wide
    DEVICE_SHARED_KEY / DEVICE_KEYS (the admin's own devices). Raises 401/503 otherwise."""
    if presented:
        # A key handed to this one node when an admin connected it from the website (Add node > Nearby)
        node = await get_db().sensor_nodes.find_one(
            {"node_id": node_id.upper(), "device_key_hash": hashlib.sha256(presented.encode()).hexdigest()},
            {"_id": 0, "owner_id": 1, "mac": 1})
        if node:
            if node.get("mac"):  # paired and reporting: the waiting-list entry (and its copy of the key) can go
                await get_db().pending_devices.delete_one({"mac": node["mac"], "status": "approved"})
            if not node.get("owner_id"):
                return None
            owner = await get_db().users.find_one({"id": node["owner_id"]}, {"_id": 0, "id": 1, "active": 1})
            if not owner or not owner.get("active", True):
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This node belongs to a disabled account")
            return owner
        owner = await get_db().users.find_one({"device_key": presented}, {"_id": 0, "id": 1, "active": 1, "device_key": 1})
        if owner and hmac.compare_digest(owner["device_key"].encode(), presented.encode()):
            if not owner.get("active", True):
                raise HTTPException(status.HTTP_401_UNAUTHORIZED, "This device key belongs to a disabled account")
            return owner
    verify_device(node_id, presented, settings)
    return None


def verify_device(node_id: str, presented: Optional[str], settings: Settings) -> None:
    if not settings.device_auth_configured:
        raise HTTPException(status.HTTP_503_SERVICE_UNAVAILABLE,
                            "Device authentication is not configured (set DEVICE_SHARED_KEY or DEVICE_KEYS)")
    if not presented:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing X-Device-Key header")
    expected = settings.device_key_map.get(node_id.upper())
    candidates = [expected] if expected else ([settings.device_shared_key] if settings.device_shared_key else [])
    if not any(c and hmac.compare_digest(c.encode(), presented.encode()) for c in candidates):
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid device key")
