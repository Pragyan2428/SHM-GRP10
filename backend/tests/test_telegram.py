"""Telegram alerts to the admin through a bot. A fake Telegram API is used; nothing is sent."""
import json

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import notifications

from .conftest import ADMIN, Api, ingest, make_settings, payload

TOKEN = "123456:ABC-test-token"


class FakeTelegram:
    def __init__(self):
        self.sent, self.fail_with = [], None
        self.updates = [{"update_id": 1, "message": {"chat": {"id": 987654321, "type": "private", "first_name": "Pragyan",
                                                                "username": "pragyan"}, "text": "/start"}}]

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.url.path.startswith(f"/bot{TOKEN}/")
        method = request.url.path.rsplit("/", 1)[-1]
        if method == "getUpdates":
            return httpx.Response(200, json={"ok": True, "result": self.updates})
        if method == "sendMessage":
            body = json.loads(request.content)
            if self.fail_with:
                return httpx.Response(403, json={"ok": False, "description": self.fail_with})
            self.sent.append(body)
            return httpx.Response(200, json={"ok": True, "result": {"message_id": len(self.sent)}})
        return httpx.Response(404, json={"ok": False, "description": "Not Found"})


@pytest.fixture
def telegram(monkeypatch):
    fake = FakeTelegram()
    real = httpx.AsyncClient
    monkeypatch.setattr(notifications, "_http_client", lambda **kw: real(transport=httpx.MockTransport(fake), timeout=10, **kw))
    return fake


def _api(**env):
    client = TestClient(create_app(make_settings(**env), start_background=False))
    client.__enter__()
    api = Api(client)
    api.login(ADMIN)
    return client, api


def test_not_configured_is_reported():
    client, api = _api()
    try:
        st = api.get("/api/notifications/status").json()["providers"]["telegram"]
        assert st["configured"] is False and "@BotFather" in st["message"]
        assert api.post("/api/notifications/telegram/chats").json()["ok"] is False
    finally:
        client.__exit__(None, None, None)


def test_find_chat_test_message_and_alerts(telegram):
    client, api = _api(TELEGRAM_BOT_TOKEN=TOKEN)
    try:
        chats = api.post("/api/notifications/telegram/chats").json()
        assert chats["ok"] and chats["chats"] == [{"id": "987654321", "name": "Pragyan", "username": "pragyan", "type": "private"}]
        assert api.put("/api/notifications/settings", json={"telegram_recipients": ["12"]}).status_code == 422
        r = api.put("/api/notifications/settings", json={"telegram_recipients": ["987654321"], "min_severity": "major"})
        assert r.status_code == 200, r.text

        r = api.post("/api/notifications/test", json={"channel": "telegram"}).json()
        assert r["ok"] and telegram.sent[-1]["chat_id"] == "987654321" and "[TEST]" in telegram.sent[-1]["text"]

        ingest(api, payload(strain=900))  # a breach is sent to the admin's Telegram
        api.drain()
        alert = api.get("/api/events", params={"parameter": "strain"}).json()["items"][0]
        assert alert["notifications"]["telegram"]["status"] == "sent"
        assert "SHM STRUCTURAL ALERT" in telegram.sent[-1]["text"] and "Strain" in telegram.sent[-1]["text"]
    finally:
        client.__exit__(None, None, None)


def test_a_failed_send_explains_what_to_do(telegram):
    telegram.fail_with = "Forbidden: bot can't initiate conversation with a user"
    client, api = _api(TELEGRAM_BOT_TOKEN=TOKEN)
    try:
        api.put("/api/notifications/settings", json={"telegram_recipients": ["987654321"]})
        r = api.post("/api/notifications/test", json={"channel": "telegram"}).json()
        assert r["ok"] is False and "press Start" in r["message"]
    finally:
        client.__exit__(None, None, None)
