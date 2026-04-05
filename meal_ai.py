import base64
import contextlib
import io
import json
import logging
import os
import re
from typing import Any, Literal

from dotenv import load_dotenv
from pydantic import BaseModel

load_dotenv()

DEFAULT_MEAL_MODEL = "openai/gpt-5.4-nano"
MEAL_AI_TEMPERATURE = 0.2
VALID_GOAL_OBJECTIVES = {"lose", "maintain", "gain"}
VALID_AI_CALCULATION_MODES = {"balanced", "aggressive"}
OPENAI_WEB_SEARCH_TOOL = {
    "type": "web_search",
    "search_context_size": "low",
}
MAX_MEAL_SOURCE_COUNT = 5
LITELLM_LOGGER_NAMES = ("LiteLLM", "LiteLLM Router", "LiteLLM Proxy")
APPROXIMATE_GRAM_PREFIX_PATTERN = r"(?:~|about|around|approx(?:\.|imately)?)\s*"
PROTEIN_GRAM_VALUE_PATTERN = (
    rf"(?:{APPROXIMATE_GRAM_PREFIX_PATTERN})?"
    r"\d+(?:\.\d+)?"
    r"(?:\s*(?:-|to)\s*"
    rf"(?:{APPROXIMATE_GRAM_PREFIX_PATTERN})?"
    r"\d+(?:\.\d+)?)?"
    r"\s*(?:g|gr|gram|grams)\b"
)
EXPLICIT_PROTEIN_GRAMS_PATTERNS = (
    re.compile(
        rf"(?:^|[^\w]){PROTEIN_GRAM_VALUE_PATTERN}\s*(?:of\s+)?protein\b",
        re.IGNORECASE,
    ),
    re.compile(
        rf"\bprotein\b(?:\s*[:\-]?\s*|\s*\(\s*){PROTEIN_GRAM_VALUE_PATTERN}",
        re.IGNORECASE,
    ),
)

SYSTEM_PROMPT = """
You estimate a single logged meal for a lean calorie tracker.

Return JSON only with exactly these keys:
- name: string
- calories: integer
- protein: integer
- carbs: integer
- fat: integer
- confidence: "low" | "medium" | "high"
- protein_grams_visible_in_image: boolean

Rules:
- Estimate one realistic serving for what is shown or described.
- If multiple foods are present, combine them into a single meal entry.
- Check if the total calories roughly match the macros. If not, adjust macros to better align with the calories.
- Keep the name as short as possible, natural, and user-friendly.
- Use whole numbers only.
- Macros must be non-negative.
- Calories should roughly match the macro estimate.
- Set protein_grams_visible_in_image to true only when an attached image clearly shows a protein gram value on packaging, menu text, or overlaid text.
- If no image clearly shows a protein gram value, set protein_grams_visible_in_image to false. Do not infer it from the food itself.
- Do not wrap the JSON in markdown.
""".strip()


class MealAnalysisError(RuntimeError):
    """Raised when the model cannot produce a usable meal estimate."""


class MealEstimateSchema(BaseModel):
    name: str
    calories: int
    protein: int
    carbs: int
    fat: int
    confidence: Literal["low", "medium", "high"]
    protein_grams_visible_in_image: bool = False

    model_config = {"extra": "forbid"}


def _silence_litellm_loggers() -> None:
    for logger_name in LITELLM_LOGGER_NAMES:
        logger = logging.getLogger(logger_name)
        logger.disabled = True
        logger.propagate = False


@contextlib.contextmanager
def _suppress_litellm_console_noise():
    with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
        yield


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


def _extract_responses_text(response: Any) -> str:
    direct_text = getattr(response, "output_text", None)
    if direct_text is None and isinstance(response, dict):
        direct_text = response.get("output_text")

    if isinstance(direct_text, str) and direct_text.strip():
        return direct_text.strip()

    output = getattr(response, "output", None)
    if output is None and isinstance(response, dict):
        output = response.get("output")

    if isinstance(output, list):
        parts: list[str] = []
        for item in output:
            if isinstance(item, dict):
                item_type = item.get("type")
                content = item.get("content", [])
            else:
                item_type = getattr(item, "type", None)
                content = getattr(item, "content", [])

            if item_type != "message" or not isinstance(content, list):
                continue

            for content_item in content:
                if isinstance(content_item, dict):
                    content_type = content_item.get("type")
                    text = content_item.get("text")
                else:
                    content_type = getattr(content_item, "type", None)
                    text = getattr(content_item, "text", None)

                if content_type == "output_text" and isinstance(text, str) and text.strip():
                    parts.append(text.strip())

        joined = "".join(parts).strip()
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


