import {
  addWeight,
  getUserPreferences,
  loadState,
  setCalorieProfile,
  setUserPreferences
} from "../modules/storage.mjs";
import {
  ACTIVITY_OPTIONS,
  calculateMaintenanceFromState,
  cmToFeetInches,
  feetInchesToCm,
  getCalorieMissingReasons,
  weightToKg
} from "../modules/calories-utils.mjs";
import { formatWeightWithUnit, getHeightDisplay } from "../modules/data-utils.mjs";

const STEP_COUNT = 3;
const SWIPE_THRESHOLD = 56;

const MISSING_REASON_LABELS = {
  age: "Add your age",
  gender: "Select your gender",
  height: "Add your height",
  activityLevel: "Select your activity level",
  weight: "Log your current weight"
};

let currentStep = 0;
let latestState = null;
let autoPromptedThisView = false;
let closeTimer = null;
let touchStartX = 0;
let touchStartY = 0;
let touchTracking = false;

function parseNumber(value) {
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function isModalOpen() {
  const modal = document.getElementById("calorie-setup-modal");
  return !!(modal && !modal.classList.contains("hidden") && modal.classList.contains("is-open"));
}

function getWeightEntriesCount() {
  if (!latestState || !Array.isArray(latestState.chartSeries)) return 0;
  return latestState.chartSeries.length;
}

function hasExistingWeightEntries() {
  return getWeightEntriesCount() > 0;
}

function setError(message) {
  const errorEl = document.getElementById("calorie-setup-error");
  if (!errorEl) return;
  errorEl.textContent = message || "";
}

function isValidActivityLevel(activityLevel) {
  for (let i = 0; i < ACTIVITY_OPTIONS.length; i += 1) {
    if (ACTIVITY_OPTIONS[i].key === activityLevel) return true;
  }
  return false;
}

function iconForActivity(icon) {
  if (icon === "armchair") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 11V7a2 2 0 0 1 4 0v4"></path><path d="M15 11V7a2 2 0 0 1 4 0v4"></path><path d="M3 11h18v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5Z"></path><path d="M4 18v3"></path><path d="M20 18v3"></path></svg>';
  }

  if (icon === "footprints") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 14c0-1.8 1.1-3.2 2.5-3.2S9 12.2 9 14s-1.1 3.2-2.5 3.2S4 15.8 4 14Z"></path><path d="M8 7.2c0-1.1.7-2 1.6-2s1.6.9 1.6 2-.7 2-1.6 2-1.6-.9-1.6-2Z"></path><path d="M13 18c0-1.8 1.1-3.2 2.5-3.2S18 16.2 18 18s-1.1 3.2-2.5 3.2S13 19.8 13 18Z"></path><path d="M17 11.2c0-1.1.7-2 1.6-2s1.6.9 1.6 2-.7 2-1.6 2-1.6-.9-1.6-2Z"></path></svg>';
  }

  if (icon === "dumbbell") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9v6"></path><path d="M3 10.5v3"></path><path d="M9 8v8"></path><path d="M15 8v8"></path><path d="M18 9v6"></path><path d="M21 10.5v3"></path><path d="M9 12h6"></path></svg>';
  }

  if (icon === "zap") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M13 2 4 14h7l-1 8 10-14h-7z"></path></svg>';
  }

  if (icon === "flame") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 2c.7 2.3-.4 4.2-2 5.8-2 2-4.5 3.7-4.5 7A6.5 6.5 0 0 0 12 21a6.5 6.5 0 0 0 6.5-6.2c0-4.3-3.1-6.7-5-8.8-.8 1.8-2.5 3-4.3 3.3"></path><path d="M12 21a3.3 3.3 0 0 0 3.3-3.2c0-1.8-1.2-2.8-2.1-3.9-.4.9-1.2 1.5-2.1 1.6-.8.1-1.7.9-1.7 2.2A3.3 3.3 0 0 0 12 21Z"></path></svg>';
  }

  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8"></circle></svg>';
}

