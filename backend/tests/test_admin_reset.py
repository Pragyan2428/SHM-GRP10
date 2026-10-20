"""Recovering or changing the admin login with ADMIN_RESET (set on the host, e.g. Vercel)."""
import uuid

from fastapi.testclient import TestClient

from app.db import get_db
from app.main import create_app

from .conftest import ADMIN, VIEWER, Api, make_settings


def _start(url, **env):
    """Start (and stop) an API on the shared in-memory database `url`, like one cold start."""
    with TestClient(create_app(make_settings(MONGO_URL=url, **env), start_background=False)) as c:
        return c


def _login(url, email, password, **env):
    with TestClient(create_app(make_settings(MONGO_URL=url, **env), start_background=False)) as c:
        return Api(c).post("/api/auth/login", json={"email": email, "password": password})


def test_reset_sets_a_new_password_even_after_a_lockout():
    url = f"mongomock://{uuid.uuid4().hex}"
    _start(url)  # first start seeds the admin from ADMIN_EMAIL / ADMIN_PASSWORD
    for _ in range(5):  # someone mistyped the password until the account locked
        _login(url, ADMIN["email"], "wrong-password-1")
    assert _login(url, ADMIN["email"], ADMIN["password"]).status_code == 429

    new = "Fresh-Admin-pass-42"
    r = _login(url, ADMIN["email"], new, ADMIN_PASSWORD=new, ADMIN_RESET=True)
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
    assert _login(url, ADMIN["email"], ADMIN["password"]).status_code == 401  # the old password no longer works


def test_reset_can_move_the_admin_login_to_another_email():
    url = f"mongomock://{uuid.uuid4().hex}"
    _start(url)
    env = dict(ADMIN_EMAIL="Owner.Name@Gmail.com", ADMIN_PASSWORD="Owner-pass-2026", ADMIN_RESET=True)
    r = _login(url, "owner.name@gmail.com", "Owner-pass-2026", **env)
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
    # without the switch, later starts leave the account alone (a changed password is kept)
    assert _login(url, "owner.name@gmail.com", "Owner-pass-2026", ADMIN_PASSWORD="ignored-now").status_code == 200


def test_reset_promotes_an_existing_viewer():
    url = f"mongomock://{uuid.uuid4().hex}"
    _start(url)
    env = dict(ADMIN_EMAIL=VIEWER["email"], ADMIN_PASSWORD="Promoted-pass-9", ADMIN_RESET=True)
    r = _login(url, VIEWER["email"], "Promoted-pass-9", **env)
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"


def test_an_admin_is_created_when_only_other_users_exist():
    url = f"mongomock://{uuid.uuid4().hex}"
    # first start without an admin login configured; someone signs up meanwhile
    with TestClient(create_app(make_settings(MONGO_URL=url, ADMIN_EMAIL="", ADMIN_PASSWORD=""),
                               start_background=False)) as c:
        api = Api(c)
        assert api.run(get_db().users.count_documents, {"role": "admin"}) == 0
        api.run(get_db().users.insert_one, {"id": "usr_x", "email": "early@gmail.com", "name": "Early",
                                            "role": "viewer", "password_hash": "x", "active": True})
    r = _login(url, ADMIN["email"], ADMIN["password"])  # the admin settings are added and the API restarts
    assert r.status_code == 200 and r.json()["user"]["role"] == "admin"
