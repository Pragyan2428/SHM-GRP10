import csv
import io
import json

import pytest
from fastapi.testclient import TestClient

from app.main import create_app
from app.services import notifications, sheets

from .conftest import ADMIN, Api, ingest, make_settings, payload

FAKE_SA = json.dumps({"type": "service_account", "client_email": "shm-sync@demo-project.iam.gserviceaccount.com"})
SHEET_ID = "1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789"


def _api(**overrides):
    app = create_app(make_settings(**overrides), start_background=False)
    return app


# ---- notifications -------------------------------------------------------------
def test_notifications_not_configured_keeps_processing(admin):
    st = admin.get("/api/notifications/status").json()
    assert st["providers"]["email"]["configured"] is False
    assert "Not configured" in st["providers"]["email"]["message"]
    r = ingest(admin, payload(strain=700)).json()
    assert r["alert_triggered"]
    admin.drain()
    ev = admin.get("/api/events").json()["items"][0]
    assert ev["notification_status"] == "disabled"
    assert ev["notifications"]["email"]["reason"] == "Integration not configured"
    t = admin.post("/api/notifications/test", json={"channel": "sms"}).json()
    assert t["ok"] is False and t["status"] == "disabled"


@pytest.fixture
def notify_api(monkeypatch):
    app = _api(EMAIL_PROVIDER="resend", EMAIL_API_KEY="re_test", EMAIL_FROM="alerts@example.com",
               SMS_PROVIDER="twilio", TWILIO_ACCOUNT_SID="AC123", TWILIO_AUTH_TOKEN="tok",
               TWILIO_FROM_NUMBER="+15550000000")
    with TestClient(app) as c:
        api = Api(c)
        api.login(ADMIN)
        r = api.put("/api/notifications/settings", json={
            "email_recipients": ["ops@example.com"], "sms_recipients": ["+1 555 123 4567"], "min_severity": "major"})
        assert r.status_code == 200, r.text
        assert r.json()["settings"]["sms_recipients"] == ["+15551234567"]
        yield api


def test_email_failure_is_recorded_and_telemetry_continues(notify_api, monkeypatch):
    sent = []

    async def boom(*a, **k):
        raise notifications.NotificationError("resend returned HTTP 500: upstream error")

    async def ok_sms(recipients, body):
        sent.append(body)

    monkeypatch.setattr(notifications, "send_email", boom)
    monkeypatch.setattr(notifications, "send_sms", ok_sms)
    r = ingest(notify_api, payload(vibration=2.1))
    assert r.status_code == 200 and r.json()["alert_triggered"]
    notify_api.drain()
    ev = notify_api.get("/api/events", params={"type": "threshold"}).json()["items"][0]
    assert ev["notifications"]["email"]["status"] == "failed"
    assert "HTTP 500" in ev["notifications"]["email"]["error"]
    assert ev["notifications"]["sms"]["status"] == "sent"
    assert ev["notification_status"] == "failed"
    assert "SHM STRUCTURAL ALERT" in sent[0] and "Exact location: North wing - column C1" in sent[0]
    # Telemetry still flows after the failure
    assert ingest(notify_api, payload()).status_code == 200
    logs = notify_api.get("/api/notifications/status").json()["recent_logs"]
    assert any(l["channel"] == "email" and l["status"] == "failed" for l in logs)
    assert notify_api.get("/api/events", params={"notification_status": "failed"}).json()["total"] == 1


def test_sms_failure_is_recorded(notify_api, monkeypatch):
    async def ok_email(*a, **k):
        return None

    async def sms_boom(*a, **k):
        raise notifications.NotificationError("+15551234567: HTTP 400 invalid number")

    monkeypatch.setattr(notifications, "send_email", ok_email)
    monkeypatch.setattr(notifications, "send_sms", sms_boom)
    ingest(notify_api, payload(temperature=46))
    notify_api.drain()
    ev = notify_api.get("/api/events").json()["items"][0]
    assert ev["notifications"]["email"]["status"] == "sent"
    assert ev["notifications"]["sms"]["status"] == "failed"
    assert ev["notification_status"] == "failed"