function renderActivityOptions(selectedLevel) {
  const container = document.getElementById("calorie-activity-options");
  if (!container) return;

  const cards = [];
  for (let i = 0; i < ACTIVITY_OPTIONS.length; i += 1) {
    const option = ACTIVITY_OPTIONS[i];
    const isSelected = option.key === selectedLevel;
    cards.push(`<button type="button" class="activity-option-card${isSelected ? " is-selected" : ""}" data-activity-level="${option.key}" role="radio" aria-checked="${isSelected ? "true" : "false"}">
      <span class="activity-option-radio" aria-hidden="true"></span>
      <span class="activity-option-icon" aria-hidden="true">${iconForActivity(option.icon)}</span>
      <span class="activity-option-copy">
        <span class="activity-option-title">${option.title}</span>
        <span class="activity-option-description">${option.description}</span>
      </span>
    </button>`);
  }

  container.setAttribute("role", "radiogroup");
  container.innerHTML = cards.join("");
}

function parseStepValues() {
  const ageInput = document.getElementById("calorie-age-input");
  const genderInput = document.getElementById("calorie-gender-input");
  const heightUnitInput = document.getElementById("calorie-height-unit");
  const cmInput = document.getElementById("calorie-height-cm-input");
  const ftInput = document.getElementById("calorie-height-ft-input");
  const inInput = document.getElementById("calorie-height-in-input");
  const activityInput = document.getElementById("calorie-activity-level-input");
  const weightUnitInput = document.getElementById("calorie-weight-unit");
  const weightInput = document.getElementById("calorie-weight-input");

  if (!ageInput || !genderInput || !heightUnitInput || !cmInput || !ftInput || !inInput || !activityInput || !weightUnitInput || !weightInput) {
    return null;
  }

  const ageRaw = parseNumber(ageInput.value);
  const age = (ageRaw !== null) ? Math.round(ageRaw) : null;
  const gender = genderInput.value || null;
  const activityLevel = activityInput.value || null;

  const heightUnit = (heightUnitInput.value === "ft-in") ? "ft-in" : "cm";
  const cmValue = parseNumber(cmInput.value);
  const ftValue = parseNumber(ftInput.value);
  const inValue = parseNumber(inInput.value);

  const heightCm = (heightUnit === "cm")
    ? ((cmValue && cmValue > 0) ? cmValue : null)
    : feetInchesToCm(ftValue, inValue);

  const weightUnit = (weightUnitInput.value === "lb") ? "lb" : "kg";
  const weightValue = parseNumber(weightInput.value);

  return {
    age,
    gender,
    heightUnit,
    cmValue,
    ftValue,
    inValue,
    heightCm,
    activityLevel,
    weightUnit,
    weightValue
  };
}

function validateStep(stepIndex, values) {
  if (!values) return "Unable to read setup form.";

  if (stepIndex === 0) {
    if (!values.age || values.age < 1 || values.age > 120) return "Enter a valid age between 1 and 120.";
    if (values.gender !== "male" && values.gender !== "female") return "Select a gender to continue.";
    return "";
  }

  if (stepIndex === 1) {
    if (!values.heightCm || values.heightCm <= 0) return "Enter a valid height.";

    if (!hasExistingWeightEntries()) {
      const weightKg = weightToKg(values.weightValue, values.weightUnit);
      if (!weightKg || weightKg <= 0) return "Enter a valid weight to continue.";
    }

    return "";
  }

  if (!values.activityLevel || !isValidActivityLevel(values.activityLevel)) {
    return "Select an activity level to continue.";
  }

  return "";
}

function getMaxUnlockedStep(values) {
  if (!values) return 0;

  let maxStep = 0;
  if (!validateStep(0, values)) {
    maxStep = 1;
    if (!validateStep(1, values)) {
      maxStep = 2;
    }
  }

  return maxStep;
}

function updateDoneVisibility(values) {
  const doneBtn = document.getElementById("calorie-setup-done");
  const doneSlot = document.getElementById("calorie-footer-done-slot");
  if (!doneBtn || !doneSlot) return;

  const hasSelection = !!(values && values.activityLevel && isValidActivityLevel(values.activityLevel));
  const shouldShow = currentStep === (STEP_COUNT - 1) && hasSelection;

  doneBtn.disabled = !shouldShow;
  doneSlot.classList.toggle("is-visible", shouldShow);
  doneSlot.setAttribute("aria-hidden", shouldShow ? "false" : "true");
}

