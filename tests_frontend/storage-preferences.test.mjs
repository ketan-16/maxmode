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
  assert.deepEqual(state.user.preferences, {
    heightUnit: "cm",
    weightUnit: "kg"
  });
});

test("setUserPreferences supports partial updates and persists", () => {
  resetStorage();

  storage.setUserName("Prefs");
  let state = storage.setUserPreferences({ weightUnit: "lb" });

  assert.deepEqual(storage.getUserPreferences(state), {
    heightUnit: "cm",
    weightUnit: "lb"
  });

  state = storage.setUserPreferences({ heightUnit: "ft-in" });

  assert.deepEqual(storage.getUserPreferences(state), {
    heightUnit: "ft-in",
    weightUnit: "lb"
  });

  const reloaded = storage.loadState();
  assert.deepEqual(storage.getUserPreferences(reloaded), {
    heightUnit: "ft-in",
    weightUnit: "lb"
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
