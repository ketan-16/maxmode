import test from "node:test";
import assert from "node:assert/strict";

function createLocalStorageMock() {
  const store = new Map();
  return {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
}

if (!globalThis.localStorage) {
  globalThis.localStorage = createLocalStorageMock();
}

const storage = await import("../static/js/modules/storage.mjs");

function resetStorage() {
  globalThis.localStorage.clear();
  storage.invalidateState();
}

test("legacy users without preferences normalize to defaults", () => {
  resetStorage();

  localStorage.setItem("maxmode_user", JSON.stringify({
    name: "Legacy",
    createdAt: "2026-01-01T00:00:00.000Z"
  }));

  const state = storage.loadState();
  assert.equal(state.user.name, "Legacy");
  assert.deepEqual(state.user.calorieGoal, {
    objective: null,
    presetKey: null
  });
  assert.deepEqual(state.user.preferences, {
    heightUnit: "cm",
    weightUnit: "kg",
    proteinMultiplierGPerKg: 1,
    aiCalculationMode: "balanced"
  });
});

test("setUserPreferences supports partial updates and persists", () => {
  resetStorage();

  storage.setUserName("Prefs");
  let state = storage.setUserPreferences({ weightUnit: "lb" });

  assert.deepEqual(storage.getUserPreferences(state), {
    heightUnit: "cm",
    weightUnit: "lb",
    proteinMultiplierGPerKg: 1,
    aiCalculationMode: "balanced"
  });

  state = storage.setUserPreferences({ heightUnit: "ft-in" });

  assert.deepEqual(storage.getUserPreferences(state), {
    heightUnit: "ft-in",
    weightUnit: "lb",
    proteinMultiplierGPerKg: 1,
    aiCalculationMode: "balanced"
  });

  const reloaded = storage.loadState();
  assert.deepEqual(storage.getUserPreferences(reloaded), {
    heightUnit: "ft-in",
    weightUnit: "lb",
    proteinMultiplierGPerKg: 1,
    aiCalculationMode: "balanced"
  });
});

test("legacy users normalize protein multiplier from the active goal bucket", () => {
  resetStorage();

  localStorage.setItem("maxmode_user", JSON.stringify({
    name: "Goal Defaults",
    createdAt: "2026-01-01T00:00:00.000Z",
    calorieGoal: {
      objective: "gain",
      presetKey: "bulk-lean"
    },
    preferences: {
      heightUnit: "cm",
      weightUnit: "kg"
    }
  }));

  const state = storage.loadState();
  assert.deepEqual(storage.getUserPreferences(state), {
    heightUnit: "cm",
    weightUnit: "kg",
    proteinMultiplierGPerKg: 1.6,
    aiCalculationMode: "balanced"
  });
});

test("custom protein multiplier persists across reloads", () => {
  resetStorage();

  storage.setUserName("Protein Prefs");
  let state = storage.setUserPreferences({ proteinMultiplierGPerKg: 2.15 });

  assert.equal(storage.getUserPreferences(state).proteinMultiplierGPerKg, 2.15);

  state = storage.loadState();
  assert.equal(storage.getUserPreferences(state).proteinMultiplierGPerKg, 2.15);
});

test("ai calculation mode persists across reloads", () => {
  resetStorage();

  storage.setUserName("AI Prefs");
  let state = storage.setUserPreferences({ aiCalculationMode: "aggressive" });

  assert.equal(storage.getUserPreferences(state).aiCalculationMode, "aggressive");

  state = storage.loadState();
  assert.equal(storage.getUserPreferences(state).aiCalculationMode, "aggressive");
});

test("calorie goals persist across reloads", () => {
  resetStorage();

  storage.setUserName("Goal");
  let state = storage.setCalorieGoal({
    objective: "gain",
    presetKey: "bulk-lean"
  });

  assert.deepEqual(storage.getCalorieGoal(state), {
    objective: "gain",
    presetKey: "bulk-lean"
  });

  state = storage.loadState();
  assert.deepEqual(storage.getCalorieGoal(state), {
    objective: "gain",
    presetKey: "bulk-lean"
  });
});

test("changing goal bucket resets protein multiplier to the new goal default", () => {
  resetStorage();

  storage.setUserName("Goal Reset");
  let state = storage.setCalorieGoal({
    objective: "lose",
    presetKey: "cut-moderate"
  });

  state = storage.setUserPreferences({
    proteinMultiplierGPerKg: 2.25,
    aiCalculationMode: "aggressive"
  });
  assert.equal(storage.getUserPreferences(state).proteinMultiplierGPerKg, 2.25);
  assert.equal(storage.getUserPreferences(state).aiCalculationMode, "aggressive");

  state = storage.setCalorieGoal({
    objective: "gain",
    presetKey: "bulk-lean"
  });

  assert.equal(storage.getUserPreferences(state).proteinMultiplierGPerKg, 1.6);
  assert.equal(storage.getUserPreferences(state).aiCalculationMode, "aggressive");
});

test("changing presets within the same goal bucket keeps the custom protein multiplier", () => {
  resetStorage();

  storage.setUserName("Goal Stable");
  let state = storage.setCalorieGoal({
    objective: "lose",
    presetKey: "cut-slow"
  });

  state = storage.setUserPreferences({ proteinMultiplierGPerKg: 2.05 });
  state = storage.setCalorieGoal({
    objective: "lose",
    presetKey: "cut-aggressive"
  });

  assert.equal(storage.getUserPreferences(state).proteinMultiplierGPerKg, 2.05);
});

test("calorie goal normalization salvages valid presets safely", () => {
  resetStorage();

  localStorage.setItem("maxmode_user", JSON.stringify({
    name: "Goal Legacy",
    createdAt: "2026-01-01T00:00:00.000Z",
    calorieGoal: {
      objective: "lose",
      presetKey: "bulk-lean"
    }
  }));

  const state = storage.loadState();
  assert.deepEqual(storage.getCalorieGoal(state), {
    objective: "gain",
    presetKey: "bulk-lean"
  });
});

test("invalid calorie goal values normalize to empty goal", () => {
  resetStorage();

  localStorage.setItem("maxmode_user", JSON.stringify({
    name: "Goal Legacy",
    createdAt: "2026-01-01T00:00:00.000Z",
    calorieGoal: {
      objective: "something",
      presetKey: "unknown"
    }
  }));

  const state = storage.loadState();
  assert.deepEqual(storage.getCalorieGoal(state), {
    objective: null,
    presetKey: null
  });
});

test("calorie profile height normalization keeps two-decimal precision", () => {
  resetStorage();

  storage.setUserName("Precision");
  let state = storage.setCalorieProfile({
    age: 28,
    gender: "male",
    activityLevel: "moderately-active",
    height: {
      unit: "cm",
      cm: 175.236,
      heightCm: 175.236
    }
  });

  assert.equal(state.user.calorieProfile.height.cm, 175.24);
  assert.equal(state.user.calorieProfile.height.heightCm, 175.24);

  state = storage.setCalorieProfile({
    height: {
      unit: "ft-in",
      cm: null,
      heightCm: null,
      ft: 5,
      in: 9
    }
  });

  assert.equal(state.user.calorieProfile.height.heightCm, 175.26);
  assert.equal(state.user.calorieProfile.height.cm, 175.26);
});

test("weight entries normalize to two decimals when logged in lb", () => {
  resetStorage();

  storage.setUserName("Weight Precision");
  const state = storage.addWeight(180, "lb");

  assert.equal(state.weights.length, 1);
  assert.equal(state.weights[0].weight, 81.65);
});

test("legacy lb weight entries auto-migrate to canonical kg in persisted storage", () => {
  resetStorage();

  localStorage.setItem("maxmode_user", JSON.stringify({
    name: "Legacy Migrator",
    createdAt: "2026-01-01T00:00:00.000Z"
  }));

  localStorage.setItem("maxmode_weights", JSON.stringify([
    { id: "w1", weight: 180, unit: "lb", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "w2", weight: 82, unit: "kg", timestamp: "2026-01-02T00:00:00.000Z" }
  ]));

  const state = storage.loadState();
  assert.equal(state.weights[0].weight, 81.65);
  assert.equal(state.weights[0].unit, "kg");
  assert.equal(state.weights[1].weight, 82);
  assert.equal(state.weights[1].unit, "kg");

  const persisted = JSON.parse(localStorage.getItem("maxmode_weights"));
  assert.equal(persisted[0].weight, 81.65);
  assert.equal(persisted[0].unit, "kg");
});

test("height normalization keeps cm synced to canonical heightCm", () => {
  resetStorage();

  localStorage.setItem("maxmode_user", JSON.stringify({
    name: "Height Legacy",
    createdAt: "2026-01-01T00:00:00.000Z",
    calorieProfile: {
      age: 30,
      gender: "male",
      activityLevel: "moderately-active",
      height: {
        unit: "cm",
        cm: 180,
        heightCm: 175.26,
        ft: 5,
        in: 9
      }
    },
    preferences: {
      heightUnit: "cm",
      weightUnit: "kg"
    }
  }));

  const state = storage.loadState();
  assert.equal(state.user.calorieProfile.height.heightCm, 175.26);
  assert.equal(state.user.calorieProfile.height.cm, 175.26);
});
