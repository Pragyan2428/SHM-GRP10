"""Google Sheets synchronisation of alert events via a service account.

Configure GOOGLE_SERVICE_ACCOUNT_JSON (the JSON key contents) or
GOOGLE_SERVICE_ACCOUNT_FILE (path), then share the spreadsheet with the service
account's e-mail address. The spreadsheet ID can come from
GOOGLE_SHEETS_SPREADSHEET_ID or be connected by an administrator in the UI.

One row per alert, keyed by the Alert ID column: an alert already in the sheet is
rewritten in place, so a retry after a partial failure never duplicates rows, and
acknowledging, escalating or resolving an alert updates its existing row.
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
from pathlib import Path
from typing import Optional

from ..config import get_settings
from ..db import as_utc, get_db, get_setting, put_setting, utcnow

log = logging.getLogger("shm.sheets")

HEADER = ["Alert ID", "Timestamp", "Parameter", "Peak Value", "Unit", "Threshold", "Node ID", "Location",
          "Severity", "Anomaly Score", "Status", "Notification Status", "Acknowledged By", "Acknowledged At",
          "Resolved At"]
LAST_COL = chr(ord("A") + len(HEADER) - 1)
SCRIPT_VERSION = 2  # sheets_apps_script.gs VERSION that can update rows in place
BATCH = 500
_lock = asyncio.Lock()


def row_changed(fields: Optional[dict] = None, inc: Optional[dict] = None) -> dict:
    """Update for an alert whose sheet row is now out of date; the next sync rewrites that row."""
    return {"$set": {**(fields or {}), "sheets_synced": False}, "$inc": {**(inc or {}), "sheets_rev": 1}}


def reset_lock() -> None:
    global _lock
    _lock = asyncio.Lock()


class SheetsError(Exception):
    pass


def extract_spreadsheet_id(value: str) -> Optional[str]:
    value = (value or "").strip()
    m = re.search(r"/spreadsheets/d/([A-Za-z0-9_-]{20,})", value)
    if m:
        return m.group(1)
    return value if re.fullmatch(r"[A-Za-z0-9_-]{20,}", value) else None


def _service_account_info() -> dict:
    s = get_settings()
    try:
        if s.google_service_account_json:
            return json.loads(s.google_service_account_json)
        with open(s.google_service_account_file, encoding="utf-8") as fh:
            return json.load(fh)
    except Exception as exc:
        raise SheetsError(f"Could not read Google service account credentials: {exc}") from exc


def service_account_email() -> Optional[str]:
    if not get_settings().google_configured:
        return None
    try:
        return _service_account_info().get("client_email")
    except SheetsError:
        return None


class SheetsClient:
    """Thin synchronous wrapper over the Sheets REST API (run in a worker thread)."""

    def __init__(self, spreadsheet_id: str, worksheet: str):
        from google.auth.transport.requests import AuthorizedSession
        from google.oauth2 import service_account

        creds = service_account.Credentials.from_service_account_info(
            _service_account_info(), scopes=["https://www.googleapis.com/auth/spreadsheets"])
        self.session = AuthorizedSession(creds)
        self.base = f"https://sheets.googleapis.com/v4/spreadsheets/{spreadsheet_id}"
        self.worksheet = worksheet

    def _check(self, r):
        if r.status_code >= 300:
            try:
                msg = r.json().get("error", {}).get("message", r.text)
            except ValueError:
                msg = r.text
            raise SheetsError(f"Google Sheets API HTTP {r.status_code}: {msg[:300]}")
        return r.json() if r.content else {}

    def _range(self, a1: str) -> str:
        from urllib.parse import quote
        return quote(f"'{self.worksheet}'!{a1}", safe="")

    def ensure_sheet(self) -> None:
        meta = self._check(self.session.get(self.base, params={"fields": "sheets.properties.title"}))
        titles = [s["properties"]["title"] for s in meta.get("sheets", [])]
        if self.worksheet not in titles:
            self._check(self.session.post(f"{self.base}:batchUpdate", json={
                "requests": [{"addSheet": {"properties": {"title": self.worksheet}}}]}))
        head = self._check(self.session.get(f"{self.base}/values/{self._range(f'A1:{LAST_COL}1')}"))
        if head.get("values", [[]])[0:1] != [HEADER]:
            self._check(self.session.put(f"{self.base}/values/{self._range(f'A1:{LAST_COL}1')}",
                                         params={"valueInputOption": "RAW"}, json={"values": [HEADER]}))

    def _ids(self) -> list[str]:
        data = self._check(self.session.get(f"{self.base}/values/{self._range('A2:A')}"))
        return [row[0] if row else "" for row in data.get("values", [])]

    def existing_ids(self) -> set[str]:
        return {i for i in self._ids() if i}

    def append_rows(self, rows: list[list]) -> None:
        self._check(self.session.post(f"{self.base}/values/{self._range('A1')}:append",
                                      params={"valueInputOption": "RAW", "insertDataOption": "INSERT_ROWS"},
                                      json={"values": rows}))

    def upsert_rows(self, rows: list[list]) -> tuple[int, int]:
        """Rewrite rows whose Alert ID is already in the sheet, append the rest. Returns (appended, updated)."""
        where: dict[str, int] = {}
        for i, aid in enumerate(self._ids()):
            if aid:
                where.setdefault(aid, i + 2)
        updates: dict[int, list] = {}
        fresh: dict[str, list] = {}
        for r in rows:
            if r[0] in where:
                updates[where[r[0]]] = r
            else:
                fresh[r[0]] = r
        if updates:
            self._check(self.session.post(f"{self.base}/values:batchUpdate", json={
                "valueInputOption": "RAW",
                "data": [{"range": f"'{self.worksheet}'!A{n}:{LAST_COL}{n}", "values": [r]} for n, r in updates.items()]}))
        if fresh:
            self.append_rows(list(fresh.values()))
        return len(fresh), len(updates)


APPS_SCRIPT_FILE = Path(__file__).resolve().parent.parent / "static" / "sheets_apps_script.gs"
APPS_SCRIPT_HOSTS = ("https://script.google.com/", "https://script.googleusercontent.com/")
NOT_CONFIGURED = ("Integration not configured - either set GOOGLE_SHEETS_WEBHOOK_URL and GOOGLE_SHEETS_WEBHOOK_SECRET "
                  "(Apps Script, no key needed) or GOOGLE_SERVICE_ACCOUNT_JSON / GOOGLE_SERVICE_ACCOUNT_FILE")
SCRIPT_OUTDATED = ("Your Apps Script is an older version that cannot update rows. On the Google Sheets page click "
                   "Copy script, paste it over the old code and save, then Deploy > Manage deployments > Edit (pencil) "
                   "> Version: New version > Deploy")


def apps_script_source() -> str:
    return APPS_SCRIPT_FILE.read_text(encoding="utf-8")


def _post(url: str, payload: dict) -> dict:  # patched in tests
    """POST to the Apps Script web app. Google answers with a redirect to the result, which is followed."""
    import requests

    r = requests.post(url, json=payload, timeout=45, allow_redirects=True)
    if r.status_code >= 300:
        raise SheetsError(f"Apps Script web app HTTP {r.status_code}: {r.text[:200]}")
    try:
        return r.json()
    except ValueError:
        raise SheetsError("Apps Script did not return JSON - check the deployment's access is set to 'Anyone' "
                          "and that the URL ends in /exec") from None


class AppsScriptClient:
    """Same interface as SheetsClient, talking to the web app in sheets_apps_script.gs."""

    def __init__(self, url: str, secret: str, worksheet: str):
        if not url.startswith(APPS_SCRIPT_HOSTS):
            raise SheetsError("GOOGLE_SHEETS_WEBHOOK_URL must be the Apps Script web app URL (https://script.google.com/macros/s/.../exec)")
        self.url, self.secret, self.worksheet = url, secret, worksheet
        self.spreadsheet_url: Optional[str] = None
        self.version: Optional[int] = None

    def _call(self, action: str, **extra) -> dict:
        data = _post(self.url, {"secret": self.secret, "worksheet": self.worksheet, "action": action, **extra})
        if not isinstance(data, dict) or not data.get("ok"):
            raise SheetsError(f"Apps Script: {(data or {}).get('error', 'unexpected reply')}")
        self.version = int(data.get("version") or 1)  # the first script version did not report one
        return data

    def ping(self) -> dict:
        data = self._call("ping")
        self.spreadsheet_url = data.get("url")
        return data

    def ensure_sheet(self) -> None:
        pass  # the script adds the worksheet and header row itself on every call, so skip a round trip

    def existing_ids(self) -> set[str]:
        return {str(i) for i in self._call("ids").get("ids", [])}

    def append_rows(self, rows: list[list]) -> None:
        # numbers and timestamps are sent as JSON; the script skips any Alert ID already present
        self._call("append", rows=rows)

    def upsert_rows(self, rows: list[list]) -> tuple[int, int]:
        try:
            data = self._call("upsert", rows=rows)
        except SheetsError as exc:
            if "Unknown action" in str(exc):
                raise SheetsError(SCRIPT_OUTDATED) from None
            raise
        self.spreadsheet_url = data.get("url") or self.spreadsheet_url
        return int(data.get("appended", 0)), int(data.get("updated", 0))


def get_client(spreadsheet_id: Optional[str], worksheet: str):  # patched in tests
    s = get_settings()
    if s.sheets_mode == "apps_script":
        return AppsScriptClient(s.google_sheets_webhook_url, s.google_sheets_webhook_secret, worksheet)
    return SheetsClient(spreadsheet_id, worksheet)


async def get_state() -> dict:
    s = get_settings()
    state = await get_setting("google_sheets", {"spreadsheet_id": s.google_sheets_spreadsheet_id,
                                                "auto_sync": True})
    if not state.get("spreadsheet_id"):
        state["spreadsheet_id"] = s.google_sheets_spreadsheet_id
    return state


def _ready(mode: Optional[str], sid: Optional[str]) -> bool:
    # an Apps Script is bound to its own spreadsheet, so it needs no spreadsheet ID
    return mode == "apps_script" or (mode == "service_account" and bool(sid))


async def status() -> dict:
    s = get_settings()
    state = await get_state()
    pending = await get_db().alert_events.count_documents({"sheets_synced": {"$ne": True}})
    sid = state.get("spreadsheet_id")
    mode = s.sheets_mode
    url = state.get("script_spreadsheet_url") if mode == "apps_script" else (
        f"https://docs.google.com/spreadsheets/d/{sid}" if sid else None)
    return {
        "configured": s.google_configured,
        "mode": mode,
        "connected": _ready(mode, sid),
        "message": None if s.google_configured else NOT_CONFIGURED,
        "service_account_email": service_account_email() if mode == "service_account" else None,
        "spreadsheet_id": sid if mode == "service_account" else None,
        "spreadsheet_name": state.get("script_spreadsheet_name") if mode == "apps_script" else None,
        "spreadsheet_url": url,
        "script_outdated": mode == "apps_script" and (state.get("script_version") or SCRIPT_VERSION) < SCRIPT_VERSION,
        "worksheet": s.google_sheets_worksheet,
        "auto_sync": state.get("auto_sync", True),
        "last_success_at": state.get("last_success_at"),
        "last_error": state.get("last_error"),
        "last_error_at": state.get("last_error_at"),
        "last_synced_count": state.get("last_synced_count"),
        "pending_rows": pending,
        "columns": HEADER,
    }


def _when(dt) -> str:
    return as_utc(dt).isoformat() if dt else ""


def _row_status(a: dict) -> str:
    if a.get("superseded_by"):
        return "superseded"
    if not a.get("active", True):  # the reading went back under the limit
        return "resolved"
    return a["status"]


def _acknowledged_by(a: dict) -> str:
    email, name = a.get("acknowledged_by"), a.get("acknowledged_by_name")
    if not email:
        return ""
    return f"{name} ({email})" if name and name != email else email


def _row(a: dict) -> list:
    # "" rather than None, so a rewritten row also clears cells that are now empty
    row = [a["id"], _when(a["created_at"]), a["label"], a.get("peak_value", a["value"]), a["unit"], a["threshold"],
           a["node_id"], a["location"], a["severity"], a.get("anomaly_score"), _row_status(a),
           a.get("notification_status"), _acknowledged_by(a), _when(a.get("acknowledged_at")),
           _when(a.get("cleared_at"))]
    return ["" if v is None else v for v in row]


async def sync(manual: bool = True) -> dict:
    s = get_settings()
    if not s.google_configured:
        return {"ok": False, "configured": False, "synced": 0, "message": NOT_CONFIGURED}
    state = await get_state()
    sid = state.get("spreadsheet_id")
    if not _ready(s.sheets_mode, sid):
        return {"ok": False, "configured": True, "synced": 0,
                "message": "No spreadsheet connected. Enter a spreadsheet URL or ID first."}
    async with _lock:  # one sync at a time - prevents racing duplicate appends
        db = get_db()
        appended = updated = 0
        client = None
        try:
            client = await asyncio.to_thread(get_client, sid, s.google_sheets_worksheet)
            await asyncio.to_thread(client.ensure_sheet)
            while True:
                batch = await db.alert_events.find({"sheets_synced": {"$ne": True}}, {"_id": 0}) \
                    .sort("created_at", 1).limit(BATCH).to_list(None)
                if not batch:
                    break
                added, changed = await asyncio.to_thread(client.upsert_rows, [_row(a) for a in batch])
                appended += added
                updated += changed
                now = utcnow()
                for a in batch:  # an alert changed while this ran stays pending and goes in the next sync
                    await db.alert_events.update_one({"id": a["id"], "sheets_rev": a.get("sheets_rev")},
                                                     {"$set": {"sheets_synced": True, "sheets_synced_at": now}})
                if len(batch) < BATCH:
                    break
        except Exception as exc:  # noqa: BLE001
            msg = str(exc) or exc.__class__.__name__
            log.warning("Google Sheets sync failed: %s", msg)
            extra = {"script_version": 1} if msg == SCRIPT_OUTDATED else {}
            await put_setting("google_sheets", {"last_error": msg, "last_error_at": utcnow(), **extra})
            return {"ok": False, "configured": True, "synced": appended + updated, "appended": appended,
                    "updated": updated, "message": msg}
        now = utcnow()
        extra = {"script_spreadsheet_url": client.spreadsheet_url} if getattr(client, "spreadsheet_url", None) else {}
        if getattr(client, "version", None):
            extra["script_version"] = client.version
        await put_setting("google_sheets", {"last_success_at": now, "last_error": None,
                                            "last_synced_count": appended + updated, **extra})
        message = f"Synced {appended} new row(s)" + (f" and updated {updated}" if updated else "")
        return {"ok": True, "configured": True, "synced": appended + updated, "appended": appended,
                "updated": updated, "last_success_at": now, "message": message}


async def auto_sync() -> None:
    s = get_settings()
    if not s.google_configured:
        return
    state = await get_state()
    if state.get("auto_sync", True) and _ready(s.sheets_mode, state.get("spreadsheet_id")):
        await sync(manual=False)


async def check_connection() -> dict:
    """Apps Script mode: ask the web app which spreadsheet it writes to (no rows are added)."""
    s = get_settings()
    if s.sheets_mode != "apps_script":
        return {"ok": False, "message": "Test connection is for the Apps Script method (GOOGLE_SHEETS_WEBHOOK_URL)"}
    try:
        client = get_client(None, s.google_sheets_worksheet)
        info = await asyncio.to_thread(client.ping)
    except Exception as exc:  # noqa: BLE001
        msg = str(exc) or exc.__class__.__name__
        await put_setting("google_sheets", {"last_error": msg, "last_error_at": utcnow()})
        return {"ok": False, "message": msg}
    version = client.version or 1
    await put_setting("google_sheets", {"script_spreadsheet_url": info.get("url"), "script_version": version,
                                        "script_spreadsheet_name": info.get("spreadsheet"), "last_error": None})
    message = f"Connected to \"{info.get('spreadsheet')}\" ({info.get('rows', 0)} alert rows)"
    outdated = version < SCRIPT_VERSION
    if outdated:
        message += ". " + SCRIPT_OUTDATED
    return {"ok": True, "spreadsheet": info.get("spreadsheet"), "url": info.get("url"), "rows": info.get("rows"),
            "script_version": version, "script_outdated": outdated, "message": message}