def test_severity_filter_and_test_notification(notify_api, monkeypatch):
    calls = []

    async def ok_email(recipients, subject, body):
        calls.append(subject)

    monkeypatch.setattr(notifications, "send_email", ok_email)
    notify_api.put("/api/notifications/settings", json={"min_severity": "critical", "sms_enabled": False})
    ingest(notify_api, payload(strain=650))  # major (< 775 critical) -> filtered
    notify_api.drain()
    ev = notify_api.get("/api/events").json()["items"][0]
    assert ev["notifications"]["email"]["status"] == "disabled"
    assert ev["notifications"]["sms"]["status"] == "disabled"
    t = notify_api.post("/api/notifications/test", json={"channel": "email"}).json()
    assert t["ok"] and calls and calls[0].startswith("[TEST]")


def test_invalid_phone_rejected(admin):
    r = admin.put("/api/notifications/settings", json={"sms_recipients": ["12345"]})
    assert r.status_code == 422


# ---- CSV export ------------------------------------------------------------------
def test_csv_export(admin):
    ingest(admin, payload(strain=700, vibration=2.0))
    for dataset, expected_rows in (("alerts", 2), ("telemetry", 3)):
        r = admin.post("/api/exports/csv", json={"dataset": dataset})
        assert r.status_code == 200
        assert r.headers["content-type"].startswith("text/csv")
        assert "attachment" in r.headers["content-disposition"]
        rows = list(csv.reader(io.StringIO(r.text)))
        assert rows[0] == ["Timestamp", "Parameter", "Value", "Unit", "Threshold", "Node ID", "Location",
                           "Severity", "Status", "Anomaly score"]
        assert len(rows) - 1 == expected_rows
    r = admin.post("/api/exports/csv", json={"dataset": "alerts", "parameter": "strain"})
    rows = list(csv.reader(io.StringIO(r.text)))
    assert len(rows) == 2 and rows[1][1] == "Strain" and rows[1][3] == "με"


def test_csv_neutralises_formula_injection(admin):
    b = payload()
    b["location"] = "=HYPERLINK(\"http://evil\")"
    ingest(admin, b)
    r = admin.post("/api/exports/csv", json={"dataset": "telemetry"})
    assert "'=HYPERLINK" in r.text


# ---- Google Sheets ---------------------------------------------------------------
class FakeSheet:
    def __init__(self):
        self.rows = []
        self.fail_next_append = False
        self.header = None

    def ensure_sheet(self):
        self.header = sheets.HEADER

    def existing_ids(self):
        return {r[0] for r in self.rows}

    def append_rows(self, rows):
        self.rows.extend(rows)
        if self.fail_next_append:  # rows written but the response is lost -> retry must not duplicate
            self.fail_next_append = False
            raise sheets.SheetsError("Google Sheets API HTTP 503: backend error")

    def upsert_rows(self, rows):
        where = {r[0]: i for i, r in enumerate(self.rows)}
        fresh = [r for r in rows if r[0] not in where]
        for r in rows:
            if r[0] in where:
                self.rows[where[r[0]]] = r
        if fresh:
            self.append_rows(fresh)
        return len(fresh), len(rows) - len(fresh)


def test_sheets_not_configured(admin):
    st = admin.get("/api/google-sheets/status").json()
    assert st["configured"] is False and "not configured" in st["message"]
    r = admin.post("/api/google-sheets/sync").json()
    assert r["ok"] is False and r["configured"] is False


