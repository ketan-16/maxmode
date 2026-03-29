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

test("meal entries can be added, updated, and deleted", () => {
  resetStorage();
  storage.setUserName("Meals");

  let state = storage.addMeal({
    name: "Greek yogurt",
    calories: 180,
    protein: 16,
    carbs: 12,
    fat: 6,
    source: "manual",
    confidence: "medium"
  });

  assert.equal(state.meals.length, 1);
  assert.equal(state.meals[0].baseCalories, 180);
  assert.equal(state.meals[0].calories, 180);

  const mealId = state.meals[0].id;
  const updated = storage.updateMeal(mealId, {
    name: "Greek yogurt bowl",
    portion: 1.5
  });

  assert.equal(updated, true);

  state = storage.loadState();
  assert.equal(state.meals[0].name, "Greek yogurt bowl");
  assert.equal(state.meals[0].portion, 1.5);
  assert.equal(state.meals[0].calories, 270);

  const deleted = storage.deleteMeal(mealId);
  assert.equal(deleted, true);
  assert.equal(storage.loadState().meals.length, 0);
});

test("calorie tracker meta persists reminder opt-in", () => {
  resetStorage();
  storage.setUserName("Reminder");

  let state = storage.setCalorieTrackerMeta({
    reminderOptIn: true,
    lastReminderDay: "2026-03-27"
  });

  assert.deepEqual(storage.getCalorieTrackerMeta(state), {
    reminderOptIn: true,
    lastReminderDay: "2026-03-27"
  });

  state = storage.loadState();
  assert.deepEqual(storage.getCalorieTrackerMeta(state), {
    reminderOptIn: true,
    lastReminderDay: "2026-03-27"
  });
});
