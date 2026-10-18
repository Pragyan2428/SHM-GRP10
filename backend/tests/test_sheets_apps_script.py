"""Google Sheets through the Apps Script web app (no service-account key)."""
import shutil
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.db import get_db
from app.main import create_app
from app.services import sheets

from .conftest import ADMIN, VIEWER, Api, ingest, make_settings, payload

URL = "https://script.google.com/macros/s/AKfycbTEST/exec"
SECRET = "apps-script-secret-for-tests"
SCRIPT_ENV = dict(GOOGLE_SHEETS_WEBHOOK_URL=URL, GOOGLE_SHEETS_WEBHOOK_SECRET=SECRET)


class FakeScript:
    """Behaves like sheets_apps_script.gs: checks the secret, keeps a header and one row per Alert ID.
    version=1 acts like the first script, which had no "upsert" and did not report a version."""

    def __init__(self, version=2):
        self.header, self.rows, self.calls = None, [], []
        self.version = version
        self.fail_next_write = False

    def reply(self, data):
        return {**data, "version": self.version} if self.version > 1 else data

    def __call__(self, url, body):
        self.calls.append(body["action"])
        assert url == URL
        if body.get("secret") != SECRET:
            return {"ok": False, "error": "Wrong secret - check SHM_SECRET and GOOGLE_SHEETS_WEBHOOK_SECRET"}
        self.header = sheets.HEADER
        action = body["action"]
        if action in ("ping", "setup"):
            return self.reply({"ok": True, "spreadsheet": "SHM Alerts Log", "rows": len(self.rows),
                               "url": "https://docs.google.com/spreadsheets/d/abc123/edit"})
        if action == "ids":
            return self.reply({"ok": True, "ids": [r[0] for r in self.rows]})
        if action == "upsert" and self.version > 1:
            if self.fail_next_write:
                self.fail_next_write = False
                raise sheets.SheetsError("Apps Script web app HTTP 500: busy")
            where = {r[0]: i for i, r in enumerate(self.rows)}
            appended = updated = 0
            for r in body["rows"]:
                assert len(r) == len(sheets.HEADER)
                if r[0] in where:
                    self.rows[where[r[0]]] = r
                    updated += 1
                else:
                    where[r[0]] = len(self.rows)
                    self.rows.append(r)
                    appended += 1
            return self.reply({"ok": True, "appended": appended, "updated": updated})
        return self.reply({"ok": False, "error": "Unknown action"})

    def row(self, alert_id):
        return dict(zip(sheets.HEADER, next(r for r in self.rows if r[0] == alert_id)))


@pytest.fixture
def script(monkeypatch):
    fake = FakeScript()
    monkeypatch.setattr(sheets, "_post", fake)
    return fake


def _client(**env):
    return TestClient(create_app(make_settings(**env), start_background=False))


def test_apps_script_mode_needs_no_key_or_spreadsheet_id(script):
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        st = api.get("/api/google-sheets/status").json()
        assert st["configured"] and st["connected"] and st["mode"] == "apps_script"
        assert st["service_account_email"] is None and st["spreadsheet_id"] is None
        assert api.get("/api/system/status").json()["integrations"]["google_sheets"] is True


def test_sync_through_apps_script_without_duplicates(script):
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        api.put("/api/google-sheets/settings", json={"auto_sync": False})
        ingest(api, payload(strain=700, temperature=45))
        api.drain()
        script.fail_next_write = True
        r = api.post("/api/google-sheets/sync").json()
        assert r["ok"] is False and "HTTP 500" in r["message"]
        assert api.get("/api/google-sheets/status").json()["pending_rows"] == 2
        r = api.post("/api/google-sheets/sync").json()
        assert r["ok"] and r["synced"] == 2 and r["appended"] == 2
        r = api.post("/api/google-sheets/sync").json()  # nothing new, and nothing appended twice
        assert r["ok"] and r["synced"] == 0
        assert len(script.rows) == 2 and len(script.rows[0]) == len(sheets.HEADER)
        assert script.calls[:2] == ["setup", "upsert"]
        st = api.get("/api/google-sheets/status").json()
        assert st["pending_rows"] == 0 and st["spreadsheet_url"].startswith("https://docs.google.com/spreadsheets/")


def test_new_alerts_are_appended_automatically(script):
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        ingest(api, payload(vibration=2.1))
        api.drain()
        assert len(script.rows) == 1 and script.rows[0][2] == "Vibration"


def test_check_connection_reports_the_spreadsheet(script):
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        r = api.post("/api/google-sheets/test").json()
        assert r["ok"] and r["spreadsheet"] == "SHM Alerts Log" and "Connected" in r["message"]
        st = api.get("/api/google-sheets/status").json()
        assert st["spreadsheet_name"] == "SHM Alerts Log" and st["spreadsheet_url"]
        assert script.rows == []  # a test never writes rows


def _alert(api, parameter="strain"):
    items = api.get("/api/events", params={"parameter": parameter, "type": "threshold"}).json()["items"]
    assert len(items) == 1
    return items[0]


def test_acknowledging_updates_the_existing_row(script):
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        ingest(api, payload(strain=700))
        api.drain()
        alert = _alert(api)
        row = script.row(alert["id"])
        assert row["Status"] == "open" and row["Acknowledged By"] == "" and row["Resolved At"] == ""

        assert api.post(f"/api/events/{alert['id']}/acknowledge", json={"note": "checked"}).status_code == 200
        api.drain()
        row = script.row(alert["id"])
        assert len(script.rows) == 1  # the same row was rewritten, not a new one added
        assert row["Status"] == "acknowledged"
        assert ADMIN["email"] in row["Acknowledged By"] and row["Acknowledged At"].startswith("20")
        assert api.get("/api/google-sheets/status").json()["pending_rows"] == 0


