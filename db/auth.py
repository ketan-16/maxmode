from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from .config import SESSION_MAX_AGE_SECONDS
from .models import Account, AccountProfile, AuthSession, MealEntry, User, WeightEntry
from .security import generate_session_token, hash_password, hash_token, verify_password

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class AuthError(Exception):
    pass


@dataclass(slots=True)
class SessionContext:
    session_id: str
    raw_token: str
    expires_at: datetime
    user_id: str
    account_id: str
    email: str


def utcnow() -> datetime:
    return datetime.now(UTC)


def ensure_utc(value: datetime | None) -> datetime | None:
    if value is None:
        return None
    if value.tzinfo is None:
        return value.replace(tzinfo=UTC)
    return value.astimezone(UTC)


def normalize_email(email: str) -> str:
    normalized = (email or "").strip().lower()
    if not normalized or not EMAIL_RE.match(normalized):
        raise AuthError("Enter a valid email address.")
    return normalized


def validate_password(password: str) -> str:
    if not isinstance(password, str) or len(password) < 8:
        raise AuthError("Password must be at least 8 characters.")
    return password


def build_session_expiry() -> datetime:
    return utcnow() + timedelta(seconds=SESSION_MAX_AGE_SECONDS)


async def reserve_account_version(db: AsyncSession, account_id: str) -> int:
    account = await db.get(Account, account_id)
    if account is None:
        raise AuthError("Account not found.")
    account.sync_version += 1
    account.updated_at = utcnow()
    await db.flush()
    return account.sync_version


async def create_account_with_user(db: AsyncSession, email: str, password: str) -> SessionContext:
    normalized_email = normalize_email(email)
    validate_password(password)

    existing = await db.scalar(select(User.id).where(User.email_normalized == normalized_email))
    if existing:
        raise AuthError("An account with that email already exists.")

    now = utcnow()
    account = Account(id=str(uuid.uuid4()), created_at=now, updated_at=now, sync_version=0)
    user = User(
        id=str(uuid.uuid4()),
        account_id=account.id,
        email=normalized_email,
        email_normalized=normalized_email,
        password_hash=hash_password(password),
        created_at=now,
        updated_at=now,
        last_login_at=now,
    )
    db.add(account)
    db.add(user)
    await db.flush()
    return await create_session_for_user(db, user)


async def authenticate_user(db: AsyncSession, email: str, password: str) -> SessionContext:
    normalized_email = normalize_email(email)
    validate_password(password)

    user = await db.scalar(select(User).where(User.email_normalized == normalized_email))
    if user is None or not verify_password(user.password_hash, password):
        raise AuthError("Invalid email or password.")

    now = utcnow()
    user.last_login_at = now
    user.updated_at = now
    await db.flush()
    return await create_session_for_user(db, user)


async def create_session_for_user(db: AsyncSession, user: User) -> SessionContext:
    raw_token = generate_session_token()
    expires_at = build_session_expiry()
    session_row = AuthSession(
        id=str(uuid.uuid4()),
        user_id=user.id,
        token_hash=hash_token(raw_token),
        expires_at=expires_at,
        last_seen_at=utcnow(),
    )
    db.add(session_row)
    await db.flush()
    return SessionContext(
        session_id=session_row.id,
        raw_token=raw_token,
        expires_at=expires_at,
        user_id=user.id,
        account_id=user.account_id,
        email=user.email,
    )


async def get_session_context(db: AsyncSession, raw_token: str | None) -> SessionContext | None:
    if not raw_token:
        return None

    token_digest = hash_token(raw_token)
    session_row = await db.scalar(
        select(AuthSession).join(User).where(AuthSession.token_hash == token_digest)
    )
    if session_row is None:
        return None

    now = utcnow()
    expires_at = ensure_utc(session_row.expires_at)
    if expires_at is None:
        await db.delete(session_row)
        await db.commit()
        return None
    if expires_at <= now:
        await db.delete(session_row)
        await db.commit()
        return None

    user = await db.get(User, session_row.user_id)
    if user is None:
        await db.delete(session_row)
        await db.commit()
        return None

    session_row.last_seen_at = now
    session_row.expires_at = build_session_expiry()
    await db.flush()

    return SessionContext(
        session_id=session_row.id,
        raw_token=raw_token,
        expires_at=ensure_utc(session_row.expires_at) or build_session_expiry(),
        user_id=user.id,
        account_id=user.account_id,
        email=user.email,
    )


async def revoke_session(db: AsyncSession, raw_token: str | None) -> None:
    if not raw_token:
        return

    token_digest = hash_token(raw_token)
    await db.execute(delete(AuthSession).where(AuthSession.token_hash == token_digest))


def is_profile_meaningful(profile: AccountProfile | None) -> bool:
    if profile is None:
        return False
    return any((
        bool((profile.display_name or "").strip()),
        profile.age is not None,
        bool(profile.gender),
        bool(profile.activity_level),
        profile.height_cm is not None,
        profile.weight_unit != "kg",
        profile.height_unit != "cm",
        abs(profile.protein_multiplier_g_per_kg - 1.0) > 1e-9,
        profile.ai_calculation_mode != "balanced",
        bool(profile.calorie_goal_objective),
        bool(profile.calorie_goal_preset_key),
        profile.reminder_opt_in,
        bool(profile.last_reminder_day),
    ))


async def account_has_server_data(db: AsyncSession, account_id: str) -> bool:
    profile = await db.get(AccountProfile, account_id)
    if is_profile_meaningful(profile):
        return True

    weight_count = await db.scalar(
        select(func.count()).select_from(WeightEntry).where(
            WeightEntry.account_id == account_id,
            WeightEntry.deleted_at.is_(None),
        )
    )
    if weight_count:
        return True

    meal_count = await db.scalar(
        select(func.count()).select_from(MealEntry).where(
            MealEntry.account_id == account_id,
            MealEntry.deleted_at.is_(None),
        )
    )
    return bool(meal_count)
