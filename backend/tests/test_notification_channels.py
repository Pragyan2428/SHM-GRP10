"""WhatsApp (Twilio) and Gmail/SMTP email delivery. No real network or mail server is used."""
import smtplib
from urllib.parse import parse_qs

import httpx
import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import notifications

from .conftest import ADMIN, Api, ingest, make_settings, payload

TWILIO = dict(TWILIO_ACCOUNT_SID="AC123", TWILIO_AUTH_TOKEN="tok", TWILIO_WHATSAPP_FROM="+14155238886")
GMAIL = dict(EMAIL_PROVIDER="smtp", SMTP_USERNAME="shm.alerts@gmail.com", SMTP_PASSWORD="abcd efgh ijkl mnop")


@pytest.fixture
def make_api():
    clients = []

    def _make(**overrides):
        client = TestClient(create_app(make_settings(**overrides), start_background=False))
        client.__enter__()
        clients.append(client)
        api = Api(client)
        api.login(ADMIN)
        return api

    yield _make
    for c in clients:
        c.__exit__(None, None, None)


@pytest.fixture
def twilio(monkeypatch):
    """Capture Twilio API calls; `twilio.status` sets the HTTP status returned."""
    class Recorder:
        status = 201
        requests: list = []

    rec = Recorder()
    rec.requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        rec.requests.append(request)
        return httpx.Response(rec.status, json={"sid": "SM123"} if rec.status < 300 else {"message": "bad number"})

    real = httpx.AsyncClient
    monkeypatch.setattr(notifications, "_http_client",
                        lambda **kw: real(transport=httpx.MockTransport(handler), timeout=10, **kw))
    return rec


def form(request: httpx.Request) -> dict:
    return {k: v[0] for k, v in parse_qs(request.content.decode()).items()}


# ---- WhatsApp ---------------------------------------------------------------------
@pytest.mark.parametrize("sender", ["+14155238886", "whatsapp:+14155238886"])
def test_whatsapp_alert_sent_through_twilio(make_api, twilio, sender):
    api = make_api(**{**TWILIO, "TWILIO_WHATSAPP_FROM": sender})
    r = api.put("/api/notifications/settings", json={"whatsapp_recipients": ["+91 98765-43210"]})
    assert r.json()["settings"]["whatsapp_recipients"] == ["+919876543210"]

    ingest(api, payload(strain=700))
    api.drain()
    ev = api.get("/api/events", params={"type": "threshold"}).json()["items"][0]
    assert ev["notifications"]["whatsapp"]["status"] == "sent"
    assert ev["notifications"]["email"]["status"] == "disabled"  # email/SMS not configured here
    assert ev["notification_status"] == "sent"

    (req,) = twilio.requests
    assert str(req.url) == "https://api.twilio.com/2010-04-01/Accounts/AC123/Messages.json"
    data = form(req)
    assert data["To"] == "whatsapp:+919876543210"
    assert data["From"] == "whatsapp:+14155238886"  # never double-prefixed
    assert "SHM STRUCTURAL ALERT" in data["Body"] and "Exact location: North wing - column C1" in data["Body"]
    assert req.headers["authorization"].startswith("Basic ")


def test_whatsapp_failure_is_recorded_and_telemetry_continues(make_api, twilio):
    twilio.status = 400
    api = make_api(**TWILIO)
    api.put("/api/notifications/settings", json={"whatsapp_recipients": ["+919876543210"]})
    ingest(api, payload(vibration=2.1))
    api.drain()
    ev = api.get("/api/events", params={"type": "threshold"}).json()["items"][0]
    assert ev["notifications"]["whatsapp"]["status"] == "failed"
    assert "HTTP 400" in ev["notifications"]["whatsapp"]["error"]
    assert ev["notification_status"] == "failed"
    assert ingest(api, payload()).status_code == 200
    logs = api.get("/api/notifications/status").json()["recent_logs"]
    assert any(l["channel"] == "whatsapp" and l["status"] == "failed" and l["provider"] == "twilio" for l in logs)


def test_whatsapp_test_message(make_api, twilio):
    api = make_api(**TWILIO)
    api.put("/api/notifications/settings", json={"whatsapp_recipients": ["+919876543210"]})
    r = api.post("/api/notifications/test", json={"channel": "whatsapp"}).json()
    assert r["ok"] and r["status"] == "sent" and "WhatsApp" in r["message"]
    assert form(twilio.requests[0])["Body"].startswith("[TEST]")


