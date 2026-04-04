from __future__ import annotations

import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BASE_DIR / ".data"
DEFAULT_DATABASE_PATH = DATA_DIR / "maxmode.sqlite3"
DEFAULT_DATABASE_URL = f"sqlite+aiosqlite:///{DEFAULT_DATABASE_PATH.as_posix()}"
DATABASE_URL = os.getenv("DATABASE_URL", DEFAULT_DATABASE_URL)

SESSION_COOKIE_NAME = "maxmode_session"
SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30


def get_database_url() -> str:
    return os.getenv("DATABASE_URL", DATABASE_URL)


def get_sync_database_url() -> str:
    database_url = get_database_url()
    if database_url.startswith("sqlite+aiosqlite:///"):
        return database_url.replace("sqlite+aiosqlite:///", "sqlite:///", 1)
    if database_url.startswith("sqlite+aiosqlite://"):
        return database_url.replace("sqlite+aiosqlite://", "sqlite://", 1)
    return database_url


def ensure_data_dir() -> None:
    if get_database_url().startswith("sqlite"):
        DATA_DIR.mkdir(parents=True, exist_ok=True)


def is_secure_cookie_env() -> bool:
    env = os.getenv("MAXMODE_ENV", "").strip().lower()
    return env == "production"

