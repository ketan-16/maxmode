import test from "node:test";
import assert from "node:assert/strict";

import {
  applyGoalStepUiState,
  buildGoalStepUiState,
  nextGoalSelectionState
} from "../static/js/modules/goal-flow.mjs";
import { createUiElement } from "./dom-helpers.mjs";

function createGoalElements() {
  return {
    track: createUiElement(),
    label: createUiElement(),
    dots: [createUiElement(), createUiElement()],
    backButton: createUiElement({ classNames: ["hidden"] }),
    primaryButton: createUiElement()
  };
}

test("goal flow disables progression until an objective is chosen", () => {
  const elements = createGoalElements();
  const uiState = buildGoalStepUiState({
    currentStep: 0,
    stepCount: 2,
    hasObjective: false,
    hasMaintenance: false,
    hasPreset: false
  });

  applyGoalStepUiState(elements, uiState);

  assert.equal(elements.track.style.transform, "translateX(-0%)");
  assert.equal(elements.label.textContent, "Step 1 of 2");
  assert.equal(elements.backButton.classList.contains("hidden"), true);
  assert.equal(elements.primaryButton.textContent, "Continue");
  assert.equal(elements.primaryButton.disabled, true);
  assert.equal(elements.dots[0].classList.contains("is-active"), true);
  assert.equal(elements.dots[1].disabled, true);
});

test("goal flow enables save once maintenance and a preset are available", () => {
  const selection = nextGoalSelectionState("", "", "maintain", () => null);
  const elements = createGoalElements();
  const uiState = buildGoalStepUiState({
    currentStep: 1,
    stepCount: 2,
    hasObjective: selection.selectedObjective === "maintain",
    hasMaintenance: true,
    hasPreset: selection.selectedPresetKey === "maintain"
  });

  applyGoalStepUiState(elements, uiState);

  assert.equal(selection.selectedPresetKey, "maintain");
  assert.equal(elements.track.style.transform, "translateX(-100%)");
  assert.equal(elements.label.textContent, "Step 2 of 2");
  assert.equal(elements.backButton.classList.contains("hidden"), false);
  assert.equal(elements.primaryButton.textContent, "Save goal");
  assert.equal(elements.primaryButton.disabled, false);
  assert.equal(elements.dots[1].classList.contains("is-active"), true);
});
