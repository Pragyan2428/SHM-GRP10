"""Several API copies starting at once on an empty database (as on Vercel) must not trip over each other."""
import asyncio
from types import SimpleNamespace

from fastapi.testclient import TestClient

from app import db
from app.main import create_app, seed_users
from app.services import thresholds as thresholds_module
from app.services.thresholds import seed_thresholds

from .conftest import ADMIN, Api, make_settings


class _JustLost:
    """A collection seen by an instance that checked "not there yet" just before another instance inserted."""

    def __init__(self, real):
        self.real = real

    async def count_documents(self, *a, **k):
        return 0

    async def find_one(self, *a, **k):
        return None

    async def insert_one(self, doc):
        return await self.real.insert_one(doc)


def test_seeding_tolerates_another_instance_seeding_at_the_same_moment(monkeypatch):
    settings = make_settings()

    async def run():
        await db.connect(settings)
        real = db.get_db()
        await seed_users(settings)  # instance A
        await seed_thresholds()
        racing = SimpleNamespace(users=_JustLost(real.users), thresholds=_JustLost(real.thresholds))
        monkeypatch.setattr(db, "get_db", lambda: racing)
        monkeypatch.setattr(thresholds_module, "get_db", lambda: racing)
        await seed_users(settings)  # instance B: would insert duplicates of everything A just wrote
        await seed_thresholds()
        users = await real.users.find({}, {"_id": 0, "email": 1}).to_list(None)
        count = await real.thresholds.count_documents({})
        await db.disconnect()
        return sorted(u["email"] for u in users), count

    emails, thresholds = asyncio.run(run())
    assert emails == sorted([settings.admin_email.lower(), settings.seed_viewer_email.lower()])
    assert thresholds == 3


def test_a_failed_start_is_retried_on_the_next_request(monkeypatch):
    real_connect = db.connect
    calls = []

    async def flaky_connect(settings):
        calls.append(1)
        if len(calls) == 1:
            raise RuntimeError("ServerSelectionTimeoutError: cluster0.example.mongodb.net:27017: timed out")
        return await real_connect(settings)

    monkeypatch.setattr(db, "connect", flaky_connect)
    with TestClient(create_app(make_settings(), serverless=True, startup_retry_seconds=0)) as c:
        first = c.get("/api/health")
        assert first.status_code == 200 and first.json()["database"] is True  # the retry already succeeded
        assert len(calls) == 2
        Api(c).login(ADMIN)  # and the API works normally afterwards
