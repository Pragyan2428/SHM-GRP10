"""Each account gets alerts for its own nodes: email to its address, Telegram linked with one tap."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import notifications

from .conftest import ADMIN, DEVICE_KEY, Api, make_settings, payload

TOKEN = "777:user-alerts-token"
MAIL = dict(EMAIL_PROVIDER="smtp", SMTP_USERNAME="site.alerts@gmail.com", SMTP_PASSWORD="abcd efgh ijkl mnop")
ASHA = {"email": "asha.owner@gmail.com", "password": "Asha-pass-2026", "name": "Asha"}
RAVI = {"email": "ravi.other@gmail.com", "password": "Ravi-pass-2026", "name": "Ravi"}


class FakeTelegram:
    def __init__(self):
        self.sent, self.updates = [], []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        method = request.url.path.rsplit("/", 1)[-1]
        if method == "getMe":
            return httpx.Response(200, json={"ok": True, "result": {"username": "node_chan_bot"}})
        if method == "getUpdates":
            return httpx.Response(200, json={"ok": True, "result": self.updates})
        if method == "sendMessage":
            self.sent.append(json.loads(request.content))
            return httpx.Response(200, json={"ok": True, "result": {}})
        return httpx.Response(404, json={"ok": False})


@pytest.fixture
def world(monkeypatch):
    tg = FakeTelegram()
    mails = []

    async def fake_email(recipients, subject, body):
        mails.append({"to": list(recipients), "subject": subject})

    real = httpx.AsyncClient
    monkeypatch.setattr(notifications, "_http_client", lambda **kw: real(transport=httpx.MockTransport(tg), timeout=10, **kw))
    monkeypatch.setattr(notifications, "send_email", fake_email)
    notifications._bot_usernames.clear()
    client = TestClient(create_app(make_settings(TELEGRAM_BOT_TOKEN=TOKEN, **MAIL), start_background=False))
    client.__enter__()
    api = Api(client)
    api.login(ADMIN)
    for u in (ASHA, RAVI):
        assert api.post("/api/users", json={**u, "role": "viewer"}).status_code == 201
    api.put("/api/notifications/settings", json={"email_recipients": [], "telegram_recipients": [], "cooldown_seconds": 0})
    yield api, tg, mails
    client.__exit__(None, None, None)


def _key(api, who):
    api.login(who)
    return api.get("/api/profile/device").json()["device_key"]


def _breach(api, key, node, strain=900):
    r = api.post("/api/ingest", json=payload(node=node, strain=strain), headers={"X-Device-Key": key})
    assert r.status_code == 200, r.text
    api.drain()


def test_owner_gets_email_for_own_nodes_only(world):
    api, tg, mails = world
    asha_key = _key(api, ASHA)
    prefs = api.get("/api/profile/alerts").json()
    assert prefs["email"] == {"available": True, "enabled": True, "address": ASHA["email"]}
    assert prefs["telegram"]["available"] and not prefs["telegram"]["linked"]

    _breach(api, asha_key, "ASHA-01")
    assert [m["to"] for m in mails] == [[ASHA["email"]]]
    _breach(api, DEVICE_KEY, "SITE-09")  # the site's own node: nobody's personal alert
    assert len(mails) == 1
    assert api.get("/api/events").json()["items"][0]["owner_notifications"]["email"]["status"] == "sent"

    api.put("/api/profile/alerts", json={"email_enabled": False})
    _breach(api, asha_key, "ASHA-02")
    assert len(mails) == 1  # turned off
    alert = next(a for a in api.get("/api/events").json()["items"] if a["node_id"] == "ASHA-02")
    assert alert["owner_notifications"]["email"]["reason"] == "Turned off by the user"


def test_one_tap_telegram_link(world):
    api, tg, mails = world
    key = _key(api, ASHA)
    link = api.post("/api/profile/telegram/link").json()
    assert link["url"].startswith("https://t.me/node_chan_bot?start=")
    code = link["url"].split("start=")[1]
    assert api.post("/api/profile/telegram/check").json()["telegram"]["linked"] is False  # Start not pressed yet

    tg.updates = [{"update_id": 1, "message": {"chat": {"id": 55501, "first_name": "Asha"}, "text": f"/start {code}"}},
                  {"update_id": 2, "message": {"chat": {"id": 66602, "first_name": "Someone"}, "text": "/start other"}}]
    st = api.post("/api/profile/telegram/check").json()["telegram"]
    assert st["linked"] and st["name"] == "Asha"

    _breach(api, key, "ASHA-05")
    assert [m["chat_id"] for m in tg.sent] == ["55501"]  # only Asha's chat, not the other one
    assert "SHM STRUCTURAL ALERT" in tg.sent[0]["text"]

    api.login(RAVI)  # another account's alerts never reach Asha
    _breach(api, _key(api, RAVI), "RAVI-01")
    assert [m["chat_id"] for m in tg.sent] == ["55501"]

    api.login(ASHA)
    assert api.delete("/api/profile/telegram").json()["telegram"]["linked"] is False
    _breach(api, key, "ASHA-06")
    assert len(tg.sent) == 1


def test_link_needs_telegram_on_the_site(api):
    api.login(ADMIN)
    assert api.post("/api/profile/telegram/link").status_code == 409
    assert api.get("/api/profile/alerts").json()["telegram"]["available"] is False


def test_each_account_names_its_own_building(api):
    api.login(ADMIN)
    assert api.post("/api/users", json={**ASHA, "role": "viewer"}).status_code == 201
    site_name = api.get("/api/telemetry").json()["structure_name"]
    api.login(ASHA)
    assert api.get("/api/telemetry").json()["structure_name"] == "My building"  # not the site's
    assert api.put("/api/profile/building", json={"building_name": "  Hostel Block C  "}).json()["building_name"] == "Hostel Block C"
    assert api.put("/api/profile/building", json={"building_name": ""}).status_code == 422
    assert api.get("/api/telemetry").json()["structure_name"] == "Hostel Block C"
    api.login(ADMIN)
    asha = next(u for u in api.get("/api/users").json()["items"] if u["email"] == ASHA["email"])
    assert asha["building_name"] == "Hostel Block C"
    assert api.get("/api/telemetry", params={"owner": asha["id"]}).json()["structure_name"] == "Hostel Block C"
    assert api.get("/api/telemetry").json()["structure_name"] == site_name
