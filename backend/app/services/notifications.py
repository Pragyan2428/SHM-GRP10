"""Provider-independent email, SMS and WhatsApp notifications.

Email: SMTP (e.g. Gmail with an App Password), Resend or SendGrid (EMAIL_PROVIDER).
SMS: Twilio (SMS_PROVIDER=twilio). WhatsApp: Twilio (TWILIO_WHATSAPP_FROM).
Per-channel status on each alert: pending | sent | failed | disabled.
Failures are recorded and surfaced but never interrupt telemetry processing."""
from __future__ import annotations

import asyncio
import logging
import smtplib
import ssl
from datetime import timedelta
from email.message import EmailMessage
from typing import Optional

import httpx

from ..config import Settings, get_settings
from ..db import as_utc, get_db, get_setting, new_id, put_setting, utcnow
from .sheets import row_changed
from .thresholds import SEVERITY_RANK

log = logging.getLogger("shm.notifications")

CHANNELS = ("email", "sms", "whatsapp")

DEFAULT_SETTINGS = {
    "browser_enabled": True,
    "email_enabled": True,
    "sms_enabled": True,
    "whatsapp_enabled": True,
    "email_recipients": [],
    "sms_recipients": [],
    "whatsapp_recipients": [],
    "min_severity": "major",
    "cooldown_seconds": 300,
}

SEVERITY_LABEL = {"early_warning": "EARLY WARNING", "major": "MAJOR", "critical": "CRITICAL"}


class NotificationError(Exception):
    pass


async def get_notification_settings() -> dict:
    return await get_setting("notifications", DEFAULT_SETTINGS)


async def save_notification_settings(values: dict) -> dict:
    return await put_setting("notifications", values)


def provider_status() -> dict:
    s = get_settings()
    email_provider = (s.email_provider or "").lower() or None
    return {
        "email": {"configured": s.email_configured, "provider": email_provider,
                  "from": s.email_sender if s.email_configured else None,
                  "message": None if s.email_configured else
                  "Not configured - for Gmail set EMAIL_PROVIDER=smtp, SMTP_USERNAME (your Gmail) and "
                  "SMTP_PASSWORD (a Google App Password); or use resend|sendgrid with EMAIL_API_KEY and EMAIL_FROM"},
        "sms": {"configured": s.sms_configured, "provider": "twilio" if s.sms_configured else None,
                "message": None if s.sms_configured else
                "Not configured - set SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER"},
        "whatsapp": {"configured": s.whatsapp_configured, "provider": "twilio" if s.whatsapp_configured else None,
                     "from": s.twilio_whatsapp_from if s.whatsapp_configured else None,
                     "message": None if s.whatsapp_configured else
                     "Not configured - set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_WHATSAPP_FROM "
                     "(Twilio sandbox: +14155238886)"},
    }


def format_message(alert: dict) -> tuple[str, str]:
    created = as_utc(alert["created_at"])
    sev = SEVERITY_LABEL.get(alert["severity"], alert["severity"].upper())
    subject = f"[SHM {sev}] {alert['label']} at {alert['node_id']} - {alert['location']}"
    lines = [
        "SHM STRUCTURAL ALERT",
        "",
        f"Parameter: {alert['label']}",
        f"Current value: {alert['value']} {alert['unit']}",
        f"Safe threshold: {alert['threshold']} {alert['unit']}",
        f"Sensor node: {alert['node_id']}",
        f"Exact location: {alert['location']}",
        f"Severity: {sev}",
        f"Timestamp: {created.strftime('%Y-%m-%d %H:%M:%S UTC')}",
    ]
    if alert.get("type") == "early_warning":
        lines += ["", f"Early warning: {alert.get('reason', '')}"]
    lines += ["", f"Alert ID: {alert['id']}"]
    return subject, "\n".join(lines)


# ---- providers ------------------------------------------------------------------
def _http_client(**kwargs) -> httpx.AsyncClient:
    """One place to build the HTTP client (tests swap in a mock transport)."""
    return httpx.AsyncClient(timeout=10, **kwargs)


