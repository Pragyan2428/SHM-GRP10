"""MQTT ingestion. Subscribes to `shm/{node_id}/telemetry` (MQTT_TOPIC, default
`shm/+/telemetry`). Messages use the same JSON body as POST /api/ingest; the node id
is taken from the topic when the payload omits it. Disabled gracefully when
MQTT_BROKER_URL is not set."""
from __future__ import annotations

import asyncio
import json
import logging
import re
from typing import Optional
from urllib.parse import urlparse

from pydantic import ValidationError

from ..config import Settings
from ..db import utcnow
from ..models import IngestPayload
from . import pipeline

log = logging.getLogger("shm.mqtt")
TOPIC_RE = re.compile(r"^shm/([A-Za-z0-9_\-]{1,32})/telemetry$")


class MqttService:
    def __init__(self, settings: Settings):
        self.settings = settings
        self.client = None
        self.loop: Optional[asyncio.AbstractEventLoop] = None
        self.connected = False
        self.last_error: Optional[str] = None
        self.last_message_at = None
        self.messages_processed = 0
        self.messages_rejected = 0

    @property
    def configured(self) -> bool:
        return self.settings.mqtt_configured

    def _host_port(self) -> tuple[str, int, bool]:
        raw = self.settings.mqtt_broker_url or ""
        parsed = urlparse(raw if "://" in raw else f"mqtt://{raw}")
        tls = self.settings.mqtt_tls or parsed.scheme in ("mqtts", "ssl")
        return parsed.hostname or raw, parsed.port or self.settings.mqtt_port, tls

    def status(self) -> dict:
        host, port, tls = self._host_port() if self.configured else (None, None, False)
        return {
            "configured": self.configured,
            "enabled": self.configured,
            "connected": self.connected,
            "broker": f"{host}:{port}" if self.configured else None,
            "tls": tls,
            "topic": self.settings.mqtt_topic,
            "last_error": self.last_error,
            "last_message_at": self.last_message_at,
            "messages_processed": self.messages_processed,
            "messages_rejected": self.messages_rejected,
            "message": None if self.configured else
            "MQTT not configured (set MQTT_BROKER_URL). HTTP and simulated ingestion remain active.",
        }

    # ---- message handling (also used by POST /api/mqtt/test) -----------------
    async def handle_message(self, topic: str, raw: bytes | str | dict) -> dict:
        m = TOPIC_RE.match(topic)
        if not m:
            self.messages_rejected += 1
            raise ValueError(f"Topic '{topic}' does not match shm/{{node_id}}/telemetry")
        data = raw if isinstance(raw, dict) else json.loads(raw)
        if not isinstance(data, dict):
            raise ValueError("MQTT payload must be a JSON object")
        data.setdefault("node_id", m.group(1))
        if data["node_id"].upper() != m.group(1).upper():
            self.messages_rejected += 1
            raise ValueError("node_id in payload does not match topic")
        try:
            payload = IngestPayload(**data)
        except ValidationError:
            self.messages_rejected += 1
            raise
        result = await pipeline.process_payload(payload, "mqtt")
        self.messages_processed += 1
        self.last_message_at = utcnow()
        return result

    # ---- paho client (network thread) ----------------------------------------
    def start(self) -> None:
        if not self.configured:
            log.info("MQTT disabled: MQTT_BROKER_URL not set")
            return
        try:
            import paho.mqtt.client as mqtt
        except ImportError:  # pragma: no cover
            self.last_error = "paho-mqtt is not installed"
            return
        self.loop = asyncio.get_running_loop()
        host, port, tls = self._host_port()
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"shm-command-center-{id(self)}")
        if self.settings.mqtt_username:
            client.username_pw_set(self.settings.mqtt_username, self.settings.mqtt_password)
        if tls:
            client.tls_set()
        client.on_connect = self._on_connect
        client.on_disconnect = self._on_disconnect
        client.on_message = self._on_message
        client.reconnect_delay_set(min_delay=2, max_delay=60)
        try:
            client.connect_async(host, port, keepalive=30)
            client.loop_start()
            self.client = client
            log.info("MQTT connecting to %s:%s topic=%s", host, port, self.settings.mqtt_topic)
        except Exception as exc:  # keep the app running
            self.last_error = f"MQTT connection failed: {exc}"
            log.error(self.last_error)

    def _on_connect(self, client, userdata, flags, reason_code, properties=None):
        if getattr(reason_code, "is_failure", False):
            self.connected = False
            self.last_error = f"Broker refused connection: {reason_code}"
            return
        self.connected = True
        self.last_error = None
        client.subscribe(self.settings.mqtt_topic, qos=1)

    def _on_disconnect(self, client, userdata, flags, reason_code, properties=None):
        self.connected = False
        if reason_code and getattr(reason_code, "value", 0):
            self.last_error = f"Disconnected: {reason_code}"

    def _on_message(self, client, userdata, msg):
        if not self.loop:
            return
        fut = asyncio.run_coroutine_threadsafe(self.handle_message(msg.topic, msg.payload), self.loop)

        def _done(f):
            exc = f.exception()
            if exc:
                self.last_error = f"Rejected message on {msg.topic}: {exc}"
                log.warning(self.last_error)
        fut.add_done_callback(_done)

    async def test_connection(self, timeout: float = 5.0) -> dict:
        if not self.configured:
            return {"ok": False, "configured": False, "message": self.status()["message"]}
        import paho.mqtt.client as mqtt
        host, port, tls = self._host_port()
        result: dict = {}
        done = asyncio.Event()
        loop = asyncio.get_running_loop()
        c = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=f"shm-test-{id(result)}")
        if self.settings.mqtt_username:
            c.username_pw_set(self.settings.mqtt_username, self.settings.mqtt_password)
        if tls:
            c.tls_set()

        def on_connect(cl, ud, fl, rc, pr=None):
            result["rc"] = str(rc)
            result["ok"] = not getattr(rc, "is_failure", False)
            loop.call_soon_threadsafe(done.set)
        c.on_connect = on_connect
        try:
            c.connect_async(host, port, keepalive=10)
            c.loop_start()
            await asyncio.wait_for(done.wait(), timeout)
        except asyncio.TimeoutError:
            result = {"ok": False, "rc": "timeout"}
        except Exception as exc:
            result = {"ok": False, "rc": str(exc)}
        finally:
            c.loop_stop()
            try:
                c.disconnect()
            except Exception:
                pass
        return {"ok": result.get("ok", False), "configured": True, "broker": f"{host}:{port}",
                "message": "Connected to broker" if result.get("ok") else f"Connection failed: {result.get('rc')}"}

    def stop(self) -> None:
        if self.client:
            self.client.loop_stop()
            try:
                self.client.disconnect()
            except Exception:
                pass
