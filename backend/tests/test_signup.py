from fastapi.testclient import TestClient

from app.main import create_app
from app.routers.auth import SIGNUPS_PER_IP_PER_HOUR
from app.security import COOKIE_NAME

from .conftest import ADMIN, VIEWER, Api, make_settings

NEW = {"name": "Field Engineer", "email": "New.User@Gmail.com", "password": "New-User-Password-1"}


def test_signup_creates_viewer_and_signs_in(api):
    r = api.post("/api/auth/signup", json=NEW)
    assert r.status_code == 201, r.text
    user = r.json()["user"]
    assert user["role"] == "viewer"
    assert user["email"] == "new.user@gmail.com"  # stored lower-case
    assert "password_hash" not in user
    assert api.cookies.get(COOKIE_NAME)
    assert api.get("/api/auth/me").json()["user"]["email"] == "new.user@gmail.com"
    # A viewer can read telemetry but not use admin endpoints
    assert api.get("/api/telemetry").status_code == 200
    assert api.get("/api/users").status_code == 403


def test_signed_up_user_can_log_in_later(api):
    api.post("/api/auth/signup", json=NEW)
    api.post("/api/auth/logout")
    r = api.post("/api/auth/login", json={"email": "new.user@gmail.com", "password": NEW["password"]})
    assert r.status_code == 200 and r.json()["user"]["role"] == "viewer"


def test_signup_cannot_choose_admin_role(api):
    r = api.post("/api/auth/signup", json={**NEW, "role": "admin"})
    assert r.status_code == 201
    assert r.json()["user"]["role"] == "viewer"


def test_signup_rejects_existing_email(api):
    assert api.post("/api/auth/signup", json=NEW).status_code == 201
    api.post("/api/auth/logout")
    r = api.post("/api/auth/signup", json={**NEW, "email": NEW["email"].upper(), "password": "Other-Password-99"})
    assert r.status_code == 409
    # The existing account keeps its original password
    r = api.post("/api/auth/login", json={"email": NEW["email"], "password": NEW["password"]})
    assert r.status_code == 200
    assert api.post("/api/auth/login", json=ADMIN).json()["user"]["role"] == "admin"


def test_signup_validates_input(api):
    for bad in [{**NEW, "password": "short"}, {**NEW, "email": "not-an-email"}, {**NEW, "name": ""},
                {"email": NEW["email"], "password": NEW["password"]}]:
        assert api.post("/api/auth/signup", json=bad).status_code == 422, bad
    assert api.get("/api/auth/me").status_code == 401


def test_signup_only_accepts_gmail_addresses(api):
    for email in ["someone@example.com", "someone@yahoo.com", "someone@gmail.co", "someone@notgmail.com",
                  "gmail.com@example.com"]:
        r = api.post("/api/auth/signup", json={**NEW, "email": email})
        assert r.status_code == 400, email
        assert "name@gmail.com" in r.json()["detail"]
    assert api.get("/api/auth/me").status_code == 401


def test_signup_email_domain_is_configurable():
    app = create_app(make_settings(SIGNUP_EMAIL_DOMAIN="company.com"), start_background=False)
    with TestClient(app, base_url="http://testserver") as client:
        api = Api(client)
        assert api.post("/api/auth/signup", json=NEW).status_code == 400
        assert api.post("/api/auth/signup", json={**NEW, "email": "eng@company.com"}).status_code == 201


def test_signup_requires_client_header(api):
    r = api.c.post("/api/auth/signup", json=NEW, headers={"X-SHM-Client": ""})
    assert r.status_code == 403


def test_signup_is_rate_limited_per_ip(api):
    for i in range(SIGNUPS_PER_IP_PER_HOUR):
        r = api.post("/api/auth/signup", json={**NEW, "email": f"user{i}@gmail.com"})
        assert r.status_code == 201, r.text
    r = api.post("/api/auth/signup", json={**NEW, "email": "one-too-many@gmail.com"})
    assert r.status_code == 429 and "Retry-After" in r.headers


def test_signup_can_be_turned_off():
    app = create_app(make_settings(ALLOW_SIGNUP=False), start_background=False)
    with TestClient(app, base_url="http://testserver") as client:
        api = Api(client)
        r = api.post("/api/auth/signup", json=NEW)
        assert r.status_code == 403 and "turned off" in r.json()["detail"]
        api.login(VIEWER)  # existing accounts still work