def test_escalation_and_resolution_update_the_row(script):
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        ingest(api, payload(strain=700))
        api.drain()
        alert_id = _alert(api)["id"]
        assert script.row(alert_id)["Severity"] == "major"

        ingest(api, payload(strain=900))  # same excursion, now over the critical limit
        api.drain()
        row = script.row(alert_id)
        assert row["Severity"] == "critical" and row["Peak Value"] == 900 and row["Status"] == "open"

        ingest(api, payload(strain=300))  # back under the limit: the alert clears
        api.drain()
        row = script.row(alert_id)
        assert row["Status"] == "resolved" and row["Resolved At"].startswith("20")
        assert len(script.rows) == 1

        ingest(api, payload(strain=310))  # ordinary readings do not touch the sheet
        api.drain()
        calls = len(script.calls)
        ingest(api, payload(strain=320))
        api.drain()
        assert len(script.calls) == calls


def test_a_change_during_a_sync_is_not_lost(script, monkeypatch):
    """An alert acknowledged while its row is being written must still get a second update."""
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        api.put("/api/google-sheets/settings", json={"auto_sync": False})
        ingest(api, payload(strain=700))
        api.drain()
        alert_id = _alert(api)["id"]
        real_upsert = sheets.AppsScriptClient.upsert_rows

        def upsert_then_ack(self, rows):
            out = real_upsert(self, rows)
            api.run(lambda: get_db().alert_events.update_one(
                {"id": alert_id}, sheets.row_changed({"status": "acknowledged", "acknowledged_by": "late@example.com"})))
            return out

        monkeypatch.setattr(sheets.AppsScriptClient, "upsert_rows", upsert_then_ack)
        assert api.post("/api/google-sheets/sync").json()["appended"] == 1
        assert api.get("/api/google-sheets/status").json()["pending_rows"] == 1  # the late change is still due
        monkeypatch.setattr(sheets.AppsScriptClient, "upsert_rows", real_upsert)
        r = api.post("/api/google-sheets/sync").json()
        assert r["updated"] == 1 and script.row(alert_id)["Acknowledged By"] == "late@example.com"


def test_an_old_script_is_reported_clearly(monkeypatch):
    old = FakeScript(version=1)
    monkeypatch.setattr(sheets, "_post", old)
    with _client(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        r = api.post("/api/google-sheets/test").json()
        assert r["ok"] and r["script_outdated"] and "New version" in r["message"]
        assert api.get("/api/google-sheets/status").json()["script_outdated"] is True
        ingest(api, payload(strain=700))
        api.drain()
        st = api.get("/api/google-sheets/status").json()
        assert "older version" in st["last_error"] and st["pending_rows"] == 1 and old.rows == []

        new = FakeScript()  # the user pastes the new code and deploys a new version
        monkeypatch.setattr(sheets, "_post", new)
        assert api.post("/api/google-sheets/sync").json()["appended"] == 1
        assert api.get("/api/google-sheets/status").json()["script_outdated"] is False


def test_wrong_secret_is_reported(script):
    with _client(GOOGLE_SHEETS_WEBHOOK_URL=URL, GOOGLE_SHEETS_WEBHOOK_SECRET="not-the-right-secret") as c:
        api = Api(c)
        api.login(ADMIN)
        r = api.post("/api/google-sheets/test").json()
        assert r["ok"] is False and "Wrong secret" in r["message"]
        assert "Wrong secret" in api.get("/api/google-sheets/status").json()["last_error"]


def test_only_apps_script_urls_are_accepted(script):
    with _client(GOOGLE_SHEETS_WEBHOOK_URL="https://evil.example.com/collect", GOOGLE_SHEETS_WEBHOOK_SECRET=SECRET) as c:
        api = Api(c)
        api.login(ADMIN)
        r = api.post("/api/google-sheets/test").json()
        assert r["ok"] is False and "script.google.com" in r["message"]
        assert script.calls == []  # nothing was sent anywhere


def test_non_json_reply_gives_a_helpful_message(monkeypatch):
    class Resp:
        status_code = 200
        text = "<html>Sign in</html>"

        def json(self):
            raise ValueError("not json")

    import requests
    monkeypatch.setattr(requests, "post", lambda *a, **k: Resp())
    with pytest.raises(sheets.SheetsError, match="Anyone"):
        sheets._post(URL, {"action": "ping"})


def test_apps_script_code_is_available_to_admins_only(api):
    api.login(VIEWER)
    assert api.get("/api/google-sheets/apps-script").status_code == 403
    api.post("/api/auth/logout")
    api.login(ADMIN)
    r = api.get("/api/google-sheets/apps-script").json()
    assert "function doPost" in r["code"] and "SHM_SECRET" in r["code"] and r["secret_env"] == "GOOGLE_SHEETS_WEBHOOK_SECRET"


def test_apps_script_takes_priority_over_a_service_account():
    s = make_settings(GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email": "x@y"}', **SCRIPT_ENV)
    assert s.sheets_mode == "apps_script"
    assert make_settings(GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email": "x@y"}').sheets_mode == "service_account"
    assert make_settings(GOOGLE_SHEETS_WEBHOOK_URL=URL).sheets_mode is None  # a secret is required too


@pytest.mark.skipif(shutil.which("node") is None, reason="Node.js is needed to run the Apps Script code")
def test_the_real_apps_script_code():
    """Runs sheets_apps_script.gs under Node with stand-ins for Google's SpreadsheetApp & co."""
    harness = Path(__file__).with_name("apps_script_harness.js")
    out = subprocess.run(["node", str(harness), str(sheets.APPS_SCRIPT_FILE)], capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stdout + out.stderr
    assert "ALL OK" in out.stdout