function updateActivitySelection(activityLevel) {
  const input = document.getElementById("calorie-activity-level-input");
  if (!input) return;

  const nextValue = isValidActivityLevel(activityLevel) ? activityLevel : "";
  input.value = nextValue;
  renderActivityOptions(nextValue);

  const values = parseStepValues();
  updateDoneVisibility(values);
  updateStepStatus(values);

  if (currentStep === 2 && !validateStep(2, values)) {
    setError("");
  }
}

function updateStepStatus(valuesInput) {
  const values = valuesInput || parseStepValues();
  const label = document.getElementById("calorie-step-label");
  const dots = document.querySelectorAll("#calorie-step-dots .calorie-step-dot");

  if (label) label.textContent = `Step ${currentStep + 1} of ${STEP_COUNT}`;

  const maxUnlocked = getMaxUnlockedStep(values);

  for (let i = 0; i < dots.length; i += 1) {
    const isActive = i === currentStep;
    const isEnabled = i <= maxUnlocked || i <= currentStep;

    dots[i].classList.toggle("is-active", isActive);
    dots[i].classList.toggle("is-disabled", !isEnabled);
    dots[i].setAttribute("aria-current", isActive ? "step" : "false");
    dots[i].setAttribute("aria-disabled", isEnabled ? "false" : "true");
  }

  updateDoneVisibility(values);
}

function updateStepTrack() {
  const track = document.getElementById("calorie-step-track");
  if (!track) return;
  track.style.transform = `translate3d(-${currentStep * 100}%, 0, 0)`;
}

function setStep(stepIndex, valuesInput) {
  const bounded = Math.max(0, Math.min(STEP_COUNT - 1, stepIndex));
  currentStep = bounded;
  updateStepTrack();
  updateStepStatus(valuesInput);
}

function canNavigateToStep(targetStep, values, showError) {
  if (targetStep <= currentStep) return true;

  for (let i = 0; i < targetStep; i += 1) {
    const error = validateStep(i, values);
    if (error) {
      if (showError) {
        setError(error);
        setStep(i, values);
      }
      return false;
    }
  }

  return true;
}

function moveToStep(targetStep, showError = true) {
  const bounded = Math.max(0, Math.min(STEP_COUNT - 1, targetStep));
  if (bounded === currentStep) return;

  const values = parseStepValues();
  if (!values) return;

  if (!canNavigateToStep(bounded, values, showError)) {
    return;
  }

  setError("");
  setStep(bounded, values);
}

function handleLiveFormChange() {
  const values = parseStepValues();
  if (!values) return;

  updateStepStatus(values);

  const currentError = validateStep(currentStep, values);
  if (!currentError) {
    setError("");
  }
}

function setHeightUnit(unit) {
  const normalized = (unit === "ft-in") ? "ft-in" : "cm";
  const hidden = document.getElementById("calorie-height-unit");
  const cmField = document.getElementById("calorie-height-cm-field");
  const imperialField = document.getElementById("calorie-height-imperial-field");
  const cmInput = document.getElementById("calorie-height-cm-input");
  const ftInput = document.getElementById("calorie-height-ft-input");
  const inInput = document.getElementById("calorie-height-in-input");

  if (!hidden || !cmField || !imperialField || !cmInput || !ftInput || !inInput) return;

  const currentUnit = (hidden.value === "ft-in") ? "ft-in" : "cm";
  if (currentUnit !== normalized) {
    if (normalized === "ft-in") {
      const cm = parseNumber(cmInput.value);
      if (cm && cm > 0) {
        const converted = cmToFeetInches(cm);
        ftInput.value = String(converted.ft);
        inInput.value = String(converted.in);
      }
    } else {
      const ft = parseNumber(ftInput.value);
      const inches = parseNumber(inInput.value);
      const cm = feetInchesToCm(ft, inches);
      if (cm) {
        cmInput.value = String(roundToTwo(cm));
      }
    }
  }

  hidden.value = normalized;
  cmField.classList.toggle("hidden", normalized !== "cm");
  imperialField.classList.toggle("hidden", normalized !== "ft-in");

  const buttons = document.querySelectorAll("[data-height-unit]");
  for (let i = 0; i < buttons.length; i += 1) {
    buttons[i].classList.toggle("is-active", buttons[i].getAttribute("data-height-unit") === normalized);
  }

  handleLiveFormChange();
}