def _smtp_send(s: Settings, recipients: list[str], subject: str, body: str) -> None:
    msg = EmailMessage()
    msg["From"] = s.email_sender
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.set_content(body)
    context = ssl.create_default_context()
    try:
        if s.smtp_port == 465:
            server = smtplib.SMTP_SSL(s.smtp_host, s.smtp_port, timeout=15, context=context)
        else:
            server = smtplib.SMTP(s.smtp_host, s.smtp_port, timeout=15)
        with server:
            if s.smtp_port != 465:
                server.starttls(context=context)
            server.login(s.smtp_username, s.smtp_password)
            server.send_message(msg)
    except smtplib.SMTPAuthenticationError as exc:
        raise NotificationError(
            f"SMTP login rejected ({exc.smtp_code}). For Gmail use a 16-character App Password, "
            "not your normal password, with 2-Step Verification turned on.") from exc
    except (smtplib.SMTPException, OSError) as exc:
        raise NotificationError(f"SMTP error: {exc}") from exc


async def send_email(recipients: list[str], subject: str, body: str) -> None:
    s = get_settings()
    if not s.email_configured:
        raise NotificationError("Email provider not configured")
    provider = s.email_provider.lower()
    if provider == "smtp":
        await asyncio.to_thread(_smtp_send, s, recipients, subject, body)
        return
    async with _http_client() as client:
        if provider == "resend":
            r = await client.post("https://api.resend.com/emails",
                                  headers={"Authorization": f"Bearer {s.email_api_key}"},
                                  json={"from": s.email_from, "to": recipients, "subject": subject, "text": body})
        else:
            r = await client.post("https://api.sendgrid.com/v3/mail/send",
                                  headers={"Authorization": f"Bearer {s.email_api_key}"},
                                  json={"personalizations": [{"to": [{"email": e} for e in recipients]}],
                                        "from": {"email": s.email_from}, "subject": subject,
                                        "content": [{"type": "text/plain", "value": body}]})
    if r.status_code >= 300:
        raise NotificationError(f"{provider} returned HTTP {r.status_code}: {r.text[:200]}")


async def _twilio_messages(recipients: list[str], sender: str, body: str, prefix: str = "") -> None:
    s = get_settings()
    url = f"https://api.twilio.com/2010-04-01/Accounts/{s.twilio_account_sid}/Messages.json"
    errors = []
    async with _http_client(auth=(s.twilio_account_sid, s.twilio_auth_token)) as client:
        for to in recipients:
            r = await client.post(url, data={"To": f"{prefix}{to}", "From": f"{prefix}{sender}", "Body": body[:1500]})
            if r.status_code >= 300:
                errors.append(f"{to}: HTTP {r.status_code} {r.text[:120]}")
    if errors:
        raise NotificationError("; ".join(errors))


async def send_sms(recipients: list[str], body: str) -> None:
    s = get_settings()
    if not s.sms_configured:
        raise NotificationError("SMS provider not configured")
    await _twilio_messages(recipients, s.twilio_from_number, body)


async def send_whatsapp(recipients: list[str], body: str) -> None:
    s = get_settings()
    if not s.whatsapp_configured:
        raise NotificationError("WhatsApp provider not configured")
    sender = s.twilio_whatsapp_from.removeprefix("whatsapp:")
    await _twilio_messages(recipients, sender, body, prefix="whatsapp:")


async def _send(channel: str, recipients: list[str], subject: str, body: str) -> None:
    # Looked up at call time so tests can replace send_email / send_sms / send_whatsapp.
    if channel == "email":
        await send_email(recipients, subject, body)
    elif channel == "sms":
        await send_sms(recipients, body)
    else:
        await send_whatsapp(recipients, body)


# ---- dispatch --------------------------------------------------------------------
def overall_status(channels: dict) -> str:
    statuses = [c.get("status") for c in channels.values()]
    if "failed" in statuses:
        return "failed"
    if "pending" in statuses:
        return "pending"
    if "sent" in statuses:
        return "sent"
    return "disabled"


