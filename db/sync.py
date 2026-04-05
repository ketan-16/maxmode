from __future__ import annotations

from datetime import UTC, datetime

from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import AuthError, ensure_utc, is_profile_meaningful, reserve_account_version, utcnow
from .models import Account, AccountProfile, AppliedMutation, MealEntry, WeightEntry

VALID_MUTATION_TYPES = {
    "profile.upsert",
    "weight.upsert",
    "weight.delete",
    "meal.upsert",
    "meal.delete",
    "account.reset",
}


class SyncMutation(BaseModel):
    mutationId: str = Field(min_length=1)
    type: str = Field(min_length=1)
    entityId: str | None = None
    payload: dict = Field(default_factory=dict)


class SyncRequest(BaseModel):
    deviceId: str = Field(min_length=1)
    lastPulledVersion: int = 0
    mutations: list[SyncMutation] = Field(default_factory=list)


class SyncResponse(BaseModel):
    serverVersion: int
    appliedMutationIds: list[str]
    profileChanged: bool
    profile: dict | None
    weights: list[dict]
    meals: list[dict]


def _parse_iso_datetime(value: str | None, fallback: datetime | None = None) -> datetime:
    if isinstance(value, str) and value:
        normalized = value.replace("Z", "+00:00")
        try:
            parsed = datetime.fromisoformat(normalized)
        except ValueError:
            parsed = None
        if parsed is not None:
            if parsed.tzinfo is None:
                return parsed.replace(tzinfo=UTC)
            return parsed
    return fallback or utcnow()


def _serialize_dt(value: datetime | None) -> str | None:
    if value is None:
        return None
    normalized = ensure_utc(value)
    if normalized is None:
        return None
    return normalized.astimezone(UTC).isoformat().replace("+00:00", "Z")


def serialize_profile(profile: AccountProfile | None) -> dict | None:
    if not is_profile_meaningful(profile):
        return None

    height_cm = round(profile.height_cm, 2) if profile and profile.height_cm is not None else None
    return {
        "user": {
            "name": profile.display_name,
            "createdAt": _serialize_dt(profile.created_at),
            "calorieProfile": {
                "age": profile.age,
                "gender": profile.gender,
                "activityLevel": profile.activity_level,
                "height": {
                    "unit": profile.height_unit or "cm",
                    "cm": height_cm,
                    "ft": None,
                    "in": None,
                    "heightCm": height_cm,
                },
            },
            "calorieGoal": {
                "objective": profile.calorie_goal_objective,
                "presetKey": profile.calorie_goal_preset_key,
            },
            "preferences": {
                "heightUnit": profile.height_unit or "cm",
                "weightUnit": profile.weight_unit or "kg",
                "proteinMultiplierGPerKg": profile.protein_multiplier_g_per_kg,
                "aiCalculationMode": profile.ai_calculation_mode or "balanced",
            },
        },
        "calorieTrackerMeta": {
            "reminderOptIn": bool(profile.reminder_opt_in),
            "lastReminderDay": profile.last_reminder_day or "",
        },
    }


def serialize_weight(entry: WeightEntry) -> dict:
    payload = {
        "id": entry.id,
        "weight": round(entry.weight_kg, 2),
        "unit": "kg",
        "timestamp": _serialize_dt(entry.logged_at),
    }
    if entry.deleted_at is not None:
        payload["deletedAt"] = _serialize_dt(entry.deleted_at)
    return payload


def serialize_meal(entry: MealEntry) -> dict:
    payload = {
        "id": entry.id,
        "name": entry.name,
        "source": entry.source,
        "confidence": entry.confidence,
        "portion": round(entry.portion, 2),
        "baseCalories": entry.base_calories,
        "baseProtein": entry.base_protein,
        "baseCarbs": entry.base_carbs,
        "baseFat": entry.base_fat,
        "calories": max(0, round(entry.base_calories * entry.portion)),
        "protein": max(0, round(entry.base_protein * entry.portion)),
        "carbs": max(0, round(entry.base_carbs * entry.portion)),
        "fat": max(0, round(entry.base_fat * entry.portion)),
        "loggedAt": _serialize_dt(entry.logged_at),
    }
    if entry.deleted_at is not None:
        payload["deletedAt"] = _serialize_dt(entry.deleted_at)
    return payload