function setWeightUnit(unit) {
  const normalized = (unit === "lb") ? "lb" : "kg";
  const hidden = document.getElementById("calorie-weight-unit");
  const input = document.getElementById("calorie-weight-input");
  if (!hidden || !input) return;

  const currentUnit = (hidden.value === "lb") ? "lb" : "kg";

  if (currentUnit !== normalized) {
    const currentValue = parseNumber(input.value);
    if (currentValue && currentValue > 0) {
      if (currentUnit === "kg" && normalized === "lb") {
        const converted = currentValue / 0.45359237;
        input.value = String(roundToTwo(converted));
      } else if (currentUnit === "lb" && normalized === "kg") {
        const converted = currentValue * 0.45359237;
        input.value = String(roundToTwo(converted));
      }
    }
  }

  hidden.value = normalized;

  const buttons = document.querySelectorAll("[data-setup-weight-unit]");
  for (let i = 0; i < buttons.length; i += 1) {
    buttons[i].classList.toggle("is-active", buttons[i].getAttribute("data-setup-weight-unit") === normalized);
  }

  handleLiveFormChange();
}

function updateWeightSetupVisibility() {
  const section = document.getElementById("calorie-setup-weight-section");
  if (!section) return;
  section.classList.toggle("hidden", hasExistingWeightEntries());
}

function applyProfileToForm() {
  const state = latestState || loadState();
  const profile = state && state.user && state.user.calorieProfile ? state.user.calorieProfile : null;
  const preferences = getUserPreferences(state);

  const ageInput = document.getElementById("calorie-age-input");
  const genderInput = document.getElementById("calorie-gender-input");
  const cmInput = document.getElementById("calorie-height-cm-input");
  const ftInput = document.getElementById("calorie-height-ft-input");
  const inInput = document.getElementById("calorie-height-in-input");
  const weightInput = document.getElementById("calorie-weight-input");

  if (!ageInput || !genderInput || !cmInput || !ftInput || !inInput || !weightInput) return;

  const height = profile && profile.height ? profile.height : null;
  const heightCm = (height && height.heightCm) ? height.heightCm : null;
  const displayHeight = getHeightDisplay(heightCm, preferences.heightUnit);

  ageInput.value = profile && profile.age ? String(profile.age) : "";
  genderInput.value = profile && profile.gender ? profile.gender : "";

  cmInput.value = (displayHeight.cm && displayHeight.cm > 0) ? String(displayHeight.cm) : "";
  if (displayHeight.ft !== null && displayHeight.in !== null) {
    ftInput.value = String(displayHeight.ft);
    inInput.value = String(displayHeight.in);
  } else {
    ftInput.value = (height && Number.isFinite(height.ft)) ? String(height.ft) : "";
    inInput.value = (height && Number.isFinite(height.in)) ? String(height.in) : "";
  }

  updateActivitySelection(profile && profile.activityLevel ? profile.activityLevel : "");

  setHeightUnit(preferences.heightUnit);
  setWeightUnit(preferences.weightUnit);

  if (!hasExistingWeightEntries()) {
    weightInput.value = "";
  }

  setError("");
  setStep(0, parseStepValues());
  updateWeightSetupVisibility();
  handleLiveFormChange();
}

function openSetupModal() {
  const modal = document.getElementById("calorie-setup-modal");
  if (!modal) return;

  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }

  applyProfileToForm();
  modal.classList.remove("hidden");
  modal.classList.remove("is-closing");
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    modal.classList.add("is-open");
  });
}

