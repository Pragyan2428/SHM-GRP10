"""MongoDB access (Motor). `MONGO_URL=mongomock://` gives an in-memory database for
tests and quick demos without a MongoDB server."""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from .config import Settings

log = logging.getLogger("shm.db")

_client: Any = None
_db: Any = None
_mock_clients: dict[str, Any] = {}  # mongomock clients survive app restarts within one process


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:12]}" if prefix else uuid.uuid4().hex


def as_utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    if dt.tzinfo is None:
        return dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc)


def clean(doc: Any) -> Any:
    """Make a Mongo document safe for the API: drop/convert `_id`, normalise datetimes to UTC."""
    if isinstance(doc, list):
        return [clean(d) for d in doc]
    if isinstance(doc, dict):
        out = {}
        for k, v in doc.items():
            if k == "_id":
                if "id" not in doc:
                    out["id"] = str(v)
                continue
            out[k] = clean(v)
        return out
    if isinstance(doc, datetime):
        return as_utc(doc)
    return doc


async def connect(settings: Settings) -> Any:
    global _client, _db
    if settings.mongo_url.startswith("mongomock://"):
        from mongomock_motor import AsyncMongoMockClient

        if settings.mongo_url not in _mock_clients:
            _mock_clients[settings.mongo_url] = AsyncMongoMockClient(tz_aware=True)
        _client = _mock_clients[settings.mongo_url]
        log.warning("Using in-memory mongomock database - data will not survive a restart")
    else:
        from motor.motor_asyncio import AsyncIOMotorClient

        _client = AsyncIOMotorClient(settings.mongo_url, tz_aware=True, serverSelectionTimeoutMS=5000)
        await _client.admin.command("ping")
    _db = _client[settings.db_name]
    await ensure_indexes(settings)
    return _db


async def disconnect() -> None:
    global _client, _db
    if _client is not None and _client not in _mock_clients.values():
        _client.close()
    _client = None
    _db = None


def get_db() -> Any:
    if _db is None:
        raise RuntimeError("Database not connected")
    return _db


async def ping() -> bool:
    try:
        if _client is None:
            return False
        await _client.admin.command("ping")
        return True
    except Exception:  # pragma: no cover - depends on server
        return False


async def ensure_indexes(settings: Settings) -> None:
    db = get_db()
    await db.users.create_index("email", unique=True)
    await db.users.create_index("id", unique=True)
    await db.sensor_nodes.create_index("node_id", unique=True)
    await db.sensor_nodes.create_index("owner_id")
    await db.sensor_nodes.create_index("device_key_hash", sparse=True)
    await db.pending_devices.create_index("mac", unique=True)
    await db.pending_devices.create_index([("status", 1), ("last_seen", -1)])
    await db.pending_devices.create_index("expires_at", expireAfterSeconds=0)
    await db.users.create_index("device_key", unique=True, sparse=True)
    await db.sensor_readings.create_index([("node_id", 1), ("parameter", 1), ("timestamp", -1)])
    await db.sensor_readings.create_index([("timestamp", -1)])
    await db.sensor_readings.create_index(
        [("timestamp", 1)], expireAfterSeconds=settings.reading_retention_days * 86400, name="ttl_timestamp")
    await db.alert_events.create_index("id", unique=True)
    await db.alert_events.create_index("dedupe_key", unique=True)
    await db.alert_events.create_index([("created_at", -1)])
    await db.thresholds.create_index("parameter", unique=True)
    await db.notification_logs.create_index([("created_at", -1)])
    await db.anomaly_scores.create_index([("node_id", 1), ("parameter", 1)], unique=True)
    await db.integration_settings.create_index("key", unique=True)
    await db.audit_logs.create_index([("created_at", -1)])
    await db.login_attempts.create_index("key", unique=True)
    await db.revoked_tokens.create_index("jti", unique=True)
    await db.user_avatars.create_index("user_id", unique=True)
    await db.revoked_tokens.create_index("expires_at", expireAfterSeconds=0)


async def get_setting(key: str, default: dict | None = None) -> dict:
    doc = await get_db().integration_settings.find_one({"key": key}, {"_id": 0})
    if doc is None:
        return dict(default or {})
    merged = dict(default or {})
    merged.update(doc.get("value", {}))
    return merged


async def put_setting(key: str, value: dict) -> dict:
    current = await get_setting(key)
    current.update(value)
    await get_db().integration_settings.update_one(
        {"key": key}, {"$set": {"value": current, "updated_at": utcnow()}}, upsert=True)
    return current


async def audit(actor: dict | None, action: str, target: str, details: dict | None = None) -> None:
    await get_db().audit_logs.insert_one({
        "id": new_id("aud_"),
        "actor_id": actor.get("id") if actor else None,
        "actor_email": actor.get("email") if actor else "system",
        "action": action,
        "target": target,
        "details": details or {},
        "created_at": utcnow(),
    })
