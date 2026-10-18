"""Serverless mode (Vercel): follow-up work finishes before the reply, no loops, no demo nodes."""
import os
import subprocess
import sys
from pathlib import Path

from fastapi.testclient import TestClient

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


def test_vercel_entry_point_refuses_the_in_memory_database():
    env = {**os.environ, "VERCEL": "1", "MONGO_URL": "mongomock://", "JWT_SECRET": "x" * 40}
    out = subprocess.run([sys.executable, "-c", "import index"], cwd=BACKEND, env=env,
                         capture_output=True, text=True, timeout=60)
    assert out.returncode != 0 and "MongoDB Atlas" in out.stderr
