"""Request/response validation models."""
from __future__ import annotations

import math
from datetime import datetime, timedelta, timezone
from typing import Literal, Optional, Union

from pydantic import BaseModel, EmailStr, Field, field_validator

from .services.floors import normalise_floor
from .services.thresholds import PARAMETERS

# Physically plausible bounds - anything outside is rejected as a sensor/payload fault.
VALUE_BOUNDS = {
    "strain": (-5000.0, 5000.0),
    "vibration": (0.0, 50.0),
    "temperature": (-60.0, 150.0),
}

NODE_ID_PATTERN = r"^[A-Za-z0-9_\-]{1,32}$"


class IngestPayload(BaseModel):
    node_id: str = Field(pattern=NODE_ID_PATTERN)
    location: Optional[str] = Field(default=None, max_length=120)
    timestamp: Optional[datetime] = None
    readings: dict[str, float]
    battery: Optional[float] = Field(default=None, ge=0, le=100)
    rssi: Optional[int] = Field(default=None, ge=-120, le=0)
    firmware: Optional[str] = Field(default=None, max_length=32)
    error: Optional[str] = Field(default=None, max_length=200)
    # optional: 0 = ground, 2 = second floor, -1 = basement, "roof"; otherwise read from `location`
    floor: Optional[Union[int, str]] = None

    @field_validator("node_id")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()

    @field_validator("floor", mode="before")
    @classmethod
    def _floor(cls, v):
        return normalise_floor(v)  # anything unreadable becomes None rather than rejecting the reading

    @field_validator("timestamp")
    @classmethod
    def _ts(cls, v: Optional[datetime]) -> Optional[datetime]:
        if v is None:
            return v
        if v.tzinfo is None:
            v = v.replace(tzinfo=timezone.utc)
        v = v.astimezone(timezone.utc)
        if v > datetime.now(timezone.utc) + timedelta(minutes=5):
            raise ValueError("timestamp is in the future")
        return v

    @field_validator("readings")
    @classmethod
    def _readings(cls, v: dict[str, float]) -> dict[str, float]:
        if not v:
            raise ValueError("readings must contain at least one parameter")
        out = {}
        for key, val in v.items():
            k = key.lower().strip()
            if k not in PARAMETERS:
                raise ValueError(f"unknown parameter '{key}' (expected one of {', '.join(PARAMETERS)})")
            if val is None or not math.isfinite(val):
                raise ValueError(f"{k} must be a finite number")
            lo, hi = VALUE_BOUNDS[k]
            if not lo <= val <= hi:
                raise ValueError(f"{k}={val} is outside the plausible range [{lo}, {hi}]")
            out[k] = float(val)
        return out


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=256)


class SignupRequest(BaseModel):
    """Self-service sign-up. There is deliberately no role field: sign-ups are always viewers."""
    email: EmailStr
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=128)


class AlertPrefs(BaseModel):
    """A user's own alerts for their own nodes."""
    email_enabled: Optional[bool] = None
    telegram_enabled: Optional[bool] = None


class BuildingName(BaseModel):
    building_name: str = Field(min_length=1, max_length=80)


class BuildingPhoto(BaseModel):
    """A photo of the account's building as a data URL (the web app shrinks it to 1280 px first)."""
    image: str = Field(min_length=1, max_length=1_500_000)


class ProfileUpdate(BaseModel):
    """Changes a signed-in user may make to their own account."""
    name: str = Field(min_length=1, max_length=80)


class PasswordChange(BaseModel):
    current_password: str = Field(min_length=1, max_length=256)
    new_password: str = Field(min_length=10, max_length=128)


class AvatarUpdate(BaseModel):
    """Either one of the four built-in avatars, or an uploaded picture as a data URL."""
    preset: Optional[int] = Field(default=None, ge=1, le=4)
    image: Optional[str] = Field(default=None, max_length=600_000)


class UserCreate(BaseModel):
    email: EmailStr
    name: str = Field(min_length=1, max_length=80)
    password: str = Field(min_length=10, max_length=128)
    role: Literal["admin", "viewer"] = "viewer"


class UserUpdate(BaseModel):
    name: Optional[str] = Field(default=None, min_length=1, max_length=80)
    password: Optional[str] = Field(default=None, min_length=10, max_length=128)
    role: Optional[Literal["admin", "viewer"]] = None
    active: Optional[bool] = None


