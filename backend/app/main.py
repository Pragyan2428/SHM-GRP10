"""Smart Structural Health Monitoring System API."""
from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import db
from .config import Settings, get_settings, set_settings
from .routers import admin, auth, monitoring, profile
from .security import hash_password
from .services import pipeline, sheets, tasks
from .services.mqtt import MqttService
from .services.simulator import Simulator
from .services.thresholds import seed_thresholds

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("shm")


async def seed_users(settings: Settings) -> None:
    users = db.get_db().users
    if await users.count_documents({}) == 0:
        if not (settings.admin_email and settings.admin_password):
            log.error("No users exist and ADMIN_EMAIL/ADMIN_PASSWORD are not set - nobody can log in. "
                      "Set them in backend/.env and restart.")
            return
        await users.insert_one({
            "id": db.new_id("usr_"), "email": settings.admin_email.lower(), "name": settings.admin_name,
            "role": "admin", "password_hash": hash_password(settings.admin_password),
            "active": True, "created_at": db.utcnow()})
        log.info("Seeded administrator %s", settings.admin_email)
    if settings.seed_viewer_email and settings.seed_viewer_password and \
            not await users.find_one({"email": settings.seed_viewer_email.lower()}):
        await users.insert_one({
            "id": db.new_id("usr_"), "email": settings.seed_viewer_email.lower(), "name": "Viewer",
            "role": "viewer", "password_hash": hash_password(settings.seed_viewer_password),
            "active": True, "created_at": db.utcnow()})


def create_app(settings: Settings | None = None, start_background: bool = True) -> FastAPI:
    settings = settings or get_settings()
    settings.validate_core()
    set_settings(settings)

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pipeline.reset_locks()
        sheets.reset_lock()
        await db.connect(settings)
        await seed_thresholds()
        await seed_users(settings)
        app.state.simulator = Simulator(settings)
        app.state.mqtt = MqttService(settings)
        await app.state.simulator.ensure_nodes()
        if start_background:
            app.state.simulator.start()
            app.state.mqtt.start()
        yield
        await app.state.simulator.stop()
        app.state.mqtt.stop()
        await tasks.drain()
        await db.disconnect()

    app = FastAPI(title="Smart SHM System API", version="1.0.0", lifespan=lifespan)
    app.dependency_overrides[get_settings] = lambda: settings

    app.add_middleware(
        CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "DELETE"],
        allow_headers=["Content-Type", "X-SHM-Client", "X-Device-Key"],
        expose_headers=["Content-Disposition", "X-Row-Count"])

    @app.middleware("http")
    async def security_headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("X-Frame-Options", "DENY")
        response.headers.setdefault("Referrer-Policy", "same-origin")
        if request.url.path.startswith("/api/"):
            response.headers.setdefault("Cache-Control", "no-store")
        return response

    @app.exception_handler(RequestValidationError)
    async def validation_handler(request: Request, exc: RequestValidationError):
        errors = [{"field": ".".join(str(p) for p in e["loc"][1:]), "message": e["msg"]} for e in exc.errors()]
        msg = "; ".join(f"{e['field']}: {e['message']}" if e["field"] else e["message"] for e in errors)
        return JSONResponse(status_code=422, content={"detail": msg or "Invalid request", "errors": errors})

    @app.get("/api/health")
    async def health():
        return {"ok": True, "database": await db.ping()}

    app.include_router(auth.router)
    app.include_router(monitoring.router)
    app.include_router(admin.router)
    app.include_router(profile.router)
    return app
# Run with: uvicorn app.main:create_app --factory