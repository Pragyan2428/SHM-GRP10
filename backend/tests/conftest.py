import os
import sys
import uuid
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

# Test-only values; real deployments read these from the environment / .env.
os.environ.setdefault("JWT_SECRET", "test-secret-" + "x" * 40)
os.environ.setdefault("MONGO_URL", "mongomock://")

from app.config import Settings  # noqa: E402
from app.main import create_app  # noqa: E402
from app.services import tasks  # noqa: E402

ADMIN = {"email": "admin@shm.test", "password": "Admin-Password-123"}
VIEWER = {"email": "viewer@shm.test", "password": "Viewer-Password-123"}
DEVICE_KEY = "device-key-for-tests"


def make_settings(**overrides) -> Settings:
    base = dict(
        MONGO_URL=f"mongomock://{uuid.uuid4().hex}", DB_NAME="shm_test",
        JWT_SECRET="test-secret-" + "x" * 40, COOKIE_SECURE=False,
        ADMIN_EMAIL=ADMIN["email"], ADMIN_PASSWORD=ADMIN["password"],
        SEED_VIEWER_EMAIL=VIEWER["email"], SEED_VIEWER_PASSWORD=VIEWER["password"],
        DEVICE_SHARED_KEY=DEVICE_KEY, FRONTEND_URL="http://localhost:5173",
        LOGIN_MAX_ATTEMPTS=3, SIMULATOR_INTERVAL_SECONDS=5,
        EMAIL_PROVIDER="", EMAIL_API_KEY="", EMAIL_FROM="", SMS_PROVIDER="",
        SMTP_USERNAME="", SMTP_PASSWORD="", TWILIO_WHATSAPP_FROM="", TELEGRAM_BOT_TOKEN="",
        GOOGLE_SHEETS_WEBHOOK_URL="", GOOGLE_SHEETS_WEBHOOK_SECRET="",
        GOOGLE_SERVICE_ACCOUNT_JSON="", GOOGLE_SERVICE_ACCOUNT_FILE="", MQTT_BROKER_URL="",
    )
    base.update(overrides)
    return Settings(_env_file=None, **base)


class Api:
    """TestClient wrapper that sends the web-client header and can drain background tasks."""

    def __init__(self, client: TestClient):
        self.c = client
        self.c.headers.update({"X-SHM-Client": "web"})

    def __getattr__(self, name):
        return getattr(self.c, name)

    def login(self, creds=ADMIN):
        r = self.c.post("/api/auth/login", json=creds)
        assert r.status_code == 200, r.text
        return r

    def drain(self):
        self.c.portal.call(tasks.drain)

    def run(self, fn, *args):
        return self.c.portal.call(fn, *args)


@pytest.fixture
def settings():
    return make_settings()


@pytest.fixture
def api(settings):
    app = create_app(settings, start_background=False)
    with TestClient(app, base_url="http://testserver") as client:
        yield Api(client)


@pytest.fixture
def admin(api):
    api.login(ADMIN)
    return api


def payload(node="ESP32-01", **readings):
    base = {"strain": 300.0, "vibration": 0.6, "temperature": 27.0}
    base.update(readings)
    return {"node_id": node, "location": "North wing - column C1", "readings": base, "battery": 94, "rssi": -48}


def ingest(api, body, key=DEVICE_KEY):
    return api.post("/api/ingest", json=body, headers={"X-Device-Key": key} if key else {})
