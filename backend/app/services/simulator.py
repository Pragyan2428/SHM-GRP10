"""Simulated ESP32 fleet. Produces realistic, mean-reverting strain, vibration and
temperature readings with occasional slow excursions (drift up past the limit, then
recover) and short vibration jolts, and feeds them through exactly the same pipeline
as real HTTP/MQTT data."""
from __future__ import annotations

import asyncio
import logging
import math
import random
from typing import Optional

from ..config import Settings
from ..db import get_db, get_setting, put_setting, utcnow
from ..models import IngestPayload
from . import pipeline
from .thresholds import DEFAULTS, PARAMETERS

log = logging.getLogger("shm.simulator")

# Six nodes on a four-storey building (ground floor + 3 floors + roof). x/y are positions
# (0-100) on the building elevation drawn by the dashboard map.
NODES = [
    {"node_id": "ESP32-01", "location": "Foundation - column C1 footing, north-west corner", "x": 25.5, "y": 81, "firmware": "2.3.1"},
    {"node_id": "ESP32-02", "location": "Ground floor - column C3, mid-height", "x": 58.3, "y": 74, "firmware": "2.3.1"},
    {"node_id": "ESP32-03", "location": "First floor - main beam B2, mid-span", "x": 50, "y": 66, "firmware": "2.3.0"},
    {"node_id": "ESP32-04", "location": "Second floor - slab S4 centre, assembly hall", "x": 33, "y": 50, "firmware": "2.3.1"},
    {"node_id": "ESP32-05", "location": "Third floor - beam-column joint C4/B7, east face", "x": 75, "y": 34, "firmware": "2.2.4"},
    {"node_id": "ESP32-06", "location": "Roof - water tank support frame", "x": 62, "y": 13, "firmware": "2.3.1"},
]

# Normal operating level as a fraction of the safe threshold, and noise.
BASE = {"strain": 0.52, "vibration": 0.35, "temperature": 0.66}
NOISE = {"strain": 0.015, "vibration": 0.03, "temperature": 0.006}


class _Sensor:
    def __init__(self, param: str, rng: random.Random):
        self.param = param
        self.rng = rng
        self.base = BASE[param] * rng.uniform(0.9, 1.1)
        self.level = self.base
        self.episode: Optional[dict] = None

    def start_episode(self, peak: float, steps: int) -> None:
        self.episode = {"target": peak, "up": steps, "hold": self.rng.randint(1, 3), "down": steps}

    def step(self, t: float) -> float:
        rng = self.rng
        target = self.base
        if self.param == "temperature":
            target += 0.04 * math.sin(t / 600)  # slow thermal cycle
        if self.episode:
            ep = self.episode
            if ep["up"] > 0:
                self.level += (ep["target"] - self.level) / ep["up"]
                ep["up"] -= 1
            elif ep["hold"] > 0:
                ep["hold"] -= 1
            elif ep["down"] > 0:
                self.level += (target - self.level) / ep["down"]
                ep["down"] -= 1
            else:
                self.episode = None
            frac = self.level + rng.gauss(0, NOISE[self.param] * 0.4)
        else:
            # Ornstein-Uhlenbeck: mean-reverting, so no random jumps
            self.level += 0.25 * (target - self.level) + rng.gauss(0, NOISE[self.param])
            frac = self.level
        if self.param == "vibration" and not self.episode and rng.random() < 0.003:
            frac = rng.uniform(1.02, 1.3)  # e.g. heavy machinery or a dropped load: a single jolt
        safe = DEFAULTS[self.param]["safe_threshold"]
        return round(max(0.0, frac) * safe, DEFAULTS[self.param]["decimals"])


class Simulator:
    def __init__(self, settings: Settings, seed: Optional[int] = None):
        self.settings = settings
        self.rng = random.Random(seed)
        self.sensors = {n["node_id"]: {p: _Sensor(p, self.rng) for p in PARAMETERS} for n in NODES}
        self.battery = {n["node_id"]: self.rng.uniform(70, 100) for n in NODES}
        self.ticks = 0
        self._task: Optional[asyncio.Task] = None

    async def ensure_nodes(self) -> None:
        now = utcnow()
        for n in NODES:
            # Location and map position are kept in sync with NODES so the demo always matches the map.
            await get_db().sensor_nodes.update_one(
                {"node_id": n["node_id"]},
                {"$set": {"location": n["location"], "map_x": n["x"], "map_y": n["y"]},
                 "$setOnInsert": {"node_id": n["node_id"], "label": n["node_id"], "firmware": n["firmware"],
                                  "calibrated_at": now, "created_at": now, "latest": {}}},
                upsert=True)

    async def is_enabled(self) -> bool:
        s = await get_setting("system", {"simulator_enabled": self.settings.simulator_enabled})
        return bool(s.get("simulator_enabled"))

    async def set_enabled(self, enabled: bool) -> None:
        await put_setting("system", {"simulator_enabled": enabled})

    def _maybe_start_episode(self) -> None:
        # Roughly one excursion every ~2-3 minutes across the fleet.
        if self.rng.random() < 0.035:
            node = self.rng.choice(NODES)["node_id"]
            param = self.rng.choice(["strain", "vibration", "temperature"])
            sensor = self.sensors[node][param]
            if sensor.episode is None:
                # Most episodes cross the limit; some only approach it (early warning only).
                peak = self.rng.uniform(1.03, 1.3) if self.rng.random() < 0.65 else self.rng.uniform(0.86, 0.96)
                sensor.start_episode(peak, self.rng.randint(6, 10))
                if param == "temperature" and self.rng.random() < 0.6:  # thermal expansion raises strain too
                    s2 = self.sensors[node]["strain"]
                    if s2.episode is None:
                        s2.start_episode(peak * 0.9, self.rng.randint(6, 10))

    async def tick(self) -> list[dict]:
        self.ticks += 1
        self._maybe_start_episode()
        t = self.ticks * self.settings.simulator_interval_seconds
        results = []
        for n in NODES:
            nid = n["node_id"]
            self.battery[nid] = max(5.0, self.battery[nid] - self.rng.uniform(0, 0.01))
            payload = IngestPayload(
                node_id=nid, location=n["location"],
                readings={p: s.step(t) for p, s in self.sensors[nid].items()},
                battery=round(self.battery[nid], 1),
                rssi=max(-100, min(-30, int(self.rng.gauss(-58, 6)))),
                firmware=n["firmware"])
            results.append(await pipeline.process_payload(payload, "simulated"))
        return results

    async def run(self) -> None:
        await self.ensure_nodes()
        log.info("Simulator loop started (interval %.1fs)", self.settings.simulator_interval_seconds)
        while True:
            try:
                if await self.is_enabled():
                    await self.tick()
            except asyncio.CancelledError:
                raise
            except Exception:  # keep the loop alive no matter what
                log.exception("Simulator tick failed")
            await asyncio.sleep(self.settings.simulator_interval_seconds)

    def start(self) -> None:
        self._task = asyncio.get_running_loop().create_task(self.run(), name="simulator")

    async def stop(self) -> None:
        if self._task:
            self._task.cancel()
            try:
                await self._task
            except (asyncio.CancelledError, Exception):
                pass