async def _log(alert_id: Optional[str], channel: str, recipients: list, status: str,
               error: Optional[str] = None, test: bool = False, reason: Optional[str] = None) -> None:
    provider = provider_status()[channel]["provider"]
    await get_db().notification_logs.insert_one({
        "id": new_id("ntf_"), "alert_id": alert_id, "channel": channel, "provider": provider,
        "recipients": recipients, "status": status, "error": error, "reason": reason,
        "test": test, "created_at": utcnow(),
    })


async def _channel(alert: dict, channel: str, cfg: dict, subject: str, body: str, suppressed: bool) -> dict:
    configured = provider_status()[channel]["configured"]
    recipients = cfg.get(f"{channel}_recipients") or []
    if not cfg.get(f"{channel}_enabled", True):
        return {"status": "disabled", "reason": f"{channel} notifications turned off"}
    if not configured:
        return {"status": "disabled", "reason": "Integration not configured"}
    if not recipients:
        return {"status": "disabled", "reason": "No recipients configured"}
    if SEVERITY_RANK[alert["severity"]] < SEVERITY_RANK[cfg["min_severity"]]:
        return {"status": "disabled", "reason": f"Below minimum severity ({cfg['min_severity']})"}
    if suppressed:
        return {"status": "disabled", "reason": "Suppressed by notification cooldown"}
    try:
        await _send(channel, recipients, subject, body)
        await _log(alert["id"], channel, recipients, "sent")
        return {"status": "sent", "sent_at": utcnow()}
    except Exception as exc:  # noqa: BLE001 - any provider failure is a "failed" status
        msg = str(exc) or exc.__class__.__name__
        log.warning("%s notification failed for %s: %s", channel, alert["id"], msg)
        await _log(alert["id"], channel, recipients, "failed", error=msg)
        return {"status": "failed", "error": msg, "failed_at": utcnow()}


async def dispatch_alert(alert_id: str) -> dict:
    db = get_db()
    alert = await db.alert_events.find_one({"id": alert_id}, {"_id": 0})
    if not alert:
        return {}
    cfg = await get_notification_settings()
    # Notification cooldown: one message per node+parameter per window.
    since = utcnow() - timedelta(seconds=cfg.get("cooldown_seconds", 0))
    recent = await db.alert_events.find_one({
        "id": {"$ne": alert_id}, "node_id": alert["node_id"], "parameter": alert["parameter"],
        "notification_status": "sent", "created_at": {"$gte": since}})
    subject, body = format_message(alert)
    channels = {c: await _channel(alert, c, cfg, subject, body, bool(recent)) for c in CHANNELS}
    status = overall_status(channels)
    # the alert's Google Sheets row may already exist (another sync ran first), so mark it for an update
    await db.alert_events.update_one({"id": alert_id},
                                     row_changed({"notifications": channels, "notification_status": status}))
    return {"notification_status": status, "notifications": channels}


async def send_test(channel: str) -> dict:
    cfg = await get_notification_settings()
    status = provider_status()[channel]
    recipients = cfg.get(f"{channel}_recipients") or []
    name = {"email": "email", "sms": "SMS", "whatsapp": "WhatsApp message"}[channel]
    if not status["configured"]:
        await _log(None, channel, recipients, "disabled", test=True, reason="Integration not configured")
        return {"ok": False, "status": "disabled", "message": status["message"]}
    if not recipients:
        return {"ok": False, "status": "disabled", "message": f"No {channel} recipients configured"}
    sample = {
        "id": "TEST", "type": "threshold", "label": "Strain", "value": 655.2, "unit": "με",
        "threshold": 620.0, "node_id": "ESP32-TEST", "location": "Test notification - no action required",
        "severity": "major", "created_at": utcnow(),
    }
    subject, body = format_message(sample)
    try:
        await _send(channel, recipients, "[TEST] " + subject, "[TEST] " + body if channel != "email" else body)
        await _log(None, channel, recipients, "sent", test=True)
        return {"ok": True, "status": "sent", "message": f"Test {name} sent to {len(recipients)} recipient(s)"}
    except Exception as exc:  # noqa: BLE001
        await _log(None, channel, recipients, "failed", error=str(exc), test=True)
        return {"ok": False, "status": "failed", "message": str(exc)}
