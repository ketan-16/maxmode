import {
  avatarUrl,
  getAuthState,
  getUserPreferences,
  loadState,
  signIn,
  signOut,
  signUp,
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
import { createBodyScrollLock } from "../modules/scroll-lock.mjs";

let latestState = null;
let activityModalCloseTimer = null;
let authModalCloseTimer = null;
let pendingActivityLevel = "";
let profilePersistTimer = null;
let authFeedback = "";
let authSubmitting = false;
let authTouchStartY = 0;

function getProfileRoot() {
  return document.getElementById("profile-page-root");
}

function isMobileProfileUI() {
  const ua = navigator.userAgent || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  const isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
  if (isIpad) return true;

  const isTouchDevice = touchPoints > 0 || ("ontouchstart" in window);
  if (!isTouchDevice) return false;

  return window.matchMedia("(max-width: 1024px)").matches || /Android|iPhone|iPod|Mobile|Tablet/i.test(ua);
}

const authModalScrollLock = createBodyScrollLock({
  isMobileUi: isMobileProfileUI
});

function getAvatarGender(user) {
  const profile = user && user.calorieProfile ? user.calorieProfile : null;
  return profile && typeof profile.gender === "string" ? profile.gender : "";
}

function placeholderAvatar(size) {
  return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${size}' height='${size}'%3E%3Crect width='${size}' height='${size}' rx='${Math.round(size / 2)}' fill='%23e5e5ea'/%3E%3C/svg%3E`;
}

function renderAvatarImage(elementId, user, size = 96) {
  const img = document.getElementById(elementId);
  if (!img) return;
  if (!user || !user.name) {
    img.src = placeholderAvatar(size);
    return;
  }
  img.src = avatarUrl(user.name, getAvatarGender(user), size);
}

function renderProfileAvatar(user) {
  renderAvatarImage("profile-avatar", user, 144);
}

function renderAuthReminderBadge(authState) {
  const badge = document.getElementById("nav-auth-badge");
  if (!badge) return;
  const visible = !authState || authState.status !== "authenticated";
  badge.classList.toggle("is-visible", visible);
  badge.setAttribute("aria-hidden", visible ? "false" : "true");
}

function formatSyncStatus(authState) {
  if (!authState || authState.status !== "authenticated") {
    return "Create an account to sync your data across devices.";
  }
  if (authState.syncStatus === "syncing") {
    return "Syncing your latest changes.";
  }
  if (authState.syncStatus === "error") {
    return authState.lastSyncError || "We couldn't reach the server. Your local data is still safe on this device.";
  }
  if (authState.pendingMutationCount > 0) {
    return `${authState.pendingMutationCount} change${authState.pendingMutationCount === 1 ? "" : "s"} waiting to sync.`;
  }
  if (authState.lastSyncAt) {
    return `Last synced ${new Date(authState.lastSyncAt).toLocaleString()}.`;
  }
  if (authState.hasServerData) {
    return "Account connected and ready.";
  }
  return "You're signed in. Local data will sync once you add it.";
}

function setAuthFeedback(message) {
  authFeedback = message || "";
  const errorEl = document.getElementById("profile-auth-error");
  if (!errorEl) return;
  errorEl.textContent = authFeedback;
  errorEl.classList.toggle("hidden", !authFeedback);
}

function renderInlineAuthAction(authState) {
  const inlineEl = document.getElementById("profile-auth-inline");
  const inlineCopyEl = document.getElementById("profile-auth-inline-copy");
  const visible = authState.status !== "authenticated";

  if (inlineEl) {
    inlineEl.classList.toggle("hidden", !visible);
  }

  if (inlineCopyEl) {
    inlineCopyEl.textContent = "Sign in or create an account to sync this device and keep your progress backed up.";
  }
}

function renderAuthCard(state) {
  const authState = getAuthState(state);
  if (authState.status === "authenticated") {
    closeAuthModal(true);
  }

  const cardEl = document.getElementById("profile-auth-card");
  const guestEl = document.getElementById("profile-auth-guest");
  const memberEl = document.getElementById("profile-auth-member");
  const titleEl = document.getElementById("profile-auth-title");
  const copyEl = document.getElementById("profile-auth-copy");
  const pillEl = document.getElementById("profile-auth-badge-copy");
  const submitButton = document.getElementById("profile-auth-submit");
  const submitNoteEl = document.getElementById("profile-auth-submit-note");
  const emailDisplay = document.getElementById("profile-auth-email-display");
  const syncStatus = document.getElementById("profile-auth-sync-status");
  const authModeInput = document.getElementById("profile-auth-mode");
  const passwordInput = document.getElementById("profile-auth-password");
  const authMode = authModeInput ? normalizeAuthMode(authModeInput.value) : "signup";

  renderAuthReminderBadge(authState);
  renderInlineAuthAction(authState);

  if (cardEl) {
    cardEl.classList.toggle("hidden", authState.status !== "authenticated");
  }

  if (guestEl) guestEl.classList.toggle("hidden", authState.status === "authenticated");
  if (memberEl) memberEl.classList.toggle("hidden", authState.status !== "authenticated");

  if (titleEl) {
    titleEl.textContent = "Account";
  }

  if (copyEl) {
    copyEl.textContent = authState.status === "authenticated"
      ? "This device is connected to your account."
      : authMode === "signin"
        ? "Sign in to sync this device with your saved data."
        : "Create an account to sync this device and keep your data safe.";
  }

  if (pillEl) {
    pillEl.textContent = authState.status === "authenticated"
      ? "Connected"
      : authMode === "signin"
        ? "Existing account"
        : "New account";
  }

  if (submitButton) {
    submitButton.textContent = authSubmitting
      ? (authMode === "signin" ? "Signing in..." : "Creating account...")
      : (authMode === "signin" ? "Sign in" : "Create account");
    submitButton.disabled = authSubmitting;
  }

  if (submitNoteEl) {
    submitNoteEl.textContent = authMode === "signin"
      ? "Saved account data will sync after sign in."
      : "This device will sync after account creation.";
  }

  if (emailDisplay) {
    emailDisplay.textContent = authState.email || "--";
  }
  if (syncStatus) {
    syncStatus.textContent = formatSyncStatus(authState);
  }
  if (passwordInput) {
    passwordInput.autocomplete = (authModeInput && normalizeAuthMode(authModeInput.value) === "signin")
      ? "current-password"
      : "new-password";
  }

  setAuthFeedback(authFeedback || authState.lastError || "");
}

function isAuthModalOpen() {
  const modal = document.getElementById("profile-auth-modal");
  return !!(modal && !modal.classList.contains("hidden") && modal.classList.contains("is-open"));
}

function getAuthScrollableContainer(target) {
  if (!target || typeof target.closest !== "function") return null;
  return target.closest(".profile-auth-modal-body");
}

function shouldClampAuthScroll(scroller, deltaY) {
  if (!scroller) return true;
  if (scroller.scrollHeight <= scroller.clientHeight + 1) return true;

  const atTop = scroller.scrollTop <= 0;
  const atBottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 1;
  return (atTop && deltaY > 0) || (atBottom && deltaY < 0);
}

function handleAuthModalTouchStart(event) {
  if (!isAuthModalOpen()) return;
  authTouchStartY = event.touches && event.touches[0] ? event.touches[0].clientY : 0;
}

function handleAuthModalTouchMove(event) {
  if (!isAuthModalOpen()) return;

  const scroller = getAuthScrollableContainer(event.target);
  if (!scroller) {
    event.preventDefault();
    return;
  }

  const currentY = event.touches && event.touches[0] ? event.touches[0].clientY : authTouchStartY;
  const deltaY = currentY - authTouchStartY;
  if (shouldClampAuthScroll(scroller, deltaY)) {
    event.preventDefault();
  }
}

function handleAuthModalWheel(event) {
  if (!isAuthModalOpen()) return;

  const scroller = getAuthScrollableContainer(event.target);
  if (!scroller) {
    event.preventDefault();
    return;
  }

  if (shouldClampAuthScroll(scroller, event.deltaY)) {
    event.preventDefault();
  }
}

function closeAuthModal(immediate = false) {
  const modal = document.getElementById("profile-auth-modal");
  if (!modal) {
    authModalScrollLock.unlockNow();
    return;
  }

  if (authModalCloseTimer !== null) {
    window.clearTimeout(authModalCloseTimer);
    authModalCloseTimer = null;
  }

  if (immediate || modal.classList.contains("hidden")) {
    modal.classList.add("hidden");
    modal.classList.remove("is-open", "is-closing");
    modal.setAttribute("aria-hidden", "true");
    authModalScrollLock.unlockNow();
    return;
  }

  modal.classList.remove("is-open");
  modal.classList.add("is-closing");
  modal.setAttribute("aria-hidden", "true");

  authModalCloseTimer = window.setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("is-closing");
    authModalCloseTimer = null;
    authModalScrollLock.unlockAfterKeyboard();
  }, 220);
}

