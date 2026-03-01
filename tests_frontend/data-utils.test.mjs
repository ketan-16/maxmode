import test from "node:test";
import assert from "node:assert/strict";

import {
  filterWeightSeriesForRange,
  formatSignedWeightDelta,
  formatWeightNumber,
  getChartReadyWeights,
  normalizeWeights
} from "../static/js/modules/data-utils.mjs";

test("normalizeWeights filters invalid entries and normalizes fields", () => {
  const input = [
    null,
    { weight: "80.4", unit: "kg", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "x", weight: -5, unit: "kg", timestamp: "2026-01-02T00:00:00.000Z" },
    { id: "y", weight: 79.9, unit: "kg", timestamp: "2026-01-03T00:00:00.000Z" }
  ];

  const result = normalizeWeights(input, "2026-01-04T00:00:00.000Z");
  assert.equal(result.weights.length, 2);
  assert.equal(result.changed, true);
  assert.equal(result.weights[0].weight, 80.4);
  assert.equal(result.weights[1].id, "y");
  assert.ok(result.weights[0].id);
});

test("getChartReadyWeights returns ascending timestamp series", () => {
  const points = getChartReadyWeights([
    { id: "b", weight: 80, unit: "kg", timestamp: "2026-01-03T00:00:00.000Z" },
    { id: "a", weight: 81, unit: "kg", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "c", weight: 79.5, unit: "kg", timestamp: "2026-01-02T00:00:00.000Z" }
  ]);

  assert.deepEqual(points.map((item) => item.id), ["a", "c", "b"]);
});

test("filterWeightSeriesForRange keeps anchor point before cutoff", () => {
  const points = getChartReadyWeights([
    { id: "old", weight: 90, unit: "kg", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "new", weight: 88, unit: "kg", timestamp: "2026-03-01T00:00:00.000Z" }
  ]);

  const filtered = filterWeightSeriesForRange(points, "30d");
  assert.equal(filtered.length, 2);
  assert.deepEqual(filtered.map((item) => item.id), ["old", "new"]);
});

test("weight formatters produce stable output", () => {
  assert.equal(formatWeightNumber(80), "80");
  assert.equal(formatWeightNumber(80.26), "80.3");
  assert.equal(formatSignedWeightDelta(0, "kg"), "0 kg");
  assert.equal(formatSignedWeightDelta(1.24, "kg"), "+1.2 kg");
  assert.equal(formatSignedWeightDelta(-1.24, "kg"), "-1.2 kg");
});