def _normalize_goal_objective(value: Any) -> str | None:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in VALID_GOAL_OBJECTIVES:
            return normalized
    return None


def _normalize_ai_calculation_mode(value: Any) -> str:
    if isinstance(value, str):
        normalized = value.strip().lower()
        if normalized in VALID_AI_CALCULATION_MODES:
            return normalized
    return "balanced"


def _normalize_bool(value: Any) -> bool:
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value != 0
    if isinstance(value, str):
        return value.strip().lower() in {"1", "true", "yes"}
    return False


def _note_has_explicit_protein_grams(note: Any) -> bool:
    if not isinstance(note, str):
        return False

    trimmed = note.strip()
    if not trimmed:
        return False

    for pattern in EXPLICIT_PROTEIN_GRAMS_PATTERNS:
        if pattern.search(trimmed):
            return True

    return False


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


def _resolve_aggressive_macro_multipliers(
    goal_objective: Any,
    *,
    explicit_protein_grams_mentioned: bool = False,
) -> tuple[float, float, float]:
    normalized_goal = _normalize_goal_objective(goal_objective)
    if normalized_goal == "lose":
        return (1 if explicit_protein_grams_mentioned else 0.9, 1.1, 1.1)
    if normalized_goal == "gain":
        return (1 if explicit_protein_grams_mentioned else 0.9, 0.9, 0.9)
    return (1, 1, 1)