function openAuthModal(mode = "signup") {
  authFeedback = "";
  setProfileSegmentValue("profile-auth-mode", normalizeAuthMode(mode));
  renderAuthCard(latestState || loadState());

  const modal = document.getElementById("profile-auth-modal");
  if (!modal) return;

  if (authModalCloseTimer !== null) {
    window.clearTimeout(authModalCloseTimer);
    authModalCloseTimer = null;
  }

  modal.classList.remove("hidden");
  modal.classList.remove("is-closing");
  modal.setAttribute("aria-hidden", "false");
  authModalScrollLock.lock();

  requestAnimationFrame(() => {
    modal.classList.add("is-open");
  });

  const emailInput = document.getElementById("profile-auth-email");
  if (emailInput && typeof emailInput.focus === "function") {
    window.setTimeout(() => {
      emailInput.focus();
    }, 90);
  }
}

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

function normalizePreferenceAiCalculationMode(mode) {
  return (mode === "aggressive") ? "aggressive" : "balanced";
}

function normalizeAuthMode(mode) {
  return mode === "signin" ? "signin" : "signup";
}

function normalizeProfileSegmentValue(inputId, value) {
  if (inputId === "profile-gender-input") return normalizeProfileGender(value);
  if (inputId === "profile-pref-height-unit") return normalizePreferenceHeightUnit(value);
  if (inputId === "profile-pref-weight-unit") return normalizePreferenceWeightUnit(value);
  if (inputId === "profile-ai-calculation-mode") return normalizePreferenceAiCalculationMode(value);
  if (inputId === "profile-auth-mode") return normalizeAuthMode(value);
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
  const aiCalculationModeInput = document.getElementById("profile-ai-calculation-mode");

  if (heightInput) heightInput.value = normalizePreferenceHeightUnit(preferences.heightUnit);
  if (weightInput) weightInput.value = normalizePreferenceWeightUnit(preferences.weightUnit);
  if (aiCalculationModeInput) {
    aiCalculationModeInput.value = normalizePreferenceAiCalculationMode(preferences.aiCalculationMode);
  }
  syncProfileSegmentedControl("profile-pref-height-unit");
  syncProfileSegmentedControl("profile-pref-weight-unit");
  syncProfileSegmentedControl("profile-ai-calculation-mode");
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
  renderNavAvatar(latestState.user);
  renderProfileAvatar(latestState.user);
  renderActivityText(latestState.user && latestState.user.calorieProfile
    ? latestState.user.calorieProfile.activityLevel
    : null);
}

