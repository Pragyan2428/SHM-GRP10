import time

import jwt
from fastapi.testclient import TestClient

from app.main import create_app
from app.security import COOKIE_NAME

from .conftest import ADMIN, VIEWER, Api, make_settings


def test_admin_login_sets_httponly_cookie(api):
    r = api.post("/api/auth/login", json=ADMIN)
    assert r.status_code == 200
    assert r.json()["user"]["role"] == "admin"
    assert "password_hash" not in r.json()["user"]
    cookie = r.headers["set-cookie"].lower()
    assert "httponly" in cookie and "samesite=lax" in cookie
    me = api.get("/api/auth/me").json()
    assert me["user"]["email"] == ADMIN["email"]


def test_invalid_login(api):
    r = api.post("/api/auth/login", json={"email": ADMIN["email"], "password": "wrong"})
    assert r.status_code == 401
    assert r.json()["detail"] == "Invalid email or password"
    r = api.post("/api/auth/login", json={"email": "nobody@shm.test", "password": "wrong"})
    assert r.status_code == 401  # same message for unknown users (no account enumeration)
    assert api.get("/api/auth/me").status_code == 401


def test_login_lockout_after_repeated_failures(api):
    # LOGIN_MAX_ATTEMPTS=3 in tests
    codes = [api.post("/api/auth/login", json={"email": ADMIN["email"], "password": "bad"}).status_code
             for _ in range(3)]
    assert codes == [401, 401, 429]
    # Even the correct password is refused while locked
    r = api.post("/api/auth/login", json=ADMIN)
    assert r.status_code == 429
    assert "Retry-After" in r.headers


def test_logout_revokes_session(api):
    api.login(ADMIN)
    token = api.cookies.get(COOKIE_NAME)
    assert api.post("/api/auth/logout").status_code == 200
    assert api.get("/api/auth/me").status_code == 401
    # Replaying the old token is rejected too
    api.cookies.set(COOKIE_NAME, token)
    r = api.get("/api/auth/me")
    assert r.status_code == 401 and r.json()["detail"] == "Session ended"


def test_api_requires_authentication(api):
    for path in ["/api/telemetry", "/api/events", "/api/nodes", "/api/thresholds", "/api/users",
                 "/api/telemetry/history", "/api/notifications/status"]:
        assert api.get(path).status_code == 401, path


def test_state_changing_requests_require_client_header(api):
    api.login(ADMIN)
    r = api.c.put("/api/thresholds", json={"thresholds": [{"parameter": "strain", "safe_threshold": 630}]},
                  headers={"X-SHM-Client": ""})
    assert r.status_code == 403


def test_expired_session(settings):
    app = create_app(settings, start_background=False)
    with TestClient(app) as client:
        api = Api(client)
        api.login(ADMIN)
        user_id = api.get("/api/auth/me").json()["user"]["id"]
        expired = jwt.encode({"sub": user_id, "role": "admin", "jti": "x1", "iat": int(time.time()) - 100,
                              "exp": int(time.time()) - 10}, settings.jwt_secret, algorithm="HS256")
        api.cookies.set(COOKIE_NAME, expired)
        r = api.get("/api/auth/me")
        assert r.status_code == 401 and r.json()["detail"] == "Session expired"


def test_forged_token_rejected(api):
    forged = jwt.encode({"sub": "x", "role": "admin", "jti": "y", "exp": int(time.time()) + 100},
                        "not-the-secret-" + "z" * 30, algorithm="HS256")
    api.cookies.set(COOKIE_NAME, forged)
    assert api.get("/api/auth/me").status_code == 401


def test_viewer_permissions(api):
    api.login(VIEWER)
    assert api.get("/api/telemetry").status_code == 200
    assert api.get("/api/events").status_code == 200
    assert api.get("/api/nodes").status_code == 200
    assert api.get("/api/thresholds").status_code == 200
    forbidden = [
        ("put", "/api/thresholds", {"thresholds": [{"parameter": "strain", "safe_threshold": 700}]}),
        ("post", "/api/events/ALT-1/acknowledge", {}),
        ("get", "/api/users", None),
        ("post", "/api/users", {"email": "a@b.co", "name": "A", "password": "Long-enough-1", "role": "viewer"}),
        ("post", "/api/exports/csv", {"dataset": "alerts"}),
        ("post", "/api/google-sheets/sync", None),
        ("put", "/api/notifications/settings", {"email_enabled": False}),
        ("post", "/api/notifications/test", {"channel": "email"}),
        ("post", "/api/system/simulator", {"enabled": False}),
        ("get", "/api/anomaly-summary", None),
        ("post", "/api/mqtt/test", {}),
    ]
    for method, path, body in forbidden:
        r = getattr(api.c, method)(path, json=body) if body is not None else getattr(api.c, method)(path)
        assert r.status_code == 403, (method, path, r.status_code)


def test_missing_core_config_is_reported():
    import pytest
    from app.config import ConfigError
    with pytest.raises(ConfigError, match="JWT_SECRET"):
        create_app(make_settings(JWT_SECRET="short"), start_background=False)
