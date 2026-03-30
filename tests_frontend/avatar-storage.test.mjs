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

test("avatarUrl points to the profile picture API with normalized gender", () => {
  assert.equal(
    storage.avatarUrl("Alex Doe", "female", 144),
    "/api/profile/picture?name=Alex+Doe&gender=female&size=144"
  );
});

test("avatarUrl falls back to neutral defaults for invalid inputs", () => {
  assert.equal(
    storage.avatarUrl(" ", "unknown", 12),
    "/api/profile/picture?name=MaxMode+Member&gender=neutral&size=64"
  );
});