async def _upsert_profile(db: AsyncSession, account_id: str, payload: dict, version: int) -> None:
    user = payload.get("user") if isinstance(payload.get("user"), dict) else {}
    profile_payload = user.get("calorieProfile") if isinstance(user.get("calorieProfile"), dict) else {}
    height = profile_payload.get("height") if isinstance(profile_payload.get("height"), dict) else {}
    preferences = user.get("preferences") if isinstance(user.get("preferences"), dict) else {}
    goal = user.get("calorieGoal") if isinstance(user.get("calorieGoal"), dict) else {}
    tracker_meta = payload.get("calorieTrackerMeta") if isinstance(payload.get("calorieTrackerMeta"), dict) else {}

    profile = await db.get(AccountProfile, account_id)
    if profile is None:
        profile = AccountProfile(account_id=account_id, created_at=utcnow(), updated_at=utcnow())
        db.add(profile)

    profile.display_name = (user.get("name") or "").strip() or None
    profile.age = profile_payload.get("age")
    profile.gender = profile_payload.get("gender") or None
    profile.activity_level = profile_payload.get("activityLevel") or None
    profile.height_cm = height.get("heightCm") if height.get("heightCm") is not None else height.get("cm")
    profile.height_unit = "ft-in" if preferences.get("heightUnit") == "ft-in" else "cm"
    profile.weight_unit = "lb" if preferences.get("weightUnit") == "lb" else "kg"
    profile.protein_multiplier_g_per_kg = float(preferences.get("proteinMultiplierGPerKg") or 1.0)
    profile.ai_calculation_mode = "aggressive" if preferences.get("aiCalculationMode") == "aggressive" else "balanced"
    profile.calorie_goal_objective = goal.get("objective") or None
    profile.calorie_goal_preset_key = goal.get("presetKey") or None
    profile.reminder_opt_in = tracker_meta.get("reminderOptIn") is True
    profile.last_reminder_day = tracker_meta.get("lastReminderDay") or ""
    profile.updated_at = utcnow()
    profile.version = version