def test_whatsapp_not_configured(admin):
    st = admin.get("/api/notifications/status").json()["providers"]["whatsapp"]
    assert st["configured"] is False and "TWILIO_WHATSAPP_FROM" in st["message"]
    admin.put("/api/notifications/settings", json={"whatsapp_recipients": ["+919876543210"]})
    ingest(admin, payload(strain=700))
    admin.drain()
    ev = admin.get("/api/events").json()["items"][0]
    assert ev["notifications"]["whatsapp"] == {"status": "disabled", "reason": "Integration not configured"}
    assert admin.post("/api/notifications/test", json={"channel": "whatsapp"}).json()["status"] == "disabled"
    assert admin.get("/api/system/status").json()["integrations"]["whatsapp"] is False


def test_whatsapp_can_be_turned_off(make_api, twilio):
    api = make_api(**TWILIO)
    api.put("/api/notifications/settings", json={"whatsapp_recipients": ["+919876543210"], "whatsapp_enabled": False})
    ingest(api, payload(strain=700))
    api.drain()
    ev = api.get("/api/events").json()["items"][0]
    assert ev["notifications"]["whatsapp"]["status"] == "disabled"
    assert twilio.requests == []


def test_invalid_whatsapp_number_rejected(admin):
    assert admin.put("/api/notifications/settings", json={"whatsapp_recipients": ["98765"]}).status_code == 422


# ---- Gmail / SMTP -------------------------------------------------------------------
class FakeSMTP:
    instances: list = []
    fail_login = False

    def __init__(self, host, port, timeout=None, context=None):
        self.host, self.port, self.calls, self.sent = host, port, [], []
        FakeSMTP.instances.append(self)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def starttls(self, context=None):
        self.calls.append("starttls")

    def login(self, user, password):
        self.calls.append(("login", user, password))
        if FakeSMTP.fail_login:
            raise smtplib.SMTPAuthenticationError(535, b"5.7.8 Username and Password not accepted")

    def send_message(self, msg):
        self.sent.append(msg)


@pytest.fixture
def smtp(monkeypatch):
    FakeSMTP.instances, FakeSMTP.fail_login = [], False
    monkeypatch.setattr(notifications.smtplib, "SMTP", FakeSMTP)
    monkeypatch.setattr(notifications.smtplib, "SMTP_SSL", FakeSMTP)
    return FakeSMTP


def test_gmail_smtp_sends_alert_email(make_api, smtp):
    api = make_api(**GMAIL)
    st = api.get("/api/notifications/status").json()["providers"]["email"]
    assert st["configured"] and st["provider"] == "smtp" and st["from"] == "shm.alerts@gmail.com"
    api.put("/api/notifications/settings", json={"email_recipients": ["engineer@gmail.com", "ops@gmail.com"]})
    ingest(api, payload(strain=700))
    api.drain()
    ev = api.get("/api/events", params={"type": "threshold"}).json()["items"][0]
    assert ev["notifications"]["email"]["status"] == "sent"

    (server,) = smtp.instances
    assert (server.host, server.port) == ("smtp.gmail.com", 587)
    assert server.calls == ["starttls", ("login", "shm.alerts@gmail.com", "abcd efgh ijkl mnop")]
    (msg,) = server.sent
    assert msg["From"] == "shm.alerts@gmail.com"
    assert msg["To"] == "engineer@gmail.com, ops@gmail.com"
    assert msg["Subject"].startswith("[SHM ") and "ESP32-01" in msg["Subject"]
    assert "SHM STRUCTURAL ALERT" in msg.get_content()


def test_gmail_wrong_password_explains_app_password(make_api, smtp):
    smtp.fail_login = True
    api = make_api(**GMAIL)
    api.put("/api/notifications/settings", json={"email_recipients": ["engineer@gmail.com"]})
    r = api.post("/api/notifications/test", json={"channel": "email"}).json()
    assert r["ok"] is False and r["status"] == "failed"
    assert "App Password" in r["message"]
    logs = api.get("/api/notifications/status").json()["recent_logs"]
    assert logs[0]["channel"] == "email" and logs[0]["status"] == "failed" and logs[0]["provider"] == "smtp"


def test_smtp_port_465_uses_ssl_without_starttls(make_api, smtp):
    api = make_api(**GMAIL, SMTP_PORT=465, EMAIL_FROM="SHM Alerts <shm.alerts@gmail.com>")
    api.put("/api/notifications/settings", json={"email_recipients": ["engineer@gmail.com"]})
    assert api.post("/api/notifications/test", json={"channel": "email"}).json()["ok"]
    (server,) = smtp.instances
    assert server.port == 465 and "starttls" not in server.calls
    assert server.sent[0]["From"] == "SHM Alerts <shm.alerts@gmail.com>"


def test_smtp_needs_username_and_password():
    assert make_settings(EMAIL_PROVIDER="smtp", SMTP_USERNAME="a@gmail.com").email_configured is False
    assert make_settings(**GMAIL).email_configured is True