def _apply_ai_calculation_mode(
    meal: dict[str, Any],
    *,
    goal_objective: Any = None,
    ai_calculation_mode: Any = "balanced",
    explicit_protein_grams_mentioned: bool = False,
) -> dict[str, Any]:
    normalized_mode = _normalize_ai_calculation_mode(ai_calculation_mode)
    if normalized_mode != "aggressive":
        return dict(meal)

    protein_multiplier, carbs_multiplier, fat_multiplier = _resolve_aggressive_macro_multipliers(
        goal_objective,
        explicit_protein_grams_mentioned=explicit_protein_grams_mentioned,
    )
    if (
        protein_multiplier == 1
        and carbs_multiplier == 1
        and fat_multiplier == 1
    ):
        return dict(meal)

    original_protein = max(0, int(meal.get("protein", 0)))
    original_carbs = max(0, int(meal.get("carbs", 0)))
    original_fat = max(0, int(meal.get("fat", 0)))

    protein = max(0, int(round(original_protein * protein_multiplier)))
    carbs = max(0, int(round(original_carbs * carbs_multiplier)))
    fat = max(0, int(round(original_fat * fat_multiplier)))
    if (
        protein == original_protein
        and carbs == original_carbs
        and fat == original_fat
    ):
        return dict(meal)

    adjusted_calories = _macro_calories(protein, carbs, fat)

    return {
        **meal,
        "protein": protein,
        "carbs": carbs,
        "fat": fat,
        "calories": adjusted_calories if adjusted_calories > 0 else meal.get("calories", 0)
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
            "If an image clearly shows a protein gram value on packaging, menu text, or overlay text,"
            " set protein_grams_visible_in_image to true. Otherwise set it to false.\n"
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


def _build_openai_responses_input(
    note: str,
    image_payloads: list[dict[str, str]],
    mode: str,
) -> list[dict[str, Any]]:
    note_copy = note.strip() if isinstance(note, str) else ""
    content: list[dict[str, Any]] = [{
        "type": "input_text",
        "text": (
            "Estimate this meal for a calorie tracker.\n"
            f"Logging mode: {mode or 'manual'}.\n"
            f"User description: {note_copy or 'No text supplied.'}\n"
            "If an image clearly shows a protein gram value on packaging, menu text, or overlay text,"
            " set protein_grams_visible_in_image to true. Otherwise set it to false.\n"
            "Use web search when it would materially improve nutrition accuracy, especially for branded,"
            " restaurant, or packaged foods.\n"
            "Return the structured meal object only."
        )
    }]

    for payload in image_payloads:
        encoded = payload.get("encoded")
        if not encoded:
            continue
        media_type = payload.get("content_type") or "image/jpeg"
        content.append({
            "type": "input_image",
            "image_url": f"data:{media_type};base64,{encoded}",
            "detail": "low"
        })

    return [{
        "role": "user",
        "content": content
    }]


def _extract_web_search_sources(response: Any) -> list[str]:
    output = getattr(response, "output", None)
    if output is None and isinstance(response, dict):
        output = response.get("output")

    if not isinstance(output, list):
        return []

    sources: list[str] = []
    seen: set[str] = set()

    for item in output:
        if isinstance(item, dict):
            item_type = item.get("type")
            action = item.get("action")
        else:
            item_type = getattr(item, "type", None)
            action = getattr(item, "action", None)

        if item_type != "web_search_call":
            continue

        if isinstance(action, dict):
            action_type = action.get("type")
            source_items = action.get("sources", [])
        else:
            action_type = getattr(action, "type", None)
            source_items = getattr(action, "sources", [])

        if action_type != "search" or not isinstance(source_items, list):
            continue

        for source in source_items:
            if isinstance(source, dict):
                url = source.get("url")
            else:
                url = getattr(source, "url", None)

            if not isinstance(url, str) or not url.strip():
                continue

            normalized_url = url.strip()
            if normalized_url in seen:
                continue

            seen.add(normalized_url)
            sources.append(normalized_url)

            if len(sources) >= MAX_MEAL_SOURCE_COUNT:
                return sources

    return sources


def _analyze_with_openai_responses(
    *,
    model: str,
    note: str,
    normalized_images: list[dict[str, str]],
    mode: str,
) -> tuple[dict[str, Any], list[str]]:
    _silence_litellm_loggers()
    try:
        from litellm.responses.main import responses
    except ImportError as exc:
        raise MealAnalysisError("LiteLLM is not installed.") from exc

    with _suppress_litellm_console_noise():
        response = responses(
            model=model,
            instructions=SYSTEM_PROMPT,
            input=_build_openai_responses_input(note, normalized_images, mode),
            tools=[OPENAI_WEB_SEARCH_TOOL],
            include=["web_search_call.action.sources"],
            text_format=MealEstimateSchema,
            temperature=MEAL_AI_TEMPERATURE,
            timeout=45,
        )

    raw_text = _extract_responses_text(response)
    payload = _extract_json_payload(raw_text)
    return payload, _extract_web_search_sources(response)


def _analyze_with_completion(
    *,
    model: str,
    note: str,
    normalized_images: list[dict[str, str]],
    mode: str,
) -> dict[str, Any]:
    _silence_litellm_loggers()
    try:
        from litellm import completion
    except ImportError as exc:
        raise MealAnalysisError("LiteLLM is not installed.") from exc

    with _suppress_litellm_console_noise():
        response = completion(
            model=model,
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": _build_user_content(note, normalized_images, mode)
                }
            ],
            temperature=MEAL_AI_TEMPERATURE,
            timeout=45,
        )

    raw_text = _extract_response_text(response)
    return _extract_json_payload(raw_text)


def analyze_logged_meal(
    *,
    note: str = "",
    image_bytes: bytes | None = None,
    content_type: str | None = None,
    image_payloads: list[dict[str, str]] | None = None,
    mode: str = "manual",
    goal_objective: str | None = None,
    ai_calculation_mode: str | None = None,
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

    sources: list[str] = []
    if model.startswith("openai/"):
        payload, sources = _analyze_with_openai_responses(
            model=model,
            note=note_copy,
            normalized_images=normalized_images,
            mode=mode,
        )
    else:
        payload = _analyze_with_completion(
            model=model,
            note=note_copy,
            normalized_images=normalized_images,
            mode=mode,
        )

    explicit_protein_grams_mentioned = (
        _note_has_explicit_protein_grams(note_copy)
        or _normalize_bool(payload.get("protein_grams_visible_in_image"))
    )
    meal = _normalize_meal_payload(payload)
    adjusted_meal = _apply_ai_calculation_mode(
        meal,
        goal_objective=goal_objective,
        ai_calculation_mode=ai_calculation_mode,
        explicit_protein_grams_mentioned=explicit_protein_grams_mentioned,
    )
    if sources:
        adjusted_meal["sources"] = sources
    return adjusted_meal
