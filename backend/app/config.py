"""Runtime configuration. Every secret comes from the environment (or a local .env
file that is never committed). Nothing sensitive has a default value."""
from __future__ import annotations

from functools import lru_cache
from typing import Optional

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class ConfigError(RuntimeError):
    """Raised when required configuration is missing or invalid."""


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Core
    mongo_url: str = Field(default="", alias="MONGO_URL")
    db_name: str = Field(default="shm_command_center", alias="DB_NAME")
    jwt_secret: str = Field(default="", alias="JWT_SECRET")
    jwt_expire_minutes: int = Field(default=480, alias="JWT_EXPIRE_MINUTES")
    frontend_url: str = Field(default="http://localhost:5173", alias="FRONTEND_URL")
    cookie_secure: bool = Field(default=True, alias="COOKIE_SECURE")
    cookie_samesite: str = Field(default="lax", alias="COOKIE_SAMESITE")
    structure_name: str = Field(default="My building", alias="STRUCTURE_NAME")  # shown in the header

    # Bootstrap accounts (only used to seed an empty users collection)
    admin_email: Optional[str] = Field(default=None, alias="ADMIN_EMAIL")
    admin_password: Optional[str] = Field(default=None, alias="ADMIN_PASSWORD")
    admin_name: str = Field(default="System Administrator", alias="ADMIN_NAME")
    # true: on start, make ADMIN_EMAIL an admin with exactly ADMIN_PASSWORD (to recover or change the admin login)
    admin_reset: bool = Field(default=False, alias="ADMIN_RESET")
    seed_viewer_email: Optional[str] = Field(default=None, alias="SEED_VIEWER_EMAIL")
    seed_viewer_password: Optional[str] = Field(default=None, alias="SEED_VIEWER_PASSWORD")

    # Self-service sign-up on the login page (creates viewer accounts only)
    allow_signup: bool = Field(default=True, alias="ALLOW_SIGNUP")
    signup_email_domain: str = Field(default="gmail.com", alias="SIGNUP_EMAIL_DOMAIN")  # e.g. name@gmail.com

    # Login protection
    login_max_attempts: int = Field(default=5, alias="LOGIN_MAX_ATTEMPTS")
    login_window_minutes: int = Field(default=15, alias="LOGIN_WINDOW_MINUTES")
    login_lockout_minutes: int = Field(default=15, alias="LOGIN_LOCKOUT_MINUTES")

    # Telemetry
    simulator_enabled: bool = Field(default=True, alias="SIMULATOR_ENABLED")
    simulator_interval_seconds: float = Field(default=5.0, alias="SIMULATOR_INTERVAL_SECONDS")
    node_offline_seconds: int = Field(default=30, alias="NODE_OFFLINE_SECONDS")
    reading_retention_days: int = Field(default=30, alias="READING_RETENTION_DAYS")

    # Device authentication for ESP32 ingestion
    device_shared_key: Optional[str] = Field(default=None, alias="DEVICE_SHARED_KEY")
    device_keys: Optional[str] = Field(default=None, alias="DEVICE_KEYS")  # "ESP32-01:key,ESP32-02:key"

    # Email
    email_provider: Optional[str] = Field(default=None, alias="EMAIL_PROVIDER")  # smtp | resend | sendgrid
    email_api_key: Optional[str] = Field(default=None, alias="EMAIL_API_KEY")
    email_from: Optional[str] = Field(default=None, alias="EMAIL_FROM")
    # SMTP (EMAIL_PROVIDER=smtp) - defaults suit Gmail with an App Password
    smtp_host: str = Field(default="smtp.gmail.com", alias="SMTP_HOST")
    smtp_port: int = Field(default=587, alias="SMTP_PORT")
    smtp_username: Optional[str] = Field(default=None, alias="SMTP_USERNAME")
    smtp_password: Optional[str] = Field(default=None, alias="SMTP_PASSWORD")

    # SMS
    sms_provider: Optional[str] = Field(default=None, alias="SMS_PROVIDER")  # twilio
    twilio_account_sid: Optional[str] = Field(default=None, alias="TWILIO_ACCOUNT_SID")
    twilio_auth_token: Optional[str] = Field(default=None, alias="TWILIO_AUTH_TOKEN")
    twilio_from_number: Optional[str] = Field(default=None, alias="TWILIO_FROM_NUMBER")
    # WhatsApp via the same Twilio account (sandbox number +14155238886 or an approved sender)
    twilio_whatsapp_from: Optional[str] = Field(default=None, alias="TWILIO_WHATSAPP_FROM")
    telegram_bot_token: Optional[str] = Field(default=None, alias="TELEGRAM_BOT_TOKEN")  # from @BotFather

    # Google Sheets
    google_service_account_json: Optional[str] = Field(default=None, alias="GOOGLE_SERVICE_ACCOUNT_JSON")
    google_service_account_file: Optional[str] = Field(default=None, alias="GOOGLE_SERVICE_ACCOUNT_FILE")
    google_sheets_spreadsheet_id: Optional[str] = Field(default=None, alias="GOOGLE_SHEETS_SPREADSHEET_ID")
    google_sheets_worksheet: str = Field(default="SHM Alerts", alias="GOOGLE_SHEETS_WORKSHEET")
    # No-key alternative: a Google Apps Script web app bound to the spreadsheet
    # (see backend/app/static/sheets_apps_script.gs)
    google_sheets_webhook_url: Optional[str] = Field(default=None, alias="GOOGLE_SHEETS_WEBHOOK_URL")
    google_sheets_webhook_secret: Optional[str] = Field(default=None, alias="GOOGLE_SHEETS_WEBHOOK_SECRET")

    # MQTT
    mqtt_broker_url: Optional[str] = Field(default=None, alias="MQTT_BROKER_URL")
    mqtt_port: int = Field(default=1883, alias="MQTT_PORT")
    mqtt_username: Optional[str] = Field(default=None, alias="MQTT_USERNAME")
    mqtt_password: Optional[str] = Field(default=None, alias="MQTT_PASSWORD")
    mqtt_topic: str = Field(default="shm/+/telemetry", alias="MQTT_TOPIC")
    mqtt_tls: bool = Field(default=False, alias="MQTT_TLS")

    @field_validator("cookie_samesite")
    @classmethod
    def _samesite(cls, v: str) -> str:
        v = v.lower()
        if v not in {"lax", "strict", "none"}:
            raise ValueError("COOKIE_SAMESITE must be lax, strict or none")
        return v

    # ---- derived helpers -------------------------------------------------
    @property
    def cors_origins(self) -> list[str]:
        return [o.strip().rstrip("/") for o in self.frontend_url.split(",") if o.strip()]

    @property
    def device_key_map(self) -> dict[str, str]:
        out: dict[str, str] = {}
        for pair in (self.device_keys or "").split(","):
            if ":" in pair:
                node, key = pair.split(":", 1)
                if node.strip() and key.strip():
                    out[node.strip().upper()] = key.strip()
        return out

    @property
    def device_auth_configured(self) -> bool:
        return bool(self.device_shared_key) or bool(self.device_key_map)

    @property
    def email_configured(self) -> bool:
        provider = (self.email_provider or "").lower()
        if provider == "smtp":
            return bool(self.smtp_host and self.smtp_username and self.smtp_password)
        return bool(self.email_api_key and self.email_from) and provider in {"resend", "sendgrid"}

    @property
    def email_sender(self) -> Optional[str]:
        return self.email_from or (self.smtp_username if (self.email_provider or "").lower() == "smtp" else None)

    @property
    def whatsapp_configured(self) -> bool:
        return bool(self.twilio_account_sid and self.twilio_auth_token and self.twilio_whatsapp_from)

    @property
    def telegram_configured(self) -> bool:
        return bool(self.telegram_bot_token)

    @property
    def sms_configured(self) -> bool:
        return (self.sms_provider or "").lower() == "twilio" and bool(
            self.twilio_account_sid and self.twilio_auth_token and self.twilio_from_number)

    @property
    def google_configured(self) -> bool:
        return self.sheets_mode is not None

    @property
    def sheets_mode(self) -> Optional[str]:
        """'apps_script' (web app + shared secret, no key), 'service_account', or None."""
        if self.google_sheets_webhook_url and self.google_sheets_webhook_secret:
            return "apps_script"
        if self.google_service_account_json or self.google_service_account_file:
            return "service_account"
        return None

    @property
    def mqtt_configured(self) -> bool:
        return bool(self.mqtt_broker_url)

    def validate_core(self) -> None:
        problems = []
        if not self.mongo_url:
            problems.append("MONGO_URL is not set")
        if not self.jwt_secret or len(self.jwt_secret) < 32:
            problems.append("JWT_SECRET must be set and at least 32 characters long")
        if problems:
            raise ConfigError("Configuration error: " + "; ".join(problems) +
                              ". Copy backend/.env.example to backend/.env and fill it in.")


_active: Optional[Settings] = None


def set_settings(settings: Settings) -> None:
    """Make `settings` the process-wide configuration (called by create_app)."""
    global _active
    _active = settings


@lru_cache
def _load() -> Settings:
    return Settings()


def get_settings() -> Settings:
    return _active or _load()