function closeSetupModal() {
  const modal = document.getElementById("calorie-setup-modal");
  if (!modal || modal.classList.contains("hidden")) return;

  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
  }

  modal.classList.remove("is-open");
  modal.classList.add("is-closing");
  modal.setAttribute("aria-hidden", "true");

  closeTimer = window.setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("is-closing");
    closeTimer = null;
  }, 220);
}

function submitSetupForm() {
  const values = parseStepValues();
  if (!values) {
    setError("Unable to save setup details.");
    return;
  }

  for (let i = 0; i < STEP_COUNT; i += 1) {
    const validationError = validateStep(i, values);
    if (validationError) {
      setStep(i, values);
      setError(validationError);
      return;
    }
  }

  const roundedHeightCm = roundToTwo(values.heightCm);

  const profilePatch = {
    age: values.age,
    gender: values.gender,
    activityLevel: values.activityLevel,
    height: {
      unit: values.heightUnit,
      cm: values.heightUnit === "cm" ? roundedHeightCm : null,
      ft: values.heightUnit === "ft-in" ? Math.round(values.ftValue || 0) : null,
      in: values.heightUnit === "ft-in" ? Math.round(values.inValue || 0) : null,
      heightCm: roundedHeightCm
    }
  };

  setCalorieProfile(profilePatch);
  setUserPreferences({
    heightUnit: values.heightUnit,
    weightUnit: values.weightUnit
  });

  if (!hasExistingWeightEntries()) {
    addWeight(values.weightValue, values.weightUnit);
  }

  latestState = loadState();
  closeSetupModal();
  render(latestState);
}

function renderMissingDetails(state) {
  const missingList = document.getElementById("calories-missing-list");
  if (!missingList) return;

  const reasons = getCalorieMissingReasons(state);
  if (reasons.length === 0) {
    missingList.innerHTML = "";
    return;
  }

  const markup = [];
  for (let i = 0; i < reasons.length; i += 1) {
    const reason = reasons[i];
    const label = Object.prototype.hasOwnProperty.call(MISSING_REASON_LABELS, reason)
      ? MISSING_REASON_LABELS[reason]
      : "Complete missing setup data";
    markup.push(`<li>${label}</li>`);
  }

  missingList.innerHTML = markup.join("");
}

function bindSetupEvents() {
  const form = document.getElementById("calorie-setup-form");
  if (!form || form.dataset.bound === "1") return;

  form.dataset.bound = "1";

  const onValueChange = () => {
    handleLiveFormChange();
  };

  form.addEventListener("input", onValueChange);
  form.addEventListener("change", onValueChange);
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    if (event.defaultPrevented) return;

    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (target.tagName === "TEXTAREA") return;

    const currentStepElement = document.querySelector(`.calorie-step[data-calorie-step="${currentStep}"]`);
    if (!currentStepElement || !currentStepElement.contains(target)) return;

    event.preventDefault();
    advanceCurrentStep();
  });
}

function advanceCurrentStep() {
  const values = parseStepValues();
  if (!values) return false;

  const validationError = validateStep(currentStep, values);
  if (validationError) {
    setError(validationError);
    return false;
  }

  setError("");

  if (currentStep < STEP_COUNT - 1) {
    moveToStep(currentStep + 1, true);
    return true;
  }

  submitSetupForm();
  return true;
}

function bindSwipeGestures() {
  const viewport = document.getElementById("calorie-step-viewport");
  if (!viewport) return;
  if (viewport.dataset.swipeBound === "1") return;
  viewport.dataset.swipeBound = "1";

  viewport.addEventListener("touchstart", (event) => {
    if (!isModalOpen()) return;
    if (!event.touches || event.touches.length !== 1) return;

    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchTracking = true;
  }, { passive: true });

  viewport.addEventListener("touchend", (event) => {
    if (!touchTracking || !isModalOpen()) return;
    touchTracking = false;

    if (!event.changedTouches || event.changedTouches.length === 0) return;

    const dx = event.changedTouches[0].clientX - touchStartX;
    const dy = event.changedTouches[0].clientY - touchStartY;

    if (Math.abs(dx) < SWIPE_THRESHOLD) return;
    if (Math.abs(dx) <= Math.abs(dy)) return;

    if (dx < 0) {
      moveToStep(currentStep + 1, true);
    } else {
      moveToStep(currentStep - 1, false);
      setError("");
    }
  });

  viewport.addEventListener("touchcancel", () => {
    touchTracking = false;
  });
}

