import os
import sys
import types
import unittest
from unittest.mock import Mock, patch

from meal_ai import (
    MEAL_AI_TEMPERATURE,
    _apply_ai_calculation_mode,
    _normalize_meal_payload,
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
    def test_balanced_mode_leaves_normalized_meal_unchanged(self):
        meal = normalized_meal()

        adjusted = _apply_ai_calculation_mode(
            meal,
            goal_objective="lose",
            ai_calculation_mode="balanced",
        )

        self.assertEqual(adjusted, meal)

    def test_aggressive_cut_adds_ten_percent_to_macros_and_recalculates_calories(self):
        adjusted = _apply_ai_calculation_mode(
            normalized_meal(),
            goal_objective="lose",
            ai_calculation_mode="aggressive",
        )

        self.assertEqual(adjusted["protein"], 44)
        self.assertEqual(adjusted["carbs"], 55)
        self.assertEqual(adjusted["fat"], 22)
        self.assertEqual(adjusted["calories"], 594)

    def test_aggressive_bulk_removes_ten_percent_from_macros_and_recalculates_calories(self):
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
            with self.subTest(goal_objective=goal_objective):
                adjusted = _apply_ai_calculation_mode(
                    meal,
                    goal_objective=goal_objective,
                    ai_calculation_mode="aggressive",
                )
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

    def test_analyze_logged_meal_uses_temperature_point_two(self):
        mock_completion = Mock(return_value=types.SimpleNamespace(
            choices=[types.SimpleNamespace(
                message=types.SimpleNamespace(
                    content='{"name":"Chicken bowl","calories":620,"protein":38,"carbs":58,"fat":22,"confidence":"high"}'
                )
            )]
        ))
        fake_litellm = types.SimpleNamespace(completion=mock_completion)

        with patch.dict(sys.modules, {"litellm": fake_litellm}):
            with patch.dict(os.environ, {"OPENAI_API_KEY": "test-key"}, clear=False):
                meal = analyze_logged_meal(note="chicken rice bowl")

        self.assertEqual(meal["name"], "Chicken bowl")
        self.assertEqual(meal["calories"], 620)
        self.assertEqual(meal["confidence"], "high")
        mock_completion.assert_called_once()
        self.assertEqual(mock_completion.call_args.kwargs["temperature"], MEAL_AI_TEMPERATURE)


if __name__ == "__main__":
    unittest.main()
