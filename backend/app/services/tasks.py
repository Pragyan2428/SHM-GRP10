"""Fire-and-forget background work (notifications, sheet sync) that must never block
or break telemetry processing. Tests call `drain()` to wait for it."""
from __future__ import annotations

import asyncio
import logging
from typing import Awaitable

log = logging.getLogger("shm.tasks")
_pending: set[asyncio.Task] = set()


def spawn(coro: Awaitable, name: str = "task") -> asyncio.Task:
    async def guarded():
        try:
            await coro
        except Exception:  # noqa: BLE001 - background failures are logged, never raised
            log.exception("Background task %s failed", name)

    task = asyncio.get_running_loop().create_task(guarded(), name=name)
    _pending.add(task)
    task.add_done_callback(_pending.discard)
    return task


async def drain() -> None:
    while _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)
