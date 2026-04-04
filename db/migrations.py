from __future__ import annotations

from pathlib import Path
from threading import Lock

from alembic import command
from alembic.config import Config

from .config import BASE_DIR, ensure_data_dir, get_sync_database_url

_migration_lock = Lock()
_migrated = False


def ensure_database_ready() -> None:
    global _migrated
    if _migrated:
        return

    with _migration_lock:
        if _migrated:
            return

        ensure_data_dir()
        config = Config(str(BASE_DIR / "alembic.ini"))
        config.set_main_option("script_location", str(BASE_DIR / "migrations"))
        config.set_main_option("sqlalchemy.url", get_sync_database_url())
        command.upgrade(config, "head")
        _migrated = True

