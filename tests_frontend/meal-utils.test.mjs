import test from "node:test";
import assert from "node:assert/strict";

import {
  buildCalorieTrackerSummary,
  getFrequentFoods,
  getRecentFoods,
  normalizeMeals,
  scaleMealNutrition
} from "../static/js/modules/meal-utils.mjs";

test("normalizeMeals derives canonical base values from portioned totals", () => {
  const { meals } = normalizeMeals([
    {
      id: "meal-1",
      name: "Chicken bowl",
      calories: 900,
      protein: 60,
      carbs: 90,
      fat: 30,
      portion: 1.5,
      source: "scan",
      confidence: "high",
      loggedAt: "2026-03-27T08:30:00.000Z"
    }
  ], "2026-03-27T08:30:00.000Z");

  assert.equal(meals.length, 1);
  assert.equal(meals[0].baseCalories, 600);
  assert.equal(meals[0].baseProtein, 40);
  assert.equal(meals[0].baseCarbs, 60);
  assert.equal(meals[0].baseFat, 20);
  assert.equal(meals[0].calories, 900);
});

test("scaleMealNutrition updates totals when portion changes", () => {
  const scaled = scaleMealNutrition({
    baseCalories: 320,
    baseProtein: 20,
    baseCarbs: 30,
    baseFat: 12
  }, 1.75);

  assert.equal(scaled.portion, 1.75);
  assert.equal(scaled.calories, 560);
  assert.equal(scaled.protein, 35);
  assert.equal(scaled.carbs, 53);
  assert.equal(scaled.fat, 21);
});

test("buildCalorieTrackerSummary computes progress, streak, and recent foods", () => {
  const state = {
    user: {
      name: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      calorieProfile: {
        age: 30,
        gender: "male",
        activityLevel: "lightly-active",
        height: {
          unit: "cm",
          cm: 180,
          ft: 5,
          in: 11,
          heightCm: 180
        }
      }
    },
    chartSeries: [
      { weight: 80, timestamp: 1 },
      { weight: 78, timestamp: 2 }
    ],
    meals: [
      {
        id: "m-today-1",
        name: "Greek yogurt",
        calories: 220,
        protein: 20,
        carbs: 18,
        fat: 8,
        baseCalories: 220,
        baseProtein: 20,
        baseCarbs: 18,
        baseFat: 8,
        portion: 1,
        source: "manual",
        confidence: "medium",
        loggedAt: "2026-03-27T08:00:00"
      },
      {
        id: "m-today-2",
        name: "Chicken bowl",
        calories: 640,
        protein: 42,
        carbs: 68,
        fat: 18,
        baseCalories: 640,
        baseProtein: 42,
        baseCarbs: 68,
        baseFat: 18,
        portion: 1,
        source: "scan",
        confidence: "high",
        loggedAt: "2026-03-27T13:10:00"
      },
      {
        id: "m-yesterday",
        name: "Chicken bowl",
        calories: 640,
        protein: 42,
        carbs: 68,
        fat: 18,
        baseCalories: 640,
        baseProtein: 42,
        baseCarbs: 68,
        baseFat: 18,
        portion: 1,
        source: "scan",
        confidence: "high",
        loggedAt: "2026-03-26T12:20:00"
      },
      {
        id: "m-two-days",
        name: "Oatmeal",
        calories: 340,
        protein: 14,
        carbs: 48,
        fat: 10,
        baseCalories: 340,
        baseProtein: 14,
        baseCarbs: 48,
        baseFat: 10,
        portion: 1,
        source: "manual",
        confidence: "medium",
        loggedAt: "2026-03-25T09:30:00"
      }
    ]
  };

  const summary = buildCalorieTrackerSummary(state, new Date("2026-03-27T18:30:00"));
  const frequentFoods = getFrequentFoods(state.meals);
  const recentFoods = getRecentFoods(state.meals);

  assert.equal(summary.consumedCalories, 860);
  assert.equal(summary.protein, 62);
  assert.equal(summary.mealCount, 2);
  assert.equal(summary.streakCount, 3);
  assert.equal(summary.goalSource, "maintenance-default");
  assert.equal(summary.feedback, "You're on track");
  assert.equal(summary.reminder.title, "Log dinner?");
  assert.deepEqual(frequentFoods.map((item) => item.name), ["Chicken bowl", "Greek yogurt", "Oatmeal"]);
  assert.deepEqual(recentFoods.map((item) => item.name), ["Chicken bowl", "Greek yogurt", "Oatmeal"]);
});

test("buildCalorieTrackerSummary uses a saved calorie goal when available", () => {
  const state = {
    user: {
      name: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      calorieProfile: {
        age: 30,
        gender: "male",
        activityLevel: "lightly-active",
        height: {
          unit: "cm",
          cm: 180,
          ft: 5,
          in: 11,
          heightCm: 180
        }
      },
      calorieGoal: {
        objective: "lose",
        presetKey: "cut-moderate"
      }
    },
    chartSeries: [
      { weight: 78, timestamp: 1 }
    ],
    meals: []
  };

  const summary = buildCalorieTrackerSummary(state, new Date("2026-03-27T18:30:00"));

  assert.equal(summary.goalSource, "saved-goal");
  assert.equal(summary.goalPresetKey, "cut-moderate");
  assert.equal(summary.goalLabel, "Moderate cut");
  assert.equal(summary.goalCalories, summary.maintenanceCalories - 400);
});
