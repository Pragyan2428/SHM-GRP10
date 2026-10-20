"""Smart Structural Health Monitoring System API."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pymongo.errors import DuplicateKeyError

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


async def _insert_seed(users, doc: dict) -> bool:
    try:
        await users.insert_one(doc)
        return True
    except DuplicateKeyError:  # another API instance starting at the same moment seeded it first
        return False


async def reset_admin(settings: Settings) -> None:
    """ADMIN_RESET=true: ADMIN_EMAIL becomes an active admin whose password is exactly ADMIN_PASSWORD."""
    users = db.get_db().users
    email = settings.admin_email.strip().lower()
    changes = {"role": "admin", "active": True, "password_hash": hash_password(settings.admin_password)}
    if (await users.update_one({"email": email}, {"$set": changes})).matched_count == 0:
        await _insert_seed(users, {"id": db.new_id("usr_"), "email": email, "name": settings.admin_name,
                                   "created_at": db.utcnow(), **changes})
    await db.get_db().login_attempts.delete_one({"key": f"user:{email}"})  # lift a lockout from earlier tries
    log.warning("ADMIN_RESET is on: %s is an admin with the password from ADMIN_PASSWORD. "
                "Remove ADMIN_RESET once you can log in, or the password is reset on every start.", email)


async def seed_users(settings: Settings) -> None:
    users = db.get_db().users
    have_login = bool(settings.admin_email and settings.admin_password)
    if settings.admin_reset and have_login:
        await reset_admin(settings)
    elif await users.count_documents({"role": "admin"}) == 0:
        if not have_login:
            log.error("No admin account exists and ADMIN_EMAIL/ADMIN_PASSWORD are not set - nobody can manage "
                      "the system. Set them in backend/.env (or the host's environment variables) and restart.")
            return
        if await _insert_seed(users, {
                "id": db.new_id("usr_"), "email": settings.admin_email.lower(), "name": settings.admin_name,
                "role": "admin", "password_hash": hash_password(settings.admin_password),
                "active": True, "created_at": db.utcnow()}):
            log.info("Seeded administrator %s", settings.admin_email)
    if settings.seed_viewer_email and settings.seed_viewer_password and \
            not await users.find_one({"email": settings.seed_viewer_email.lower()}):
        await _insert_seed(users, {
            "id": db.new_id("usr_"), "email": settings.seed_viewer_email.lower(), "name": "Viewer",
            "role": "viewer", "password_hash": hash_password(settings.seed_viewer_password),
            "active": True, "created_at": db.utcnow()})


STARTUP_HINTS = [  # (text in the error, what to check)
    ("authentication failed", "The username or password in MONGO_URL is wrong (Atlas > Database Access)."),
    ("bad auth", "The username or password in MONGO_URL is wrong (Atlas > Database Access)."),
    ("dns", "The cluster address in MONGO_URL is wrong - copy the link again from Atlas > Connect > Drivers."),
    ("timed out", "Atlas could not be reached - allow 0.0.0.0/0 in Atlas > Network Access and check the cluster is running."),
    ("serverselectiontimeout", "Atlas could not be reached - allow 0.0.0.0/0 in Atlas > Network Access and check the cluster is running."),
    ("invalid uri", "MONGO_URL is not a valid MongoDB link."),
]


def describe_startup_error(exc: Exception) -> str:
    """One readable line for /api/health, with any password in a connection string hidden."""
    text = re.sub(r"://([^:/@\s]+):([^@\s]+)@", r"://\1:****@", f"{exc.__class__.__name__}: {exc}")[:600]
    hint = next((h for needle, h in STARTUP_HINTS if needle in text.lower()), None)
    return f"API could not start. {hint + ' ' if hint else ''}Details: {text}"


def create_app(settings: Settings | None = None, start_background: bool = True, serverless: bool = False,
               startup_retry_seconds: float = 10) -> FastAPI:
    """`serverless=True` is for hosts such as Vercel that may freeze the process once a reply is sent:
    no simulator/MQTT loops, and alert follow-up work (notifications, Google Sheets) finishes before replying.
    If startup fails there, /api/* explains why and startup is retried (at most every `startup_retry_seconds`)."""
    settings = settings or get_settings()
    settings.validate_core()
    set_settings(settings)
    start_background = start_background and not serverless

    async def start(app: FastAPI) -> None:
        await db.connect(settings)
        await seed_thresholds()
        await seed_users(settings)
        if not serverless or settings.simulator_enabled:  # no demo nodes on a real deployment
            await app.state.simulator.ensure_nodes()

    def startup_failed(app: FastAPI, exc: Exception) -> None:
        # A host like Vercel would only say FUNCTION_INVOCATION_FAILED; /api/* reports the reason instead.
        log.exception("API startup failed")
        app.state.startup_error = describe_startup_error(exc)
        app.state.startup_failed_at = time.monotonic()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        pipeline.reset_locks()
        sheets.reset_lock()
        app.state.simulator = Simulator(settings)
        app.state.mqtt = MqttService(settings)
        app.state.startup_error = None
        try:
            await start(app)
        except Exception as exc:
            if not serverless:
                raise
            startup_failed(app, exc)
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

    if serverless:
        retry_lock = asyncio.Lock()

        @app.middleware("http")
        async def report_startup_error(request: Request, call_next):
            state = request.app.state
            if getattr(state, "startup_error", None) and request.url.path.startswith("/api/"):
                async with retry_lock:  # e.g. the database was briefly unreachable: try starting again
                    if state.startup_error and time.monotonic() - state.startup_failed_at >= startup_retry_seconds:
                        try:
                            await db.disconnect()
                            await start(request.app)
                            state.startup_error = None
                            log.info("API started on retry")
                        except Exception as exc:  # noqa: BLE001
                            startup_failed(request.app, exc)
                if state.startup_error:
                    return JSONResponse(status_code=503, content={"ok": False, "error": state.startup_error})
            return await call_next(request)

        @app.middleware("http")
        async def finish_background_work(request: Request, call_next):
            response = await call_next(request)
            await tasks.drain()  # the platform may stop the process as soon as the reply is sent
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