function queueProfileFieldsPersist() {
  if (profilePersistTimer !== null) {
    window.clearTimeout(profilePersistTimer);
  }

  profilePersistTimer = window.setTimeout(() => {
    profilePersistTimer = null;
    persistProfileFields();
  }, 180);
}

function flushQueuedProfileFieldsPersist() {
  if (profilePersistTimer !== null) {
    window.clearTimeout(profilePersistTimer);
    profilePersistTimer = null;
  }
  persistProfileFields();
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

async function submitAuthForm() {
  const emailInput = document.getElementById("profile-auth-email");
  const passwordInput = document.getElementById("profile-auth-password");
  const modeInput = document.getElementById("profile-auth-mode");
  if (!emailInput || !passwordInput || !modeInput || authSubmitting) return;

  const email = emailInput.value.trim();
  const password = passwordInput.value;
  if (!email || !password) {
    setAuthFeedback("Enter both your email and password.");
    return;
  }

  authSubmitting = true;
  authFeedback = "";
  renderAuthCard(latestState || loadState());

  try {
    if (normalizeAuthMode(modeInput.value) === "signin") {
      latestState = await signIn(email, password);
    } else {
      latestState = await signUp(email, password);
    }
    authFeedback = "";
    passwordInput.value = "";
  } catch (error) {
    authFeedback = error instanceof Error ? error.message : "Unable to update your account right now.";
  } finally {
    authSubmitting = false;
    render(latestState || loadState());
  }
}

async function handleProfileSignOut() {
  if (authSubmitting) return;
  authSubmitting = true;
  authFeedback = "";
  renderAuthCard(latestState || loadState());

  try {
    latestState = await signOut();
  } catch (error) {
    authFeedback = error instanceof Error ? error.message : "Unable to sign out right now.";
  } finally {
    authSubmitting = false;
    render(latestState || loadState());
  }
}

function bindProfileEvents() {
  const root = getProfileRoot();
  if (!root || root.dataset.profileBound === "1") return;

  root.dataset.profileBound = "1";

  const authModal = document.getElementById("profile-auth-modal");
  if (authModal
    && typeof authModal.addEventListener === "function"
    && authModal.dataset.profileScrollGuardBound !== "1") {
    authModal.dataset.profileScrollGuardBound = "1";
    authModal.addEventListener("touchstart", handleAuthModalTouchStart, { passive: true });
    authModal.addEventListener("touchmove", handleAuthModalTouchMove, { passive: false });
    authModal.addEventListener("wheel", handleAuthModalWheel, { passive: false });
  }

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

      if (actionName === "profile-open-auth-signin") {
        openAuthModal("signin");
        return;
      }

      if (actionName === "profile-open-auth-signup") {
        openAuthModal("signup");
        return;
      }

      if (actionName === "close-profile-auth-modal") {
        closeAuthModal();
        return;
      }

      if (actionName === "profile-sign-out") {
        handleProfileSignOut();
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
        return;
      }

      if (inputId === "profile-ai-calculation-mode") {
        persistPreferences({ aiCalculationMode: normalizePreferenceAiCalculationMode(nextValue) });
        return;
      }

      if (inputId === "profile-auth-mode") {
        authFeedback = "";
        renderAuthCard(latestState || loadState());
      }
      return;
    }

    const activityModal = document.getElementById("profile-activity-modal");
    if (target === activityModal) {
      closeActivityModal();
      return;
    }

    const authModal = document.getElementById("profile-auth-modal");
    if (target === authModal) {
      closeAuthModal();
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
      queueProfileFieldsPersist();
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
      flushQueuedProfileFieldsPersist();
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

  root.addEventListener("submit", (event) => {
    const form = event.target;
    if (!form || form.id !== "profile-auth-form") return;
    event.preventDefault();
    submitAuthForm();
  });
}

export function renderNavAvatar(user, authState = null) {
  renderAvatarImage("nav-avatar", user, 96);
  renderAuthReminderBadge(authState || getAuthState(latestState || loadState()));
}

export function handleEscape() {
  if (isAuthModalOpen()) {
    closeAuthModal();
    return;
  }

  if (isActivityModalOpen()) {
    closeActivityModal();
  }
}

function hideActivityModalImmediately() {
  const modal = document.getElementById("profile-activity-modal");
  if (activityModalCloseTimer !== null) {
    window.clearTimeout(activityModalCloseTimer);
    activityModalCloseTimer = null;
  }
  if (!modal) return;

  modal.classList.add("hidden");
  modal.classList.remove("is-open", "is-closing");
  modal.setAttribute("aria-hidden", "true");
}

export function resetViewUiState() {
  authFeedback = "";
  authSubmitting = false;
  hideActivityModalImmediately();
  closeAuthModal(true);
  authModalScrollLock.unlockNow();
}

export function render(state) {
  const nameEl = document.getElementById("profile-name");
  if (!nameEl) return;

  latestState = state || loadState();
  const user = latestState && latestState.user ? latestState.user : null;
  const authState = getAuthState(latestState);
  const fallbackName = authState.email ? authState.email.split("@")[0] : "Guest";

  nameEl.textContent = user && user.name ? user.name : fallbackName;

  renderNavAvatar(user, authState);
  renderProfileAvatar(user);
  renderAuthCard(latestState);

  const sinceEl = document.getElementById("profile-since");
  if (sinceEl) {
    sinceEl.textContent = user
      ? `Member since ${formatDate(user.createdAt)}`
      : (authState.status === "authenticated" ? "Signed in account" : "Local guest profile");
  }

  const preferences = getUserPreferences(latestState);

  populateCalorieForm(user ? user.calorieProfile : null, preferences);
  renderPreferences(preferences);
  renderLatestWeight(latestState);
  renderProteinSettings(latestState);
  renderActivityText(user && user.calorieProfile ? user.calorieProfile.activityLevel : null);
  syncProfileSegmentedControl("profile-gender-input");
  syncProfileSegmentedControl("profile-pref-height-unit");
  syncProfileSegmentedControl("profile-pref-weight-unit");
  syncProfileSegmentedControl("profile-ai-calculation-mode");
  syncProfileSegmentedControl("profile-auth-mode");
  bindProfileEvents();

  if (!isActivityModalOpen()) {
    const modal = document.getElementById("profile-activity-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("is-open", "is-closing");
      modal.setAttribute("aria-hidden", "true");
    }
  }

  if (!isAuthModalOpen()) {
    const modal = document.getElementById("profile-auth-modal");
    if (modal) {
      modal.classList.add("hidden");
      modal.classList.remove("is-open", "is-closing");
      modal.setAttribute("aria-hidden", "true");
    }
    authModalScrollLock.unlockNow();
  }
}
