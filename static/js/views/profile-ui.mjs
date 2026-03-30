import {
  avatarUrl,
  getUserPreferences,
  loadState,
  setCalorieProfile,
  setUserPreferences
} from "../modules/storage.mjs";
import {
  ACTIVITY_OPTIONS,
  calculateProteinMultiplierFromTarget,
  calculateProteinTargetGrams,
  cmToFeetInches,
  convertProteinMultiplierToCanonical,
  convertProteinMultiplierToDisplay,
  feetInchesToCm,
  getMacroGoalDefaults,
  formatActivityLevel,
  getLatestWeightKg
} from "../modules/calories-utils.mjs";
import { formatDate, formatWeightWithUnit, getHeightDisplay } from "../modules/data-utils.mjs";

let latestState = null;
let activityModalCloseTimer = null;
let pendingActivityLevel = "";

function isValidActivityLevel(activityLevel) {
  for (let i = 0; i < ACTIVITY_OPTIONS.length; i += 1) {
    if (ACTIVITY_OPTIONS[i].key === activityLevel) return true;
  }
  return false;
}

function parseNumber(value) {
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeProfileGender(gender) {
  return (gender === "male" || gender === "female") ? gender : "";
}

function normalizePreferenceHeightUnit(unit) {
  return (unit === "ft-in") ? "ft-in" : "cm";
}

function normalizePreferenceWeightUnit(unit) {
  return (unit === "lb") ? "lb" : "kg";
}

function normalizeProfileSegmentValue(inputId, value) {
  if (inputId === "profile-gender-input") return normalizeProfileGender(value);
  if (inputId === "profile-pref-height-unit") return normalizePreferenceHeightUnit(value);
  if (inputId === "profile-pref-weight-unit") return normalizePreferenceWeightUnit(value);
  return null;
}

function syncProfileSegmentedControl(inputId) {
  if (!inputId) return;

  const input = document.getElementById(inputId);
  const group = document.querySelector(`[data-profile-segment="${inputId}"]`);
  if (!input || !group) return;

  const options = group.querySelectorAll("[data-profile-segment-value]");
  let activeIndex = -1;
  for (let i = 0; i < options.length; i += 1) {
    const isActive = options[i].getAttribute("data-profile-segment-value") === input.value;
    options[i].classList.toggle("is-active", isActive);
    options[i].setAttribute("aria-checked", isActive ? "true" : "false");
    if (isActive) activeIndex = i;
  }
  group.setAttribute("data-active-index", String(activeIndex));
}

function setProfileSegmentValue(inputId, value) {
  const input = document.getElementById(inputId);
  if (!input) return false;

  const normalized = normalizeProfileSegmentValue(inputId, value);
  if (normalized === null) return false;

  const changed = input.value !== normalized;
  input.value = normalized;
  syncProfileSegmentedControl(inputId);
  return changed;
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function formatDecimal(value) {
  const normalized = roundToTwo(value);
  if (normalized === null) return "--";
  return normalized.toFixed(2).replace(/\.?0+$/, "");
}

function getCurrentMacroDefaults(state) {
  const goalObjective = state && state.user && state.user.calorieGoal
    ? state.user.calorieGoal.objective
    : null;
  return getMacroGoalDefaults(goalObjective);
}

function getProteinInputs() {
  return {
    multiplierInput: document.getElementById("profile-protein-multiplier-input"),
    multiplierUnit: document.getElementById("profile-protein-multiplier-unit"),
    targetInput: document.getElementById("profile-protein-target-input"),
    status: document.getElementById("profile-protein-status")
  };
}

function renderProteinStatus({ state, proteinMultiplierGPerKg }) {
  const { status } = getProteinInputs();
  if (!status) return;

  const preferences = getUserPreferences(state);
  const defaults = getCurrentMacroDefaults(state);
  const defaultDisplay = convertProteinMultiplierToDisplay(defaults.proteinMultiplierGPerKg, preferences.weightUnit);
  const latestWeightKg = getLatestWeightKg(state);

  if (!latestWeightKg) {
    status.textContent = `Current ${defaults.label} default is ${formatDecimal(defaultDisplay.value)} ${defaultDisplay.unit}. Log a body weight to unlock grams/day editing.`;
    return;
  }

  const currentDisplay = convertProteinMultiplierToDisplay(proteinMultiplierGPerKg, preferences.weightUnit);
  const proteinTarget = calculateProteinTargetGrams({
    weightKg: latestWeightKg,
    proteinMultiplierGPerKg
  });

  status.textContent = `Current ${defaults.label} default is ${formatDecimal(defaultDisplay.value)} ${defaultDisplay.unit}. Your active target is ${proteinTarget} g/day at ${formatDecimal(currentDisplay.value)} ${currentDisplay.unit}.`;
}

function renderProteinSettings(state) {
  const { multiplierInput, multiplierUnit, targetInput } = getProteinInputs();
  if (!multiplierInput || !multiplierUnit || !targetInput) return;

  const preferences = getUserPreferences(state);
  const latestWeightKg = getLatestWeightKg(state);
  const multiplierDisplay = convertProteinMultiplierToDisplay(
    preferences.proteinMultiplierGPerKg,
    preferences.weightUnit
  );
  const proteinTarget = calculateProteinTargetGrams({
    weightKg: latestWeightKg,
    proteinMultiplierGPerKg: preferences.proteinMultiplierGPerKg
  });

  multiplierInput.value = multiplierDisplay.value === null ? "" : formatDecimal(multiplierDisplay.value);
  multiplierUnit.textContent = multiplierDisplay.unit;
  targetInput.disabled = !latestWeightKg;
  targetInput.placeholder = latestWeightKg ? "e.g. 140" : "Log weight first";
  targetInput.value = latestWeightKg ? String(proteinTarget) : "";

  renderProteinStatus({
    state,
    proteinMultiplierGPerKg: preferences.proteinMultiplierGPerKg
  });
}

function previewProteinFromMultiplier() {
  const { multiplierInput, targetInput } = getProteinInputs();
  if (!multiplierInput || !targetInput) return;

  const state = latestState || loadState();
  const preferences = getUserPreferences(state);
  const latestWeightKg = getLatestWeightKg(state);
  const canonicalMultiplier = convertProteinMultiplierToCanonical(multiplierInput.value, preferences.weightUnit);

  if (canonicalMultiplier === null) return;

  if (latestWeightKg) {
    targetInput.value = String(calculateProteinTargetGrams({
      weightKg: latestWeightKg,
      proteinMultiplierGPerKg: canonicalMultiplier
    }));
  }

  renderProteinStatus({
    state,
    proteinMultiplierGPerKg: canonicalMultiplier
  });
}

function previewProteinFromTarget() {
  const { multiplierInput, targetInput } = getProteinInputs();
  if (!multiplierInput || !targetInput) return;

  const state = latestState || loadState();
  const preferences = getUserPreferences(state);
  const latestWeightKg = getLatestWeightKg(state);
  if (!latestWeightKg) return;

  const canonicalMultiplier = calculateProteinMultiplierFromTarget({
    weightKg: latestWeightKg,
    proteinTargetGrams: targetInput.value
  });
  if (canonicalMultiplier === null) return;

  const multiplierDisplay = convertProteinMultiplierToDisplay(canonicalMultiplier, preferences.weightUnit);
  multiplierInput.value = multiplierDisplay.value === null ? "" : formatDecimal(multiplierDisplay.value);
  renderProteinStatus({
    state,
    proteinMultiplierGPerKg: canonicalMultiplier
  });
}

function persistProteinSettings(sourceField) {
  const { multiplierInput, targetInput } = getProteinInputs();
  if (!multiplierInput || !targetInput) return false;

  const state = latestState || loadState();
  const preferences = getUserPreferences(state);
  const latestWeightKg = getLatestWeightKg(state);

  let canonicalMultiplier = null;
  if (sourceField === "target") {
    canonicalMultiplier = calculateProteinMultiplierFromTarget({
      weightKg: latestWeightKg,
      proteinTargetGrams: targetInput.value
    });
  } else {
    canonicalMultiplier = convertProteinMultiplierToCanonical(multiplierInput.value, preferences.weightUnit);
  }

  if (canonicalMultiplier === null) return false;

  latestState = setUserPreferences({ proteinMultiplierGPerKg: canonicalMultiplier });
  renderProteinSettings(latestState);
  return true;
}

function resetProteinGoalDefault() {
  const state = latestState || loadState();
  const defaults = getCurrentMacroDefaults(state);
  latestState = setUserPreferences({
    proteinMultiplierGPerKg: defaults.proteinMultiplierGPerKg
  });
  renderProteinSettings(latestState);
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

function setProfileHeightUnit(unit) {
  const normalized = (unit === "ft-in") ? "ft-in" : "cm";

  const unitInput = document.getElementById("profile-height-unit");
  const cmField = document.getElementById("profile-height-cm-field");
  const imperialField = document.getElementById("profile-height-imperial-field");
  const cmInput = document.getElementById("profile-height-cm-input");
  const ftInput = document.getElementById("profile-height-ft-input");
  const inInput = document.getElementById("profile-height-in-input");

  if (!unitInput || !cmField || !imperialField || !cmInput || !ftInput || !inInput) return;

  const current = (unitInput.value === "ft-in") ? "ft-in" : "cm";
  if (current !== normalized) {
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

  unitInput.value = normalized;
  cmField.classList.toggle("hidden", normalized !== "cm");
  imperialField.classList.toggle("hidden", normalized !== "ft-in");
}

function readCalorieProfileFromForm() {
  const ageInput = document.getElementById("profile-age-input");
  const genderInput = document.getElementById("profile-gender-input");
  const heightUnitInput = document.getElementById("profile-height-unit");
  const cmInput = document.getElementById("profile-height-cm-input");
  const ftInput = document.getElementById("profile-height-ft-input");
  const inInput = document.getElementById("profile-height-in-input");

  if (!ageInput || !genderInput || !heightUnitInput || !cmInput || !ftInput || !inInput) {
    return null;
  }

  const ageRaw = parseNumber(ageInput.value);
  const age = (ageRaw !== null && ageRaw >= 1 && ageRaw <= 120) ? Math.round(ageRaw) : null;

  const gender = (genderInput.value === "male" || genderInput.value === "female")
    ? genderInput.value
    : null;

  const unit = (heightUnitInput.value === "ft-in") ? "ft-in" : "cm";
  const cm = parseNumber(cmInput.value);
  const ft = parseNumber(ftInput.value);
  const inches = parseNumber(inInput.value);

  const heightCm = (unit === "cm")
    ? ((cm && cm > 0) ? cm : null)
    : feetInchesToCm(ft, inches);

  return {
    age,
    gender,
    height: {
      unit,
      cm: unit === "cm" && heightCm ? roundToTwo(heightCm) : null,
      ft: unit === "ft-in" && ft !== null ? Math.round(ft) : null,
      in: unit === "ft-in" && inches !== null ? Math.round(inches) : null,
      heightCm: heightCm ? roundToTwo(heightCm) : null
    }
  };
}

function renderLatestWeight(state) {
  const latestWeightEl = document.getElementById("profile-latest-weight");
  if (!latestWeightEl) return;

  const preferences = getUserPreferences(state);
  const latestWeightKg = getLatestWeightKg(state);

  if (!latestWeightKg) {
    latestWeightEl.textContent = "--";
    return;
  }
  latestWeightEl.textContent = formatWeightWithUnit(latestWeightKg, preferences.weightUnit);
}

function populateCalorieForm(profile, preferences) {
  const ageInput = document.getElementById("profile-age-input");
  const genderInput = document.getElementById("profile-gender-input");
  const cmInput = document.getElementById("profile-height-cm-input");
  const ftInput = document.getElementById("profile-height-ft-input");
  const inInput = document.getElementById("profile-height-in-input");

  if (!ageInput || !genderInput || !cmInput || !ftInput || !inInput) return;

  const height = profile && profile.height ? profile.height : null;
  const preferredUnit = preferences.heightUnit;
  const heightCm = (height && height.heightCm) ? height.heightCm : null;
  const displayHeight = getHeightDisplay(heightCm, preferredUnit);

  ageInput.value = profile && profile.age ? String(profile.age) : "";
  genderInput.value = normalizeProfileGender(profile && profile.gender ? profile.gender : "");
  syncProfileSegmentedControl("profile-gender-input");

  cmInput.value = (displayHeight.cm && displayHeight.cm > 0) ? String(displayHeight.cm) : "";

  if (displayHeight.ft !== null && displayHeight.in !== null) {
    ftInput.value = String(displayHeight.ft);
    inInput.value = String(displayHeight.in);
  } else {
    ftInput.value = (height && Number.isFinite(height.ft)) ? String(height.ft) : "";
    inInput.value = (height && Number.isFinite(height.in)) ? String(height.in) : "";
  }

  setProfileHeightUnit(preferredUnit);
}

function renderActivityText(activityLevel) {
  const text = document.getElementById("profile-activity-level-text");
  if (!text) return;
  text.textContent = formatActivityLevel(activityLevel);
}

function renderPreferences(preferences) {
  const heightInput = document.getElementById("profile-pref-height-unit");
  const weightInput = document.getElementById("profile-pref-weight-unit");

  if (heightInput) heightInput.value = normalizePreferenceHeightUnit(preferences.heightUnit);
  if (weightInput) weightInput.value = normalizePreferenceWeightUnit(preferences.weightUnit);
  syncProfileSegmentedControl("profile-pref-height-unit");
  syncProfileSegmentedControl("profile-pref-weight-unit");
}

function renderActivityOptions(selectedLevel) {
  const container = document.getElementById("profile-activity-options");
  if (!container) return;

  const cards = [];
  for (let i = 0; i < ACTIVITY_OPTIONS.length; i += 1) {
    const option = ACTIVITY_OPTIONS[i];
    const isSelected = option.key === selectedLevel;

    cards.push(`<button type="button" class="activity-option-card${isSelected ? " is-selected" : ""}" data-profile-activity-level="${option.key}" role="radio" aria-checked="${isSelected ? "true" : "false"}">
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

function isActivityModalOpen() {
  const modal = document.getElementById("profile-activity-modal");
  return !!(modal && !modal.classList.contains("hidden") && modal.classList.contains("is-open"));
}

function closeActivityModal() {
  const modal = document.getElementById("profile-activity-modal");
  if (!modal || modal.classList.contains("hidden")) return;

  if (activityModalCloseTimer !== null) {
    window.clearTimeout(activityModalCloseTimer);
    activityModalCloseTimer = null;
  }

  modal.classList.remove("is-open");
  modal.classList.add("is-closing");
  modal.setAttribute("aria-hidden", "true");

  activityModalCloseTimer = window.setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("is-closing");
    activityModalCloseTimer = null;
  }, 220);
}

function syncActivitySelection(level) {
  pendingActivityLevel = isValidActivityLevel(level) ? level : "";
  renderActivityOptions(pendingActivityLevel);

  const saveBtn = document.getElementById("profile-activity-save-btn");
  if (!saveBtn) return;
  saveBtn.disabled = !pendingActivityLevel;
}

function openActivityModal() {
  const modal = document.getElementById("profile-activity-modal");
  if (!modal) return;

  if (activityModalCloseTimer !== null) {
    window.clearTimeout(activityModalCloseTimer);
    activityModalCloseTimer = null;
  }

  const profile = latestState && latestState.user ? latestState.user.calorieProfile : null;
  syncActivitySelection(profile && profile.activityLevel ? profile.activityLevel : "");

  modal.classList.remove("hidden");
  modal.classList.remove("is-closing");
  modal.setAttribute("aria-hidden", "false");

  requestAnimationFrame(() => {
    modal.classList.add("is-open");
  });
}

function persistProfileFields() {
  const patch = readCalorieProfileFromForm();
  if (!patch) return;

  latestState = setCalorieProfile(patch);
  renderActivityText(latestState.user && latestState.user.calorieProfile
    ? latestState.user.calorieProfile.activityLevel
    : null);
}

function persistPreferences(preferencePatch) {
  latestState = setUserPreferences(preferencePatch);

  const preferences = getUserPreferences(latestState);
  const profile = latestState.user && latestState.user.calorieProfile
    ? latestState.user.calorieProfile
    : null;

  renderPreferences(preferences);
  populateCalorieForm(profile, preferences);
  renderLatestWeight(latestState);
  renderProteinSettings(latestState);
}

function saveActivityLevel() {
  if (!isValidActivityLevel(pendingActivityLevel)) return;

  latestState = setCalorieProfile({ activityLevel: pendingActivityLevel });
  renderActivityText(pendingActivityLevel);
  closeActivityModal();
}

function bindProfileEvents() {
  const root = document.getElementById("profile-page-root");
  if (!root || root.dataset.profileBound === "1") return;

  root.dataset.profileBound = "1";

  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;

    const action = target.closest("[data-action]");
    if (action) {
      const actionName = action.getAttribute("data-action");

      if (actionName === "open-profile-activity-modal") {
        openActivityModal();
        return;
      }

      if (actionName === "close-profile-activity-modal") {
        closeActivityModal();
        return;
      }

      if (actionName === "save-profile-activity") {
        saveActivityLevel();
        return;
      }

      if (actionName === "reset-protein-goal-default") {
        resetProteinGoalDefault();
        return;
      }
    }

    const activityCard = target.closest("[data-profile-activity-level]");
    if (activityCard) {
      syncActivitySelection(activityCard.getAttribute("data-profile-activity-level"));
      return;
    }

    const segmentedOption = target.closest("[data-profile-segment-value]");
    if (segmentedOption) {
      const segmentedGroup = segmentedOption.closest("[data-profile-segment]");
      const inputId = segmentedGroup ? segmentedGroup.getAttribute("data-profile-segment") : "";
      const nextValue = segmentedOption.getAttribute("data-profile-segment-value");
      if (!inputId || nextValue === null) return;

      const changed = setProfileSegmentValue(inputId, nextValue);
      if (!changed) return;

      if (inputId === "profile-gender-input") {
        persistProfileFields();
        return;
      }

      if (inputId === "profile-pref-height-unit") {
        persistProfileFields();
        persistPreferences({ heightUnit: normalizePreferenceHeightUnit(nextValue) });
        return;
      }

      if (inputId === "profile-pref-weight-unit") {
        persistPreferences({ weightUnit: normalizePreferenceWeightUnit(nextValue) });
      }
      return;
    }

    const activityModal = document.getElementById("profile-activity-modal");
    if (target === activityModal) {
      closeActivityModal();
    }
  });

  root.addEventListener("input", (event) => {
    const id = event.target && event.target.id;
    if (!id) return;

    if (id === "profile-age-input"
      || id === "profile-gender-input"
      || id === "profile-height-cm-input"
      || id === "profile-height-ft-input"
      || id === "profile-height-in-input") {
      persistProfileFields();
      return;
    }

    if (id === "profile-protein-multiplier-input") {
      previewProteinFromMultiplier();
      return;
    }

    if (id === "profile-protein-target-input") {
      previewProteinFromTarget();
    }
  });

  root.addEventListener("change", (event) => {
    const id = event.target && event.target.id;
    if (!id) return;

    if (id === "profile-age-input"
      || id === "profile-gender-input"
      || id === "profile-height-cm-input"
      || id === "profile-height-ft-input"
      || id === "profile-height-in-input") {
      persistProfileFields();
      return;
    }

    if (id === "profile-pref-height-unit") {
      const nextUnit = event.target.value === "ft-in" ? "ft-in" : "cm";
      persistProfileFields();
      persistPreferences({ heightUnit: nextUnit });
      return;
    }

    if (id === "profile-pref-weight-unit") {
      const nextUnit = event.target.value === "lb" ? "lb" : "kg";
      persistPreferences({ weightUnit: nextUnit });
      return;
    }

    if (id === "profile-protein-multiplier-input") {
      if (!persistProteinSettings("multiplier")) {
        renderProteinSettings(latestState || loadState());
      }
      return;
    }

    if (id === "profile-protein-target-input") {
      if (!persistProteinSettings("target")) {
        renderProteinSettings(latestState || loadState());
      }
    }
  });
}

export function renderNavAvatar(user) {
  const img = document.getElementById("nav-avatar");
  if (!img || !user || !user.name) return;
  img.src = avatarUrl(user.name);
}

export function handleEscape() {
  if (isActivityModalOpen()) {
    closeActivityModal();
  }
}

export function render(state) {
  const nameEl = document.getElementById("profile-name");
  if (!nameEl) return;

  latestState = state || loadState();
  const user = latestState && latestState.user ? latestState.user : null;
  if (!user) return;

  nameEl.textContent = user.name;

  const avatarEl = document.getElementById("profile-avatar");
  if (avatarEl) avatarEl.src = avatarUrl(user.name);

  const sinceEl = document.getElementById("profile-since");
  if (sinceEl) sinceEl.textContent = `Member since ${formatDate(user.createdAt)}`;

  const preferences = getUserPreferences(latestState);

  populateCalorieForm(user.calorieProfile, preferences);
  renderPreferences(preferences);
  renderLatestWeight(latestState);
  renderProteinSettings(latestState);
  renderActivityText(user.calorieProfile ? user.calorieProfile.activityLevel : null);
  syncProfileSegmentedControl("profile-gender-input");
  syncProfileSegmentedControl("profile-pref-height-unit");
  syncProfileSegmentedControl("profile-pref-weight-unit");
  bindProfileEvents();

  if (!isActivityModalOpen()) {
    const modal = document.getElementById("profile-activity-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("is-open", "is-closing");
      modal.setAttribute("aria-hidden", "true");
    }
  }
}
