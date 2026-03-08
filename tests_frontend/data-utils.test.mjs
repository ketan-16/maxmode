import test from "node:test";
import assert from "node:assert/strict";

import {
  buildDashboardTrendNoteFromKg,
  convertWeightForDisplay,
  filterWeightSeriesForRange,
  formatSignedWeightDelta,
  formatSignedWeightDeltaFromKg,
  formatWeightNumber,
  formatWeightWithUnit,
  getChartReadyWeights,
  getHeightDisplay,
  mapWeightsToDisplay,
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

test("normalizeWeights migrates legacy lb entries to canonical kg storage", () => {
  const input = [
    { id: "legacy-lb", weight: 180, unit: "lb", timestamp: "2026-01-01T00:00:00.000Z" },
    { id: "already-kg", weight: 82, unit: "kg", timestamp: "2026-01-02T00:00:00.000Z" }
  ];

  const result = normalizeWeights(input, "2026-01-03T00:00:00.000Z");
  assert.equal(result.weights.length, 2);
  assert.equal(result.changed, true);
  assert.equal(result.weights[0].unit, "kg");
  assert.equal(result.weights[0].weight, 81.65);
  assert.equal(result.weights[1].unit, "kg");
  assert.equal(result.weights[1].weight, 82);
});

test("normalizeWeights canonical migration is idempotent", () => {
  const first = normalizeWeights([
    { id: "legacy", weight: 200, unit: "lb", timestamp: "2026-01-01T00:00:00.000Z" }
  ], "2026-01-02T00:00:00.000Z");

  const second = normalizeWeights(first.weights, "2026-01-02T00:00:00.000Z");
  assert.equal(second.changed, false);
  assert.equal(second.weights[0].weight, first.weights[0].weight);
  assert.equal(second.weights[0].unit, "kg");
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
  assert.equal(formatWeightNumber(80.26), "80.26");
  assert.equal(formatSignedWeightDelta(0, "kg"), "0 kg");
  assert.equal(formatSignedWeightDelta(1.24, "kg"), "+1.24 kg");
  assert.equal(formatSignedWeightDelta(-1.24, "kg"), "-1.24 kg");
});

test("display conversion helpers convert canonical kg to preferred units", () => {
  const single = convertWeightForDisplay(81.6466, "lb");
  assert.equal(Math.round(single.value), 180);
  assert.equal(single.unit, "lb");

  const mapped = mapWeightsToDisplay([
    { id: "a", weight: 80, unit: "kg", timestamp: "2026-01-01T00:00:00.000Z" }
  ], "lb");
  assert.equal(mapped[0].unit, "lb");
  assert.equal(Math.round(mapped[0].weight), 176);

  assert.equal(formatWeightWithUnit(80, "kg"), "80 kg");
  assert.equal(formatWeightWithUnit(80, "lb"), "176.37 lb");
  assert.equal(formatSignedWeightDeltaFromKg(-1, "lb"), "-2.2 lb");
  assert.equal(buildDashboardTrendNoteFromKg(0.5, "lb"), "Up 1.1 lb over 30 days.");
});

test("height display helper formats canonical cm by preferred unit", () => {
  const metric = getHeightDisplay(175.26, "cm");
  assert.equal(metric.cm, 175.26);
  assert.equal(metric.text, "175.26 cm");

  const imperial = getHeightDisplay(175.26, "ft-in");
  assert.equal(imperial.ft, 5);
  assert.equal(imperial.in, 9);
  assert.equal(imperial.text, "5 ft 9 in");
});
