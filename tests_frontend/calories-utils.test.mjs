import test from "node:test";
import assert from "node:assert/strict";

import {
  calculateBmr,
  calculateMaintenanceCalories,
  calculateMaintenanceFromState,
  cmToFeetInches,
  feetInchesToCm,
  getCalorieMissingReasons,
  kgToLb,
  lbToKg,
  weightToKg
} from "../static/js/modules/calories-utils.mjs";

test("height conversion utilities are reversible for common values", () => {
  const cm = feetInchesToCm(5, 9);
  assert.ok(cm);
  assert.equal(Math.round(cm * 100) / 100, 175.26);

  const imperial = cmToFeetInches(175.26);
  assert.deepEqual(imperial, { ft: 5, in: 9 });
});

test("weight conversion utilities support kg and lb", () => {
  const kg = lbToKg(180);
  assert.ok(kg);
  assert.equal(Math.round(kg * 1000) / 1000, 81.647);

  const lb = kgToLb(81.6466266);
  assert.ok(lb);
  assert.equal(Math.round(lb), 180);

  assert.equal(Math.round(weightToKg(180, "lb") * 1000) / 1000, 81.647);
  assert.equal(weightToKg(82, "kg"), 82);
});

test("BMR equations return expected values for male and female", () => {
  const male = calculateBmr({ age: 25, gender: "male", heightCm: 175, weightKg: 70 });
  const female = calculateBmr({ age: 25, gender: "female", heightCm: 175, weightKg: 70 });

  assert.equal(Math.round(male * 100) / 100, 1673.75);
  assert.equal(Math.round(female * 100) / 100, 1507.75);
});

test("maintenance calories apply activity multipliers", () => {
  const maintenance = calculateMaintenanceCalories({ bmr: 1673.75, activityLevel: "moderately-active" });
  assert.equal(Math.round(maintenance * 100) / 100, 2594.31);
});

test("calculateMaintenanceFromState uses latest logged weight", () => {
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
    ]
  };

  const summary = calculateMaintenanceFromState(state);
  assert.ok(summary);
  assert.equal(summary.weightKg, 78);
  assert.equal(summary.maintenanceRounded, Math.round(summary.maintenance));
});

test("missing reason helper reports required gaps", () => {
  const missing = getCalorieMissingReasons({
    user: {
      name: "A",
      createdAt: "2026-01-01T00:00:00.000Z",
      calorieProfile: {
        age: null,
        gender: null,
        activityLevel: null,
        height: {
          unit: "cm",
          cm: null,
          ft: null,
          in: null,
          heightCm: null
        }
      }
    },
    chartSeries: []
  });

  assert.deepEqual(missing, ["age", "gender", "height", "activityLevel", "weight"]);
});
