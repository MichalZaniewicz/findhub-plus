import os
import secrets
from dataclasses import dataclass
from pathlib import Path


def _int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    app_password: str
    session_secret: str
    database_url: str
    login_service_url: str
    poll_interval: int
    device_delay: int
    locate_timeout: int
    retention_days: int


def _session_secret(data_dir: Path) -> str:
    configured = os.getenv("SESSION_SECRET", "").strip()
    if configured:
        return configured
    key_file = data_dir / "session.key"
    if key_file.exists():
        return key_file.read_text().strip()
    value = secrets.token_urlsafe(48)
    key_file.write_text(value)
    key_file.chmod(0o600)
    return value


def load_settings() -> Settings:
    data_dir = Path(os.getenv("DATA_DIR", "/data"))
    data_dir.mkdir(parents=True, exist_ok=True)
    password = os.getenv("APP_PASSWORD", "")
    if not password:
        raise RuntimeError("APP_PASSWORD musi być ustawione")
    return Settings(
        data_dir=data_dir,
        app_password=password,
        session_secret=_session_secret(data_dir),
        database_url=os.getenv("DATABASE_URL", "postgresql://findhub:findhub@db:5432/findhub"),
        login_service_url=os.getenv("LOGIN_SERVICE_URL", "http://login:8001").rstrip("/"),
        poll_interval=max(60, _int("POLL_INTERVAL_SECONDS", 300)),
        device_delay=max(0, _int("DEVICE_DELAY_SECONDS", 5)),
        locate_timeout=max(10, _int("LOCATE_TIMEOUT_SECONDS", 60)),
        retention_days=max(0, _int("RETENTION_DAYS", 0)),
    )


settings = load_settings()
