from datetime import timedelta

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pymongo.errors import DuplicateKeyError

from ..config import Settings, get_settings
from ..db import as_utc, audit, get_db, new_id, utcnow
from ..models import LoginRequest, SignupRequest
from ..security import (CSRF_HEADER, check_lockout, clear_failures, clear_session_cookie, create_token,
                        current_user, hash_password, public_user, record_failure, revoke, set_session_cookie,
                        verify_dummy, verify_password)

router = APIRouter(prefix="/api/auth", tags=["auth"])

SIGNUPS_PER_IP_PER_HOUR = 10  # default; set SIGNUPS_PER_IP_PER_HOUR to change it


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login")
async def login(body: LoginRequest, request: Request, response: Response,
                settings: Settings = Depends(get_settings)):
    email = body.email.strip().lower()
    keys = [f"user:{email}", f"ip:{_client_ip(request)}"]
    wait = await check_lockout(keys)
    if wait:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                            f"Too many failed attempts. Try again in {max(1, round(wait / 60))} minute(s).",
                            headers={"Retry-After": str(wait)})
    user = await get_db().users.find_one({"email": email}, {"_id": 0})
    ok = verify_password(body.password, user["password_hash"]) if user else (verify_dummy() or False)
    if not ok or not user.get("active", True):
        locked = await record_failure(keys, settings)
        await audit(None, "login_failed", email, {"ip": _client_ip(request), "locked": locked})
        if locked:
            raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS,
                                f"Too many failed attempts. Account locked for {settings.login_lockout_minutes} minutes.")
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Invalid email or password")
    await clear_failures(f"user:{email}")
    user["last_login_at"] = utcnow()
    await get_db().users.update_one({"id": user["id"]}, {"$set": {"last_login_at": user["last_login_at"]}})
    token, max_age = create_token(user, settings)
    set_session_cookie(response, token, max_age, settings)
    await audit(user, "login", email, {"ip": _client_ip(request)})
    return {"user": public_user(user), "expires_in": max_age}


@router.post("/signup", status_code=status.HTTP_201_CREATED)
async def signup(body: SignupRequest, request: Request, response: Response,
                 settings: Settings = Depends(get_settings)):
    """Create a viewer account and sign it in. Administrators are only ever created by an admin."""
    if not settings.allow_signup:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Sign-up is turned off. Ask an administrator for an account.")
    # No cookie is involved yet, so require the client header explicitly (cross-site forms cannot send it).
    if request.headers.get(CSRF_HEADER) != "web":
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Missing client header")

    domain = settings.signup_email_domain.strip().lower().lstrip("@")
    if domain and not body.email.lower().endswith("@" + domain):
        raise HTTPException(status.HTTP_400_BAD_REQUEST, f"Use a {domain} address, like name@{domain}.")

    ip = _client_ip(request)
    attempts = get_db().login_attempts
    now = utcnow()
    doc = await attempts.find_one({"key": f"signup:{ip}"}) or {}
    recent = [as_utc(t) for t in doc.get("signups", []) if as_utc(t) > now - timedelta(hours=1)]
    if len(recent) >= settings.signups_per_ip_per_hour:
        raise HTTPException(status.HTTP_429_TOO_MANY_REQUESTS, "Too many new accounts from this network. Try again later.",
                            headers={"Retry-After": "3600"})

    user = {"id": new_id("usr_"), "email": body.email.lower(), "name": body.name.strip(), "role": "viewer",
            "password_hash": hash_password(body.password), "active": True, "created_at": now,
            "last_login_at": now, "signed_up": True}
    try:
        await get_db().users.insert_one(dict(user))
    except DuplicateKeyError:
        raise HTTPException(status.HTTP_409_CONFLICT, "An account with this email already exists. Log in instead.")
    await attempts.update_one({"key": f"signup:{ip}"}, {"$set": {"key": f"signup:{ip}", "signups": recent + [now]}},
                              upsert=True)
    token, max_age = create_token(user, settings)
    set_session_cookie(response, token, max_age, settings)
    await audit(user, "signup", user["email"], {"ip": ip})
    return {"user": public_user(user), "expires_in": max_age}


@router.post("/logout")
async def logout(response: Response, request: Request, settings: Settings = Depends(get_settings)):
    # Logout works even with an expired/invalid cookie; a valid token is revoked server-side.
    try:
        user = await current_user(request, settings)
        await revoke(user["_token"])
        await audit(user, "logout", user["email"])
    except HTTPException:
        pass
    clear_session_cookie(response, settings)
    return {"ok": True}


@router.get("/me")
async def me(user: dict = Depends(current_user)):
    return {"user": public_user(user), "session_expires_at": user["_token"]["exp"]}
