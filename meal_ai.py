import base64
import json
import os
import re
from typing import Any

from dotenv import load_dotenv

load_dotenv()

DEFAULT_MEAL_MODEL = "openai/gpt-5.4-nano"

SYSTEM_PROMPT = """
You estimate a single logged meal for a lean calorie tracker.

Return JSON only with exactly these keys:
- name: string
- calories: integer
- protein: integer
- carbs: integer
- fat: integer
- confidence: "low" | "medium" | "high"

Rules:
- Estimate one realistic serving for what is shown or described.
- If multiple foods are present, combine them into a single meal entry.
- Keep the name as short as possible, natural, and user-friendly.
- Use whole numbers only.
- Macros must be non-negative.
- Calories should roughly match the macro estimate.
- Do not wrap the JSON in markdown.
""".strip()


class MealAnalysisError(RuntimeError):
    """Raised when the model cannot produce a usable meal estimate."""


def _extract_response_text(response: Any) -> str:
    try:
        message = response.choices[0].message
    except (AttributeError, IndexError, TypeError) as exc:
        raise MealAnalysisError("AI response did not contain a message.") from exc

    content = getattr(message, "content", None)
    if content is None and isinstance(message, dict):
        content = message.get("content")

    if isinstance(content, str):
        return content.strip()

    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
                continue

            if isinstance(item, dict):
                text = item.get("text") or item.get("content")
                if isinstance(text, str) and text.strip():
                    parts.append(text.strip())
                continue

            text = getattr(item, "text", None)
            if isinstance(text, str) and text.strip():
                parts.append(text.strip())

        joined = "\n".join(parts).strip()
        if joined:
            return joined

    raise MealAnalysisError("AI response content was empty.")


def _extract_json_payload(text: str) -> dict[str, Any]:
    stripped = text.strip()
    if stripped.startswith("```"):
        stripped = re.sub(r"^```(?:json)?\s*", "", stripped)
        stripped = re.sub(r"\s*```$", "", stripped)

    candidates = [stripped]
    match = re.search(r"\{.*\}", stripped, re.DOTALL)
    if match:
        candidates.append(match.group(0))

    for candidate in candidates:
        try:
            payload = json.loads(candidate)
        except json.JSONDecodeError:
            continue

        if isinstance(payload, dict):
            return payload

    raise MealAnalysisError("AI response was not valid JSON.")


def _normalize_int(value: Any, default: int = 0, allow_zero: bool = True) -> int:
    try:
        parsed = int(round(float(value)))
    except (TypeError, ValueError):
        return default

    if parsed < 0:
        return default

    if parsed == 0 and not allow_zero:
        return default

    return parsed


def _normalize_confidence(value: Any) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in {"low", "medium", "high"}:
            return normalized
    return "medium"


def _normalize_name(value: Any) -> str:
    if isinstance(value, str):
        trimmed = value.strip()
        if trimmed:
            return trimmed[:80]
    return "Meal"


def _macro_calories(protein: int, carbs: int, fat: int) -> int:
    return (protein * 4) + (carbs * 4) + (fat * 9)


def _normalize_meal_payload(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise MealAnalysisError("AI response was not an object.")

    protein = _normalize_int(payload.get("protein"), default=0)
    carbs = _normalize_int(payload.get("carbs"), default=0)
    fat = _normalize_int(payload.get("fat"), default=0)
    macro_calories = _macro_calories(protein, carbs, fat)

    calories = _normalize_int(payload.get("calories"), default=macro_calories, allow_zero=False)
    if calories <= 0 and macro_calories > 0:
        calories = macro_calories
    if calories <= 0:
        raise MealAnalysisError("AI response did not contain usable calories.")

    if macro_calories > 0:
        lower_bound = int(round(macro_calories * 0.65))
        upper_bound = int(round(macro_calories * 1.35))
        if calories < lower_bound or calories > upper_bound:
            calories = macro_calories

    return {
        "name": _normalize_name(payload.get("name")),
        "calories": calories,
        "protein": protein,
        "carbs": carbs,
        "fat": fat,
        "confidence": _normalize_confidence(payload.get("confidence"))
    }


def _build_user_content(
    note: str,
    image_payloads: list[dict[str, str]],
    mode: str,
) -> list[dict[str, Any]]:
    note_copy = note.strip() if isinstance(note, str) else ""
    parts: list[dict[str, Any]] = [{
        "type": "text",
        "text": (
            "Estimate this meal for a calorie tracker.\n"
            f"Logging mode: {mode or 'manual'}.\n"
            f"User description: {note_copy or 'No text supplied.'}\n"
            "Return JSON only."
        )
    }]

    for payload in image_payloads:
        encoded = payload.get("encoded")
        if not encoded:
            continue
        media_type = payload.get("content_type") or "image/jpeg"
        parts.append({
            "type": "image_url",
            "image_url": {
                "url": f"data:{media_type};base64,{encoded}",
                "detail": "low"
            }
        })

    return parts


def analyze_logged_meal(
    *,
    note: str = "",
    image_bytes: bytes | None = None,
    content_type: str | None = None,
    image_payloads: list[dict[str, str]] | None = None,
    mode: str = "manual",
) -> dict[str, Any]:
    note_copy = note.strip() if isinstance(note, str) else ""
    normalized_images = list(image_payloads or [])
    if image_bytes:
        normalized_images.append({
            "encoded": base64.b64encode(image_bytes).decode("utf-8"),
            "content_type": content_type or "image/jpeg"
        })

    if not note_copy and not normalized_images:
        raise MealAnalysisError("Add a meal description or a photo.")

    model = os.getenv("MEAL_AI_MODEL", DEFAULT_MEAL_MODEL).strip() or DEFAULT_MEAL_MODEL
    if model.startswith("openai/") and not os.getenv("OPENAI_API_KEY"):
        raise MealAnalysisError("OPENAI_API_KEY is missing.")

    try:
        from litellm import completion
    except ImportError as exc:
        raise MealAnalysisError("LiteLLM is not installed.") from exc

    response = completion(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": _build_user_content(note_copy, normalized_images, mode)
            }
        ],
        timeout=45,
    )

    raw_text = _extract_response_text(response)
    payload = _extract_json_payload(raw_text)
    return _normalize_meal_payload(payload)
