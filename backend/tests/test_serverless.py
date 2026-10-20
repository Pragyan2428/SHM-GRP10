"""Serverless mode (Vercel): follow-up work finishes before the reply, no loops, no demo nodes."""
import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

from app import db
from app.main import create_app
from app.services import sheets

from .conftest import ADMIN, Api, ingest, make_settings, payload
from .test_sheets_apps_script import SCRIPT_ENV, FakeScript

BACKEND = Path(__file__).resolve().parent.parent


def _serverless(**env):
    return TestClient(create_app(make_settings(**env), serverless=True))


def test_alert_is_in_the_sheet_when_the_reply_arrives(monkeypatch):
    script = FakeScript()
    monkeypatch.setattr(sheets, "_post", script)
    with _serverless(**SCRIPT_ENV) as c:
        api = Api(c)
        api.login(ADMIN)
        r = ingest(api, payload(strain=700))  # no api.drain(): the reply itself waits for the work
        assert r.status_code == 200 and r.json()["alert_triggered"]
        alert_id = r.json()["alerts"][0]["id"]
        row = script.row(alert_id)
        assert row["Notification Status"] == "disabled" and row["Status"] == "open"

        assert api.post(f"/api/events/{alert_id}/acknowledge").status_code == 200
        assert script.row(alert_id)["Status"] == "acknowledged"
        assert api.get("/api/google-sheets/status").json()["pending_rows"] == 0


def test_no_simulator_loop_and_no_demo_nodes(monkeypatch):
    with _serverless(SIMULATOR_ENABLED=False) as c:
        api = Api(c)
        api.login(ADMIN)
        assert c.app.state.simulator._task is None
        assert api.get("/api/nodes").json()["items"] == []
        ingest(api, payload(node="ESP32-REAL"))
        assert [n["node_id"] for n in api.get("/api/nodes").json()["items"]] == ["ESP32-REAL"]


def _entry_point_health(**env) -> str:
    """Import backend/index.py the way Vercel does and call /api/health; returns 'status json'."""
    code = ("import json, index; from fastapi.testclient import TestClient\n"
            "with TestClient(index.app) as c:\n"
            "    r = c.get('/api/health'); print(r.status_code, json.dumps(r.json()))")
    out = subprocess.run([sys.executable, "-c", code], cwd=BACKEND, env={**os.environ, "VERCEL": "1", **env},
                         capture_output=True, text=True, timeout=120)
    assert out.returncode == 0, out.stderr
    return out.stdout.strip().splitlines()[-1]


def test_vercel_entry_point_refuses_the_in_memory_database():
    out = _entry_point_health(MONGO_URL="mongomock://", JWT_SECRET="x" * 40)
    assert out.startswith("503") and "MongoDB Atlas" in out


def test_vercel_entry_point_reports_a_missing_setting():
    out = _entry_point_health(MONGO_URL="mongodb://db.invalid:27017", JWT_SECRET="too-short")
    assert out.startswith("503") and "JWT_SECRET" in out


def test_a_failed_database_start_is_explained_without_the_password(monkeypatch):
    async def bad_auth(settings):
        raise RuntimeError("bad auth : authentication failed for mongodb+srv://shm_user:S3cretPass@cluster0.x.mongodb.net/")

    monkeypatch.setattr(db, "connect", bad_auth)
    with _serverless() as c:
        r = c.get("/api/health")
        assert r.status_code == 503 and r.json()["ok"] is False
        error = r.json()["error"]
        assert "password in MONGO_URL is wrong" in error and "authentication failed" in error
        assert "S3cretPass" not in error and "shm_user:****@" in error
        assert c.post("/api/ingest", json={}).status_code == 503  # every API path explains, none crashes
