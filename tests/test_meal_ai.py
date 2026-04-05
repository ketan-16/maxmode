import os
import logging
import sys
import types
import unittest
from contextlib import redirect_stderr, redirect_stdout
from io import StringIO
from unittest.mock import Mock, patch

from meal_ai import (
    MEAL_AI_TEMPERATURE,
    OPENAI_WEB_SEARCH_TOOL,
    LITELLM_LOGGER_NAMES,
    _apply_ai_calculation_mode,
    _note_has_explicit_protein_grams,
    _normalize_meal_payload,
    _suppress_litellm_console_noise,
    _silence_litellm_loggers,
    analyze_logged_meal,
)


def normalized_meal(**overrides):
    payload = {
        "name": "Chicken bowl",
        "calories": 600,
        "protein": 40,
        "carbs": 50,
        "fat": 20,
        "confidence": "high",
    }
    payload.update(overrides)
    return _normalize_meal_payload(payload)


class MealAiTests(unittest.TestCase):
    def test_silence_litellm_loggers_disables_library_loggers(self):
        previous_states: dict[str, tuple[bool, bool]] = {}
        for logger_name in LITELLM_LOGGER_NAMES:
            logger = logging.getLogger(logger_name)
            previous_states[logger_name] = (logger.disabled, logger.propagate)
            logger.disabled = False
            logger.propagate = True

        try:
            _silence_litellm_loggers()
            for logger_name in LITELLM_LOGGER_NAMES:
                with self.subTest(logger_name=logger_name):
                    logger = logging.getLogger(logger_name)
                    self.assertTrue(logger.disabled)
                    self.assertFalse(logger.propagate)
        finally:
            for logger_name, (disabled, propagate) in previous_states.items():
                logger = logging.getLogger(logger_name)
                logger.disabled = disabled
                logger.propagate = propagate

    def test_suppress_litellm_console_noise_redirects_stdout_and_stderr(self):
        stdout_buffer = StringIO()
        stderr_buffer = StringIO()

        with redirect_stdout(stdout_buffer), redirect_stderr(stderr_buffer):
            with _suppress_litellm_console_noise():
                print("Provider List: https://docs.litellm.ai/docs/providers")
                print("Provider List: https://docs.litellm.ai/docs/providers", file=sys.stderr)

        self.assertEqual(stdout_buffer.getvalue(), "")
        self.assertEqual(stderr_buffer.getvalue(), "")

    def test_balanced_mode_leaves_normalized_meal_unchanged(self):
        meal = normalized_meal()

        adjusted = _apply_ai_calculation_mode(
            meal,
            goal_objective="lose",
            ai_calculation_mode="balanced",
        )

        self.assertEqual(adjusted, meal)

    def test_note_has_explicit_protein_grams_matches_supported_patterns(self):
        supported_notes = (
            "30g protein",
            "protein 30g",
            "about 30 grams of protein",
            "~30g protein",
            "30-35g protein",
            "protein: 30.5 g",
        )

        for note in supported_notes:
            with self.subTest(note=note):
                self.assertTrue(_note_has_explicit_protein_grams(note))

    def test_note_has_explicit_protein_grams_skips_vague_or_unrelated_patterns(self):
        excluded_notes = (
            "30g chicken",
            "high protein bowl",
            "protein bar",
            "extra protein",
            "double chicken",
            "30 grams",
            "protein bowl",
        )

        for note in excluded_notes:
            with self.subTest(note=note):
                self.assertFalse(_note_has_explicit_protein_grams(note))

    def test_aggressive_cut_preserves_explicit_protein_and_recalculates_remaining_macros(self):
        adjusted = _apply_ai_calculation_mode(
            normalized_meal(),
            goal_objective="lose",
            ai_calculation_mode="aggressive",
            explicit_protein_grams_mentioned=True,
        )

        self.assertEqual(adjusted["protein"], 40)
        self.assertEqual(adjusted["carbs"], 55)
        self.assertEqual(adjusted["fat"], 22)
        self.assertEqual(adjusted["calories"], 578)

    def test_aggressive_cut_without_explicit_protein_reduces_protein_and_recalculates_calories(self):
        adjusted = _apply_ai_calculation_mode(
            normalized_meal(),
            goal_objective="lose",
            ai_calculation_mode="aggressive",
        )

        self.assertEqual(adjusted["protein"], 36)
        self.assertEqual(adjusted["carbs"], 55)
        self.assertEqual(adjusted["fat"], 22)
        self.assertEqual(adjusted["calories"], 562)

    def test_aggressive_bulk_preserves_explicit_protein_and_recalculates_remaining_macros(self):
        adjusted = _apply_ai_calculation_mode(
            normalized_meal(),
            goal_objective="gain",
            ai_calculation_mode="aggressive",
            explicit_protein_grams_mentioned=True,
        )

        self.assertEqual(adjusted["protein"], 40)
        self.assertEqual(adjusted["carbs"], 45)
        self.assertEqual(adjusted["fat"], 18)
        self.assertEqual(adjusted["calories"], 502)

    def test_aggressive_bulk_without_explicit_protein_reduces_all_macros_and_recalculates_calories(self):
        adjusted = _apply_ai_calculation_mode(
            normalized_meal(),
            goal_objective="gain",
            ai_calculation_mode="aggressive",
        )

        self.assertEqual(adjusted["protein"], 36)
        self.assertEqual(adjusted["carbs"], 45)
        self.assertEqual(adjusted["fat"], 18)
        self.assertEqual(adjusted["calories"], 486)

    def test_maintain_and_missing_goal_skip_aggressive_adjustments(self):
        meal = normalized_meal()

        for goal_objective in ("maintain", None):
            for explicit_protein_grams_mentioned in (False, True):
                adjusted = _apply_ai_calculation_mode(
                    meal,
                    goal_objective=goal_objective,
                    ai_calculation_mode="aggressive",
                    explicit_protein_grams_mentioned=explicit_protein_grams_mentioned,
                )
                with self.subTest(
                    goal_objective=goal_objective,
                    explicit_protein_grams_mentioned=explicit_protein_grams_mentioned,
                ):
                    self.assertEqual(adjusted, meal)

    def test_zero_macro_meals_keep_original_calories_when_adjustment_stays_zero(self):
        adjusted = _apply_ai_calculation_mode(
            normalized_meal(calories=350, protein=0, carbs=0, fat=0),
            goal_objective="lose",
            ai_calculation_mode="aggressive",
        )

        self.assertEqual(adjusted["protein"], 0)
        self.assertEqual(adjusted["carbs"], 0)
        self.assertEqual(adjusted["fat"], 0)
        self.assertEqual(adjusted["calories"], 350)

    def test_analyze_logged_meal_uses_image_protein_flag_for_openai_aggressive_cut(self):
        mock_responses = Mock(return_value=types.SimpleNamespace(
            output_text=(
                '{"name":"Greek yogurt","calories":250,"protein":20,"carbs":18,'
                '"fat":5,"confidence":"high","protein_grams_visible_in_image":true}'
            ),
            output=[],
        ))
        fake_litellm_responses = types.SimpleNamespace(responses=mock_responses)

        with patch.dict(sys.modules, {"litellm.responses.main": fake_litellm_responses}):
            with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False):
                meal = analyze_logged_meal(
                    note="packaged yogurt",
                    image_payloads=[{"encoded": "abc", "content_type": "image/jpeg"}],
                    goal_objective="lose",
                    ai_calculation_mode="aggressive",
                )

        self.assertEqual(meal["protein"], 20)
        self.assertEqual(meal["carbs"], 20)
        self.assertEqual(meal["fat"], 6)
        self.assertEqual(meal["calories"], 214)
        self.assertNotIn("protein_grams_visible_in_image", meal)

    def test_analyze_logged_meal_uses_openai_responses_with_web_search(self):
        mock_responses = Mock(return_value=types.SimpleNamespace(
            output_text='{"name":"Chipotle bowl","calories":670,"protein":42,"carbs":61,"fat":24,"confidence":"high"}',
            output=[
                types.SimpleNamespace(
                    type="web_search_call",
                    action=types.SimpleNamespace(
                        type="search",
                        sources=[
                            types.SimpleNamespace(url="https://www.chipotle.com/nutrition-calculator"),
                            types.SimpleNamespace(url="https://www.nutritionix.com/brand/chipotle-mexican-grill")
                        ],
                    ),
                )
            ],
        ))
        fake_litellm_responses = types.SimpleNamespace(responses=mock_responses)

        with patch.dict(sys.modules, {"litellm.responses.main": fake_litellm_responses}):
            with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False):
                meal = analyze_logged_meal(note="chipotle chicken bowl")

        self.assertEqual(meal["name"], "Chipotle bowl")
        self.assertEqual(meal["calories"], 670)
        self.assertEqual(
            meal["sources"],
            [
                "https://www.chipotle.com/nutrition-calculator",
                "https://www.nutritionix.com/brand/chipotle-mexican-grill",
            ],
        )
        mock_responses.assert_called_once()
        self.assertEqual(mock_responses.call_args.kwargs["temperature"], MEAL_AI_TEMPERATURE)
        self.assertEqual(mock_responses.call_args.kwargs["tools"], [OPENAI_WEB_SEARCH_TOOL])
        self.assertEqual(
            mock_responses.call_args.kwargs["include"],
            ["web_search_call.action.sources"],
        )

    def test_analyze_logged_meal_uses_image_protein_flag_for_completion_aggressive_bulk(self):
        mock_completion = Mock(return_value=types.SimpleNamespace(
            choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(
                    content=(
                        '{"name":"Chicken bowl","calories":620,"protein":38,"carbs":58,"fat":22,'
                        '"confidence":"high","protein_grams_visible_in_image":true}'
                    )
                )
            )]
        ))
        fake_litellm = types.SimpleNamespace(completion=mock_completion)

        with patch.dict(sys.modules, {"litellm": fake_litellm}):
            with patch.dict(os.environ, {"MEAL_AI_MODEL": "anthropic/claude-sonnet-4-5"}, clear=False):
                meal = analyze_logged_meal(
                    note="packaged chicken bowl",
                    image_payloads=[{"encoded": "abc", "content_type": "image/jpeg"}],
                    goal_objective="gain",
                    ai_calculation_mode="aggressive",
                )

        self.assertEqual(meal["protein"], 38)
        self.assertEqual(meal["carbs"], 52)
        self.assertEqual(meal["fat"], 20)
        self.assertEqual(meal["calories"], 540)
        self.assertNotIn("protein_grams_visible_in_image", meal)

    def test_analyze_logged_meal_keeps_completion_flow_for_non_openai_models(self):
        mock_completion = Mock(return_value=types.SimpleNamespace(
            choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(
                    content='{"name":"Chicken bowl","calories":620,"protein":38,"carbs":58,"fat":22,"confidence":"high"}'
                )
            )]
        ))
        fake_litellm = types.SimpleNamespace(completion=mock_completion)

        with patch.dict(sys.modules, {"litellm": fake_litellm}):
            with patch.dict(os.environ, {"MEAL_AI_MODEL": "anthropic/claude-sonnet-4-5"}, clear=False):
                meal = analyze_logged_meal(note="chicken rice bowl")

        self.assertEqual(meal["name"], "Chicken bowl")
        self.assertEqual(meal["calories"], 620)
        self.assertEqual(meal["confidence"], "high")
        mock_completion.assert_called_once()
        self.assertEqual(mock_completion.call_args.kwargs["temperature"], MEAL_AI_TEMPERATURE)


if __name__ == "__main__":
    unittest.main()