function updateCards(state) {
  const maintenanceCard = document.getElementById("calories-maintenance-card");
  const missingCard = document.getElementById("calories-missing-card");
  const metric = document.getElementById("calories-maintenance-value");
  const meta = document.getElementById("calories-maintenance-meta");
  const source = document.getElementById("calories-weight-source");

  if (!maintenanceCard || !missingCard || !metric || !meta || !source) return;

  const summary = calculateMaintenanceFromState(state);

  if (summary) {
    maintenanceCard.classList.remove("hidden");
    missingCard.classList.add("hidden");
    const preferences = getUserPreferences(state);

    metric.textContent = `${summary.maintenanceRounded} kcal/day`;
    meta.textContent = `BMR ${Math.round(summary.bmr)} kcal/day × activity multiplier.`;
    source.textContent = `Using latest logged weight: ${formatWeightWithUnit(summary.weightKg, preferences.weightUnit)}.`;
    return;
  }

  maintenanceCard.classList.add("hidden");
  missingCard.classList.remove("hidden");
  renderMissingDetails(state);
}

export function handleDocumentClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return false;

  const action = target.closest("[data-action]");
  if (action) {
    const actionName = action.getAttribute("data-action");

    if (actionName === "open-calorie-setup-modal") {
      openSetupModal();
      return true;
    }

    if (actionName === "close-calorie-setup-modal") {
      closeSetupModal();
      return true;
    }

    if (actionName === "go-calorie-step") {
      const index = parseInt(action.getAttribute("data-step-index"), 10);
      if (!Number.isNaN(index)) {
        const showError = index > currentStep;
        moveToStep(index, showError);
      }
      return true;
    }
  }

  const heightUnitBtn = target.closest("[data-height-unit]");
  if (heightUnitBtn) {
    setHeightUnit(heightUnitBtn.getAttribute("data-height-unit"));
    return true;
  }

  const weightUnitBtn = target.closest("[data-setup-weight-unit]");
  if (weightUnitBtn) {
    setWeightUnit(weightUnitBtn.getAttribute("data-setup-weight-unit"));
    return true;
  }

  const activityCard = target.closest("[data-activity-level]");
  if (activityCard && activityCard.closest("#calorie-activity-options")) {
    updateActivitySelection(activityCard.getAttribute("data-activity-level"));
    return true;
  }

  const modal = document.getElementById("calorie-setup-modal");
  if (target === modal) {
    closeSetupModal();
    return true;
  }

  return false;
}

export function handleSubmit(event) {
  const form = event.target;
  if (!form || form.id !== "calorie-setup-form") return false;

  event.preventDefault();
  if (currentStep < STEP_COUNT - 1) {
    advanceCurrentStep();
    return true;
  }

  submitSetupForm();
  return true;
}

export function handleEscape() {
  if (isModalOpen()) {
    closeSetupModal();
  }
}

export function resetViewUiState() {
  autoPromptedThisView = false;
  currentStep = 0;
  touchTracking = false;
  setError("");

  const modal = document.getElementById("calorie-setup-modal");
  if (!modal) return;

  if (closeTimer !== null) {
    window.clearTimeout(closeTimer);
    closeTimer = null;
  }

  modal.classList.remove("is-open");
  modal.classList.remove("is-closing");
  modal.classList.add("hidden");
  modal.setAttribute("aria-hidden", "true");
}

export function render(state) {
  const root = document.getElementById("calories-page-root");
  if (!root) return;

  latestState = state || loadState();
  if (!latestState.user) return;

  updateCards(latestState);
  bindSwipeGestures();
  bindSetupEvents();
  updateWeightSetupVisibility();

  const missingReasons = getCalorieMissingReasons(latestState);
  if (missingReasons.length > 0 && !isModalOpen() && !autoPromptedThisView) {
    autoPromptedThisView = true;
    openSetupModal();
  }
}
