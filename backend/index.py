"""Vercel entry point (see vercel.json): the API as a serverless function.

Settings come from the Vercel project's environment variables. Locally the API is still
started with `uvicorn app.main:create_app --factory`.

If the API cannot be built (a missing setting, the in-memory database), every /api request
answers 503 with the reason instead of Vercel's bare FUNCTION_INVOCATION_FAILED.
"""
import os
import re


def _not_started(exc: Exception):
    from fastapi import FastAPI
    from fastapi.responses import JSONResponse

    reason = re.sub(r"://([^:/@\s]+):([^@\s]+)@", r"://\1:****@", f"{exc.__class__.__name__}: {exc}")[:600]
    fallback = FastAPI()

    @fallback.api_route("/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
    async def not_started(path: str):
        return JSONResponse(status_code=503, content={"ok": False, "error": f"API could not start. Details: {reason}"})

    return fallback


def _build():
    try:
        if os.environ.get("VERCEL") and os.environ.get("MONGO_URL", "").startswith("mongomock://"):
            raise RuntimeError("MONGO_URL=mongomock:// keeps data in memory, which Vercel discards between requests. "
                               "Set MONGO_URL to a real MongoDB connection string, e.g. MongoDB Atlas (mongodb+srv://...).")
        from app.main import create_app

        return create_app(serverless=True)
    except Exception as exc:  # noqa: BLE001
        return _not_started(exc)


# Vercel looks for a top-level variable named `app`, so keep this assignment at module level.
app = _build()