class ThresholdUpdate(BaseModel):
    parameter: Literal["strain", "vibration", "temperature"]
    safe_threshold: Optional[float] = None
    warning_threshold: Optional[float] = None
    critical_threshold: Optional[float] = None
    debounce_seconds: Optional[int] = Field(default=None, ge=0, le=3600)
    cooldown_seconds: Optional[int] = Field(default=None, ge=0, le=86400)
    enabled: Optional[bool] = None


class ThresholdsPut(BaseModel):
    thresholds: list[ThresholdUpdate] = Field(min_length=1, max_length=5)


class AckRequest(BaseModel):
    note: Optional[str] = Field(default=None, max_length=300)


class NotificationSettings(BaseModel):
    browser_enabled: Optional[bool] = None
    email_enabled: Optional[bool] = None
    sms_enabled: Optional[bool] = None
    whatsapp_enabled: Optional[bool] = None
    telegram_enabled: Optional[bool] = None
    email_recipients: Optional[list[EmailStr]] = Field(default=None, max_length=20)
    sms_recipients: Optional[list[str]] = Field(default=None, max_length=20)
    whatsapp_recipients: Optional[list[str]] = Field(default=None, max_length=20)
    telegram_recipients: Optional[list[str]] = Field(default=None, max_length=20)
    min_severity: Optional[Literal["early_warning", "major", "critical"]] = None
    cooldown_seconds: Optional[int] = Field(default=None, ge=0, le=86400)

    @field_validator("sms_recipients", "whatsapp_recipients")
    @classmethod
    def _phones(cls, v):
        if v is None:
            return v
        import re
        out = []
        for p in v:
            p = re.sub(r"[\s\-()]", "", p)
            if not re.fullmatch(r"\+[1-9]\d{6,14}", p):
                raise ValueError(f"'{p}' is not an E.164 phone number (e.g. +15551234567)")
            out.append(p)
        return out


    @field_validator("telegram_recipients")
    @classmethod
    def _chats(cls, v):
        if v is None:
            return v
        import re
        out = []
        for c in v:
            c = str(c).strip()
            if not re.fullmatch(r"-?\d{3,20}|@[A-Za-z][A-Za-z0-9_]{4,31}", c):
                raise ValueError(f"'{c}' is not a Telegram chat ID (a number such as 123456789, or @channelname)")
            out.append(c)
        return out


class NotificationTest(BaseModel):
    channel: Literal["email", "sms", "whatsapp", "telegram"]


class SheetsSettings(BaseModel):
    spreadsheet: Optional[str] = Field(default=None, max_length=300)
    auto_sync: Optional[bool] = None


class SimulatorToggle(BaseModel):
    enabled: bool


class CsvExportRequest(BaseModel):
    dataset: Literal["alerts", "telemetry"] = "alerts"
    parameter: Optional[str] = None
    node_id: Optional[str] = None
    severity: Optional[str] = None
    status: Optional[str] = None
    q: Optional[str] = Field(default=None, max_length=100)
    date_from: Optional[datetime] = None
    date_to: Optional[datetime] = None
    sort: Literal["newest", "oldest"] = "newest"
    limit: int = Field(default=10000, ge=1, le=50000)


class MqttTest(BaseModel):
    topic: Optional[str] = Field(default=None, max_length=120)
    payload: Optional[dict] = None


# ---- sensor nodes registered by an administrator ------------------------------------------------
class _NodeFields(BaseModel):
    location: Optional[str] = Field(default=None, max_length=120)
    # null = read the floor from the location text; 0 = ground, -1 = basement, "roof"
    floor: Optional[Union[int, str]] = None
    plan_x: Optional[float] = Field(default=None, ge=0, le=100)  # spot on the floor plan, % from the left
    plan_y: Optional[float] = Field(default=None, ge=0, le=100)  # % from the top
    owner_id: Optional[str] = Field(default=None, max_length=64)  # null / "" = the site's own device

    @field_validator("floor", mode="before")
    @classmethod
    def _floor(cls, v):
        return normalise_floor(v)


class NodeCreate(_NodeFields):
    node_id: str = Field(pattern=NODE_ID_PATTERN)

    @field_validator("node_id")
    @classmethod
    def _upper(cls, v: str) -> str:
        return v.upper()


class NodeUpdate(_NodeFields):
    pass