async def _upsert_weight(db: AsyncSession, account_id: str, entity_id: str, payload: dict, version: int) -> None:
    entry = await db.get(WeightEntry, entity_id)
    if entry is None:
        entry = WeightEntry(
            id=entity_id,
            account_id=account_id,
            weight_kg=0,
            logged_at=utcnow(),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.add(entry)

    entry.weight_kg = float(payload.get("weight") or 0)
    entry.logged_at = _parse_iso_datetime(payload.get("timestamp") or payload.get("loggedAt"))
    entry.updated_at = utcnow()
    entry.deleted_at = None
    entry.version = version


async def _delete_weight(db: AsyncSession, entity_id: str, payload: dict, version: int) -> None:
    entry = await db.get(WeightEntry, entity_id)
    if entry is None:
        return
    entry.deleted_at = _parse_iso_datetime(payload.get("deletedAt"))
    entry.updated_at = utcnow()
    entry.version = version


async def _upsert_meal(db: AsyncSession, account_id: str, entity_id: str, payload: dict, version: int) -> None:
    entry = await db.get(MealEntry, entity_id)
    if entry is None:
        entry = MealEntry(
            id=entity_id,
            account_id=account_id,
            name="Meal",
            source="manual",
            confidence="medium",
            portion=1,
            base_calories=0,
            base_protein=0,
            base_carbs=0,
            base_fat=0,
            logged_at=utcnow(),
            created_at=utcnow(),
            updated_at=utcnow(),
        )
        db.add(entry)

    entry.name = (payload.get("name") or "Meal").strip() or "Meal"
    entry.source = payload.get("source") or "manual"
    entry.confidence = payload.get("confidence") or "medium"
    entry.portion = float(payload.get("portion") or 1)
    entry.base_calories = int(payload.get("baseCalories") or 0)
    entry.base_protein = int(payload.get("baseProtein") or 0)
    entry.base_carbs = int(payload.get("baseCarbs") or 0)
    entry.base_fat = int(payload.get("baseFat") or 0)
    entry.logged_at = _parse_iso_datetime(payload.get("loggedAt") or payload.get("timestamp"))
    entry.updated_at = utcnow()
    entry.deleted_at = None
    entry.version = version


async def _delete_meal(db: AsyncSession, entity_id: str, payload: dict, version: int) -> None:
    entry = await db.get(MealEntry, entity_id)
    if entry is None:
        return
    entry.deleted_at = _parse_iso_datetime(payload.get("deletedAt"))
    entry.updated_at = utcnow()
    entry.version = version


async def _reset_account(db: AsyncSession, account_id: str, version: int) -> None:
    now = utcnow()

    profile = await db.get(AccountProfile, account_id)
    if profile is None:
        profile = AccountProfile(account_id=account_id, created_at=utcnow(), updated_at=now)
        db.add(profile)

    profile.display_name = None
    profile.age = None
    profile.gender = None
    profile.activity_level = None
    profile.height_cm = None
    profile.height_unit = "cm"
    profile.weight_unit = "kg"
    profile.protein_multiplier_g_per_kg = 1.0
    profile.ai_calculation_mode = "balanced"
    profile.calorie_goal_objective = None
    profile.calorie_goal_preset_key = None
    profile.reminder_opt_in = False
    profile.last_reminder_day = ""
    profile.updated_at = now
    profile.version = version

    weight_rows = await db.scalars(select(WeightEntry).where(WeightEntry.account_id == account_id))
    for row in weight_rows:
        row.deleted_at = now
        row.updated_at = now
        row.version = version

    meal_rows = await db.scalars(select(MealEntry).where(MealEntry.account_id == account_id))
    for row in meal_rows:
        row.deleted_at = now
        row.updated_at = now
        row.version = version


async def apply_sync_request(db: AsyncSession, account_id: str, request: SyncRequest) -> SyncResponse:
    applied_ids: list[str] = []

    for mutation in request.mutations:
        mutation_type = mutation.type.strip()
        if mutation_type not in VALID_MUTATION_TYPES:
            raise AuthError("Unsupported mutation type.")

        existing = await db.get(AppliedMutation, mutation.mutationId)
        if existing is not None:
            applied_ids.append(mutation.mutationId)
            continue

        version = await reserve_account_version(db, account_id)
        entity_id = mutation.entityId or mutation.payload.get("id") or ""

        if mutation_type == "profile.upsert":
            await _upsert_profile(db, account_id, mutation.payload, version)
        elif mutation_type == "weight.upsert" and entity_id:
            await _upsert_weight(db, account_id, entity_id, mutation.payload, version)
        elif mutation_type == "weight.delete" and entity_id:
            await _delete_weight(db, entity_id, mutation.payload, version)
        elif mutation_type == "meal.upsert" and entity_id:
            await _upsert_meal(db, account_id, entity_id, mutation.payload, version)
        elif mutation_type == "meal.delete" and entity_id:
            await _delete_meal(db, entity_id, mutation.payload, version)
        elif mutation_type == "account.reset":
            await _reset_account(db, account_id, version)

        db.add(
            AppliedMutation(
                mutation_id=mutation.mutationId,
                account_id=account_id,
                device_id=request.deviceId,
                entity_type=mutation_type,
                entity_id=entity_id or None,
            )
        )
        applied_ids.append(mutation.mutationId)

    # Flush pending ORM writes before re-reading rows for the response payload.
    await db.flush()

    account = await db.get(Account, account_id)
    if account is None:
        raise AuthError("Account not found.")

    profile = await db.get(AccountProfile, account_id)
    profile_changed = bool(profile and profile.version > request.lastPulledVersion)
    weight_rows = await db.scalars(
        select(WeightEntry)
        .where(
            WeightEntry.account_id == account_id,
            WeightEntry.version > request.lastPulledVersion,
        )
        .order_by(WeightEntry.logged_at.desc(), WeightEntry.id.desc())
    )
    meal_rows = await db.scalars(
        select(MealEntry)
        .where(
            MealEntry.account_id == account_id,
            MealEntry.version > request.lastPulledVersion,
        )
        .order_by(MealEntry.logged_at.desc(), MealEntry.id.desc())
    )

    return SyncResponse(
        serverVersion=account.sync_version,
        appliedMutationIds=applied_ids,
        profileChanged=profile_changed,
        profile=serialize_profile(profile) if profile_changed else None,
        weights=[serialize_weight(row) for row in weight_rows],
        meals=[serialize_meal(row) for row in meal_rows],
    )
