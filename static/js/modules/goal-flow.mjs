export function nextGoalSelectionState(currentObjective, currentPresetKey, nextObjective, getPresetByKey) {
  const selectedObjective = typeof nextObjective === "string" ? nextObjective : "";
  const currentPreset = (typeof getPresetByKey === "function")
    ? getPresetByKey(currentPresetKey)
    : null;

  if (selectedObjective === "maintain") {
    return {
      selectedObjective,
      selectedPresetKey: "maintain"
    };
  }

  if (!currentPreset || currentPreset.objective !== selectedObjective) {
    return {
      selectedObjective,
      selectedPresetKey: ""
    };
  }

  return {
    selectedObjective,
    selectedPresetKey: currentPresetKey || ""
  };
}

export function buildGoalStepUiState({
  currentStep = 0,
  stepCount = 2,
  hasObjective = false,
  hasMaintenance = false,
  hasPreset = false
} = {}) {
  const normalizedStepCount = Math.max(1, Math.round(stepCount || 1));
  const normalizedStep = Math.max(0, Math.min(normalizedStepCount - 1, Math.round(currentStep || 0)));
  const dots = new Array(normalizedStepCount);

  for (let i = 0; i < normalizedStepCount; i += 1) {
    dots[i] = {
      active: i === normalizedStep,
      disabled: i > 0 && !hasObjective
    };
  }

  return {
    backHidden: normalizedStep === 0,
    dots,
    label: `Step ${normalizedStep + 1} of ${normalizedStepCount}`,
    primaryDisabled: normalizedStep === 0
      ? !hasObjective
      : !(hasMaintenance && hasPreset),
    primaryText: normalizedStep === 0 ? "Continue" : "Save goal",
    trackTransform: `translateX(-${normalizedStep * 100}%)`
  };
}

export function applyGoalStepUiState(elements, uiState) {
  if (!elements || !uiState) return;

  const track = elements.track || null;
  const label = elements.label || null;
  const dots = Array.isArray(elements.dots) ? elements.dots : [];
  const backButton = elements.backButton || null;
  const primaryButton = elements.primaryButton || null;

  if (track) {
    track.style.transform = uiState.trackTransform || "";
  }

  if (label) {
    label.textContent = uiState.label || "";
  }

  for (let i = 0; i < dots.length; i += 1) {
    const dot = dots[i];
    const state = uiState.dots && uiState.dots[i] ? uiState.dots[i] : { active: false, disabled: false };
    dot.classList.toggle("is-active", !!state.active);
    dot.classList.toggle("is-disabled", !!state.disabled);
    dot.disabled = !!state.disabled;
  }

  if (backButton) {
    backButton.classList.toggle("hidden", !!uiState.backHidden);
  }

  if (primaryButton) {
    primaryButton.textContent = uiState.primaryText || "";
    primaryButton.disabled = !!uiState.primaryDisabled;
  }
}