def test_sheets_sync_and_no_duplicates(monkeypatch):
    fake = FakeSheet()
    monkeypatch.setattr(sheets, "get_client", lambda sid, ws: fake)
    app = _api(GOOGLE_SERVICE_ACCOUNT_JSON=FAKE_SA)
    with TestClient(app) as c:
        api = Api(c)
        api.login(ADMIN)
        st = api.get("/api/google-sheets/status").json()
        assert st["configured"] and not st["connected"]
        assert st["service_account_email"].startswith("shm-sync@")
        assert api.post("/api/google-sheets/sync").json()["ok"] is False  # no spreadsheet yet
        assert api.put("/api/google-sheets/settings", json={"spreadsheet": "not a sheet"}).status_code == 422
        r = api.put("/api/google-sheets/settings", json={
            "spreadsheet": f"https://docs.google.com/spreadsheets/d/{SHEET_ID}/edit#gid=0", "auto_sync": False})
        assert r.json()["spreadsheet_id"] == SHEET_ID and r.json()["connected"]

        ingest(api, payload(strain=700, temperature=45))
        api.drain()
        fake.fail_next_append = True
        r = api.post("/api/google-sheets/sync").json()
        assert r["ok"] is False and "503" in r["message"]
        st = api.get("/api/google-sheets/status").json()
        assert "503" in st["last_error"] and st["pending_rows"] == 2
        r = api.post("/api/google-sheets/sync").json()  # retry: the rows are already there, so rewritten
        assert r["ok"] and r["appended"] == 0 and r["updated"] == 2
        assert len(fake.rows) == 2  # no duplicates despite the retry
        assert fake.header[0] == "Alert ID" and len(fake.rows[0]) == len(sheets.HEADER) == 15
        st = api.get("/api/google-sheets/status").json()
        assert st["last_success_at"] and st["last_error"] is None and st["pending_rows"] == 0

        ingest(api, payload(node="ESP32-02", vibration=2.0))
        api.drain()
        r = api.post("/api/exports/google-sheets").json()
        assert r["ok"] and r["synced"] == 1 and len(fake.rows) == 3


def test_sheets_auto_sync(monkeypatch):
    fake = FakeSheet()
    monkeypatch.setattr(sheets, "get_client", lambda sid, ws: fake)
    app = _api(GOOGLE_SERVICE_ACCOUNT_JSON=FAKE_SA, GOOGLE_SHEETS_SPREADSHEET_ID=SHEET_ID)
    with TestClient(app) as c:
        api = Api(c)
        api.login(ADMIN)
        ingest(api, payload(vibration=2.5))
        api.drain()
        assert len(fake.rows) == 1 and fake.rows[0][2] == "Vibration"
        assert fake.rows[0][11] == "disabled"  # notification status recorded after dispatch


# ---- users ------------------------------------------------------------------------
def test_user_management(admin):
    r = admin.post("/api/users", json={"email": "Eng@EXAMPLE.com", "name": "Field Engineer",
                                       "password": "Strong-pass-42", "role": "viewer"})
    assert r.status_code == 201
    uid = r.json()["id"]
    assert "password_hash" not in r.json()
    assert admin.post("/api/users", json={"email": "eng@example.com", "name": "Dup", "password": "Strong-pass-42"}
                      ).status_code == 409
    assert admin.post("/api/users", json={"email": "x@example.com", "name": "Weak", "password": "short"}
                      ).status_code == 422
    assert admin.put(f"/api/users/{uid}", json={"role": "admin"}).json()["role"] == "admin"
    users = admin.get("/api/users").json()["items"]
    me = next(u for u in users if u["email"] == ADMIN["email"])
    assert admin.delete(f"/api/users/{me['id']}").status_code == 409
    assert admin.put(f"/api/users/{me['id']}", json={"role": "viewer"}).status_code == 409
    assert admin.delete(f"/api/users/{uid}").status_code == 200
    assert admin.post("/api/auth/login", json={"email": "eng@example.com", "password": "Strong-pass-42"}).status_code == 401


def test_deactivated_user_cannot_use_session(admin):
    uid = admin.post("/api/users", json={"email": "temp@example.com", "name": "Temp", "password": "Strong-pass-42"}).json()["id"]
    admin.post("/api/auth/logout")
    admin.login({"email": "temp@example.com", "password": "Strong-pass-42"})
    cookie = admin.cookies.get("shm_session")
    admin.post("/api/auth/logout")
    admin.login(ADMIN)
    admin.put(f"/api/users/{uid}", json={"active": False})
    admin.cookies.set("shm_session", cookie)
    assert admin.get("/api/auth/me").status_code == 401
