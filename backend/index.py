"""Vercel entry point (see vercel.json): the API as a serverless function.

Settings come from the Vercel project's environment variables. Locally the API is still
started with `uvicorn app.main:create_app --factory`.
"""
import os

from app.main import create_app

if os.environ.get("VERCEL") and os.environ.get("MONGO_URL", "").startswith("mongomock://"):
    raise RuntimeError("MONGO_URL=mongomock:// keeps data in memory, which Vercel discards between requests. "
                       "Set MONGO_URL to a real MongoDB connection string, e.g. MongoDB Atlas (mongodb+srv://...).")

app = create_app(serverless=True)
