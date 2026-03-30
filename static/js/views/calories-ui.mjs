import {
  addMeal,
  addWeight,
  getCalorieGoal,
  deleteMeal,
  getCalorieTrackerMeta,
  getMealById,
  getUserPreferences,
  loadState,
  setCalorieGoal,
  setCalorieProfile,
  setCalorieTrackerMeta,
  setUserPreferences,
  updateMeal
} from "../modules/storage.mjs";
import {
  ACTIVITY_OPTIONS,
  CALORIE_GOAL_OBJECTIVES,
  cmToFeetInches,
  feetInchesToCm,
  getCalorieGoalPreset,
  getCalorieGoalPresets,
  getCalorieMissingReasons,
  resolveCalorieGoalFromState,
  weightToKg
} from "../modules/calories-utils.mjs";
import { escapeHtml, formatTime, getHeightDisplay } from "../modules/data-utils.mjs";
import {
  buildCalorieTrackerSummary,
  clampPortion,
  getLocalDayKey
} from "../modules/meal-utils.mjs";
import { syncRangeInputVisual } from "../modules/slider-ui.mjs";

const STEP_COUNT = 3;
const GOAL_STEP_COUNT = 2;
const SWIPE_THRESHOLD = 56;
const OVERLAY_CLOSE_MS = 220;
const TOAST_VISIBLE_MS = 2400;
const FAB_LONG_PRESS_MS = 420;
const MAX_MANUAL_PHOTOS = 3;
const RECENT_FOOD_NAME_LIMIT = 28;
const MEAL_SWIPE_CONFIG = {
  SNAP_PX: 52,
  FULL_FRAC: 0.72,
  DAMP: 0.48,
  FLICK_VELOCITY: -0.45,
  OPEN_EXTRA_PX: 8,
  MIN_OPEN_PX: 150
};
const MEAL_ICONS = {
  MENU: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="5" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><circle cx="12" cy="19" r="1.6" fill="currentColor" stroke="none"></circle></svg>',
  EDIT: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"></path><path d="m16.5 3.5 4 4L7 21l-4 1 1-4Z"></path></svg>',
  CLONE: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>',
  DELETE: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"></path><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2"></path><path d="m19 6-1 13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path><path d="M10 11v6"></path><path d="M14 11v6"></path></svg>'
};
const GOAL_OBJECTIVE_META = {
  lose: {
    title: "Lose weight",
    badge: "Cutting",
    description: "Run a calorie deficit below TDEE to reduce body fat while protecting recovery."
  },
  maintain: {
    title: "Maintain",
    badge: "Maintenance",
    description: "Hold your current weight by matching calories to your daily energy needs."
  },
  gain: {
    title: "Gain weight",
    badge: "Bulking",
    description: "Use a calorie surplus above TDEE to support muscle growth and performance."
  }
};
const GOAL_MISSING_REASON_LABELS = {
  age: "Add your age",
  gender: "Choose your gender",
  height: "Enter your height",
  activityLevel: "Set your activity level",
  weight: "Log at least one body weight"
};

let currentStep = 0;
let goalCurrentStep = 0;
let selectedGoalObjective = "";
let selectedGoalPresetKey = "";
let latestState = null;
let closeTimers = new Map();
let touchStartX = 0;
let touchStartY = 0;
let touchTracking = false;
let toastTimer = null;
let toastHideTimer = null;
let manualPhotoFiles = [];
let manualEntryMode = "manual";
let previewDraft = null;
let previewMode = "create";
let fabLongPressTimer = null;
let fabLongPressHandled = false;
let fabMenuCloseTimer = null;
let voiceRecognition = null;
let pendingDeleteMealId = null;
let openMealSwipeRow = null;
let openMealMenuId = null;
let lastCaloriesUiMode = null;
let resizeFrame = null;
let deleteSheetTransitionCleanup = null;
let calorieOverlayScrollLocked = false;
let calorieOverlayScrollY = 0;
let calorieOverlayUnlockTimer = null;
let calorieOverlayViewportCleanup = null;

function parseNumber(value) {
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function formatCountLabel(count, singular, plural = null) {
  const normalized = Math.max(0, Math.round(count || 0));
  if (normalized === 1) return `1 ${singular}`;
  return `${normalized} ${plural || `${singular}s`}`;
}

function formatCalories(value) {
  const normalized = Math.max(0, Math.round(value || 0));
  return normalized.toLocaleString();
}

function formatDecimal(value) {
  const normalized = Math.round((value || 0) * 100) / 100;
  if (!Number.isFinite(normalized)) return "--";
  return normalized.toFixed(2).replace(/\.?0+$/, "");
}

function formatPercent(value) {
  const normalized = (typeof value === "number" && Number.isFinite(value)) ? (value * 100) : 0;
  return `${formatDecimal(normalized)}%`;
}

function formatSignedCalories(value) {
  const normalized = Math.round(value || 0);
  if (!normalized) return "0";
  return `${normalized > 0 ? "+" : "-"}${formatCalories(Math.abs(normalized))}`;
}

function truncateLabel(value, maxChars = RECENT_FOOD_NAME_LIMIT) {
  const normalized = (typeof value === "string") ? value.trim() : "";
  if (!normalized || normalized.length <= maxChars) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxChars)).trimEnd()}...`;
}

function createManualPhotoId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `photo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function formatMacroProgress(current, target) {
  return `${formatCalories(current)}/${formatCalories(target)}g`;
}

function setRadialProgress(layerName, ratio) {
  const segments = document.querySelectorAll(`[data-radial-layer="${layerName}"][data-radial-segment]`);
  if (!segments.length) return;

  const boundedRatio = Math.max(0, Math.min(1, ratio || 0));
  const activeCount = boundedRatio > 0
    ? Math.max(1, Math.ceil(boundedRatio * segments.length))
    : 0;

  for (let i = 0; i < segments.length; i += 1) {
    segments[i].classList.toggle("is-active", i < activeCount);
  }
}

function clearTimer(timer) {
  if (timer !== null) {
    window.clearTimeout(timer);
  }
}

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/([\\\"'])/g, "\\$1");
}

function parseCssTimeMs(rawValue) {
  if (!rawValue) return 0;

  const value = String(rawValue).trim();
  if (!value) return 0;

  if (value.slice(-2) === "ms") {
    const millis = parseFloat(value.slice(0, -2));
    return Number.isFinite(millis) ? millis : 0;
  }

  if (value.slice(-1) === "s") {
    const seconds = parseFloat(value.slice(0, -1));
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }

  return 0;
}

function getMaxTransitionMs(element) {
  if (!element) return 0;

  const style = window.getComputedStyle(element);
  const durations = String(style.transitionDuration || "").split(",");
  const delays = String(style.transitionDelay || "").split(",");
  const total = Math.max(durations.length, delays.length);
  let maxMs = 0;

  for (let i = 0; i < total; i += 1) {
    const duration = parseCssTimeMs(durations[i % durations.length]);
    const delay = parseCssTimeMs(delays[i % delays.length]);
    if ((duration + delay) > maxMs) {
      maxMs = duration + delay;
    }
  }

  return maxMs;
}

function onTransitionEndOrTimeout(element, fallbackMs, callback) {
  if (!element || typeof callback !== "function") {
    return () => {};
  }

  let done = false;
  let timer = null;

  function finish() {
    if (done) return;
    done = true;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    element.removeEventListener("transitionend", onEnd);
    callback();
  }

  function onEnd(event) {
    if (event.target !== element) return;
    finish();
  }

  element.addEventListener("transitionend", onEnd);
  timer = window.setTimeout(finish, Math.max(24, Math.ceil(fallbackMs)));

  return function cleanup() {
    if (done) return;
    done = true;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    element.removeEventListener("transitionend", onEnd);
  };
}

function setDeleteSheetOpenState(isOpen) {
  if (!document.body) return;
  document.body.classList.toggle("is-delete-sheet-open", !!isOpen);
}

function clearDeleteSheetTransitionWatcher() {
  if (typeof deleteSheetTransitionCleanup === "function") {
    const cleanup = deleteSheetTransitionCleanup;
    deleteSheetTransitionCleanup = null;
    cleanup();
  }
}

function clearCalorieOverlayUnlockWaiters() {
  if (calorieOverlayUnlockTimer !== null) {
    window.clearTimeout(calorieOverlayUnlockTimer);
    calorieOverlayUnlockTimer = null;
  }

  if (typeof calorieOverlayViewportCleanup === "function") {
    const cleanup = calorieOverlayViewportCleanup;
    calorieOverlayViewportCleanup = null;
    cleanup();
  }
}

function lockCalorieOverlayScroll() {
  clearCalorieOverlayUnlockWaiters();
  if (calorieOverlayScrollLocked || !document.body) return;

  calorieOverlayScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add("modal-scroll-locked");
  document.body.style.top = `-${calorieOverlayScrollY}px`;
  calorieOverlayScrollLocked = true;
}

function unlockCalorieOverlayScrollNow() {
  clearCalorieOverlayUnlockWaiters();
  if (!calorieOverlayScrollLocked || !document.body) return;

  const restoreY = calorieOverlayScrollY;
  document.body.classList.remove("modal-scroll-locked");
  document.body.style.top = "";
  window.scrollTo(0, restoreY);
  requestAnimationFrame(() => {
    window.scrollTo(0, restoreY);
  });

  calorieOverlayScrollLocked = false;
}

function unlockCalorieOverlayScrollAfterKeyboard() {
  clearCalorieOverlayUnlockWaiters();
  if (!calorieOverlayScrollLocked) return;

  if (window.visualViewport && isMobileCaloriesUI()) {
    const viewport = window.visualViewport;
    const deadlineTs = Date.now() + 420;

    function finalizeUnlock() {
      unlockCalorieOverlayScrollNow();
    }

    function queueUnlock() {
      if (calorieOverlayUnlockTimer !== null) {
        window.clearTimeout(calorieOverlayUnlockTimer);
      }

      const msLeft = deadlineTs - Date.now();
      const delay = msLeft <= 0 ? 0 : Math.min(120, msLeft);
      calorieOverlayUnlockTimer = window.setTimeout(finalizeUnlock, delay);
    }

    function onViewportChange() {
      queueUnlock();
    }

    viewport.addEventListener("resize", onViewportChange);
    viewport.addEventListener("scroll", onViewportChange);
    calorieOverlayViewportCleanup = () => {
      viewport.removeEventListener("resize", onViewportChange);
      viewport.removeEventListener("scroll", onViewportChange);
    };

    queueUnlock();
    return;
  }

  unlockCalorieOverlayScrollNow();
}

function hasVisibleCalorieOverlay() {
  const overlayIds = [
    "calorie-macro-modal",
    "calorie-manual-modal",
    "calorie-preview-modal",
    "calorie-goal-modal",
    "calorie-setup-modal"
  ];

  for (let i = 0; i < overlayIds.length; i += 1) {
    const overlay = document.getElementById(overlayIds[i]);
    if (overlay && !overlay.classList.contains("hidden")) {
      return true;
    }
  }

  return false;
}

function syncCalorieOverlayUiState() {
  const root = document.getElementById("calories-page-root");
  const isOpen = hasVisibleCalorieOverlay();

  if (root) {
    root.classList.toggle("is-overlay-open", isOpen);
  }

  if (isOpen) {
    closeFabMenu();
    lockCalorieOverlayScroll();
    return;
  }

  unlockCalorieOverlayScrollAfterKeyboard();
}

function isMobileCaloriesUI() {
  const ua = navigator.userAgent || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  const isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
  if (isIpad) return false;

  const isTouchDevice = touchPoints > 0 || ("ontouchstart" in window);
  if (!isTouchDevice) return false;

  return window.matchMedia("(max-width: 1024px)").matches || /Android|iPhone|iPod|Mobile|Tablet/i.test(ua);
}

function closeOpenMealSwipeRow() {
  if (openMealSwipeRow && typeof openMealSwipeRow._close === "function") {
    openMealSwipeRow._close();
  }
  openMealSwipeRow = null;
}

function closeOpenMealMenu() {
  if (!openMealMenuId) return;

  const escapedId = cssEscape(openMealMenuId);
  const menu = document.querySelector(`[data-meal-menu="${escapedId}"]`);
  const trigger = document.querySelector(`[data-meal-menu-toggle="${escapedId}"]`);
  const card = menu ? menu.closest(".meal-feed-card") : null;

  if (menu) menu.classList.remove("open");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  if (card) card.classList.remove("is-menu-open");
  openMealMenuId = null;
}

function toggleMealMenu(mealId) {
  if (!mealId) return;

  if (openMealMenuId === mealId) {
    closeOpenMealMenu();
    return;
  }

  closeOpenMealSwipeRow();
  closeOpenMealMenu();

  const escapedId = cssEscape(mealId);
  const menu = document.querySelector(`[data-meal-menu="${escapedId}"]`);
  const trigger = document.querySelector(`[data-meal-menu-toggle="${escapedId}"]`);
  const card = menu ? menu.closest(".meal-feed-card") : null;

  if (!menu || !trigger) return;

  menu.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  if (card) card.classList.add("is-menu-open");
  openMealMenuId = mealId;
}

function openMealDeleteSheet(mealId) {
  if (!mealId) return;

  const sheet = document.getElementById("calorie-delete-sheet");
  if (!sheet) {
    if (confirm("Delete this meal?")) {
      if (!deleteMeal(mealId)) return;
      latestState = loadState();
      renderTrackerView(latestState);
      showToast("Meal deleted");
    }
    return;
  }

  pendingDeleteMealId = mealId;
  closeOpenMealMenu();
  closeOpenMealSwipeRow();
  clearDeleteSheetTransitionWatcher();

  sheet.classList.remove("hidden");
  sheet.classList.remove("is-closing");
  sheet.setAttribute("aria-hidden", "false");
  setDeleteSheetOpenState(true);

  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
  });
}

function closeMealDeleteSheet(shouldClearPending = true) {
  const sheet = document.getElementById("calorie-delete-sheet");

  if (shouldClearPending) {
    pendingDeleteMealId = null;
  }

  clearDeleteSheetTransitionWatcher();
  if (!sheet) {
    setDeleteSheetOpenState(false);
    return;
  }

  if (sheet.classList.contains("hidden")) {
    sheet.classList.remove("is-closing");
    sheet.setAttribute("aria-hidden", "true");
    setDeleteSheetOpenState(false);
    return;
  }

  sheet.classList.remove("is-open");
  sheet.classList.add("is-closing");
  sheet.setAttribute("aria-hidden", "true");

  const panel = sheet.querySelector(".weight-delete-sheet-panel") || sheet;
  const backdrop = sheet.querySelector(".weight-delete-sheet-backdrop");
  const closeMs = Math.max(getMaxTransitionMs(panel), getMaxTransitionMs(backdrop), getMaxTransitionMs(sheet)) + 48;

  deleteSheetTransitionCleanup = onTransitionEndOrTimeout(panel, closeMs, () => {
    deleteSheetTransitionCleanup = null;
    if (sheet.classList.contains("is-open")) return;
    sheet.classList.remove("is-closing");
    sheet.classList.add("hidden");
    setDeleteSheetOpenState(false);
  });
}

function confirmDeleteMeal() {
  const deletingId = pendingDeleteMealId;
  if (!deletingId) return;

  closeMealDeleteSheet(false);
  pendingDeleteMealId = null;

  if (!deleteMeal(deletingId)) return;
  latestState = loadState();
  renderTrackerView(latestState);
  showToast("Meal deleted");
}

function getOverlayElement(id) {
  return document.getElementById(id);
}

function isOverlayOpen(id) {
  const overlay = getOverlayElement(id);
  return !!(overlay && overlay.classList.contains("is-open") && !overlay.classList.contains("hidden"));
}

function hideOverlayImmediately(id) {
  const overlay = getOverlayElement(id);
  if (!overlay) return;

  clearTimer(closeTimers.get(id) || null);
  closeTimers.delete(id);
  overlay.classList.remove("is-open");
  overlay.classList.remove("is-closing");
  overlay.classList.add("hidden");
  overlay.setAttribute("aria-hidden", "true");
  syncCalorieOverlayUiState();
}

function openOverlay(id) {
  const overlay = getOverlayElement(id);
  if (!overlay) return;

  clearTimer(closeTimers.get(id) || null);
  closeTimers.delete(id);
  overlay.classList.remove("hidden");
  overlay.classList.remove("is-closing");
  overlay.setAttribute("aria-hidden", "false");
  syncCalorieOverlayUiState();
  requestAnimationFrame(() => {
    overlay.classList.add("is-open");
  });
}

function closeOverlay(id) {
  const overlay = getOverlayElement(id);
  if (!overlay || overlay.classList.contains("hidden")) return;

  clearTimer(closeTimers.get(id) || null);
  overlay.classList.remove("is-open");
  overlay.classList.add("is-closing");
  overlay.setAttribute("aria-hidden", "true");

  const timer = window.setTimeout(() => {
    overlay.classList.add("hidden");
    overlay.classList.remove("is-closing");
    closeTimers.delete(id);
    syncCalorieOverlayUiState();
  }, OVERLAY_CLOSE_MS);

  closeTimers.set(id, timer);
}

function closeTrackerOverlays(exceptId = "") {
  const overlays = [
    "calorie-macro-modal",
    "calorie-manual-modal",
    "calorie-preview-modal",
    "calorie-goal-modal"
  ];

  for (let i = 0; i < overlays.length; i += 1) {
    if (overlays[i] === exceptId) continue;
    closeOverlay(overlays[i]);
  }
}

function clearToastTimers() {
  clearTimer(toastTimer);
  clearTimer(toastHideTimer);
  toastTimer = null;
  toastHideTimer = null;
}

function hideToast() {
  const toast = document.getElementById("calories-page-toast");
  if (!toast) return;

  clearToastTimers();
  toast.classList.remove("is-visible");
  toastHideTimer = window.setTimeout(() => {
    toast.classList.add("hidden");
    toastHideTimer = null;
  }, 180);
}

function showToast(message) {
  const toast = document.getElementById("calories-page-toast");
  if (!toast || !message) return;

  clearToastTimers();
  toast.textContent = message;
  toast.classList.remove("hidden");
  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });

  toastTimer = window.setTimeout(() => {
    hideToast();
  }, TOAST_VISIBLE_MS);
}

function stopVoiceRecognition() {
  if (!voiceRecognition) return;
  const current = voiceRecognition;
  voiceRecognition = null;
  try {
    current.onresult = null;
    current.onerror = null;
    current.onend = null;
    current.stop();
  } catch (_err) {
    // Ignore cleanup failures from browser-specific speech APIs.
  }
}

function showVoiceStatus(message) {
  const card = document.getElementById("calorie-voice-status");
  const label = document.getElementById("calorie-voice-status-label");
  if (!card || !label) return;
  label.textContent = message || "Listening...";
  card.classList.remove("hidden");
}

function hideVoiceStatus() {
  const card = document.getElementById("calorie-voice-status");
  if (!card) return;
  card.classList.add("hidden");
}

function setManualError(message) {
  const errorEl = document.getElementById("calorie-manual-error");
  if (!errorEl) return;
  errorEl.textContent = message || "";
}

function setPreviewError(message) {
  const errorEl = document.getElementById("calorie-preview-error");
  if (!errorEl) return;
  errorEl.textContent = message || "";
}

function setSetupError(message) {
  const errorEl = document.getElementById("calorie-setup-error");
  if (!errorEl) return;
  errorEl.textContent = message || "";
}

function setGoalError(message) {
  const errorEl = document.getElementById("calorie-goal-error");
  if (!errorEl) return;
  errorEl.textContent = message || "";
}

function setManualBusy(isBusy) {
  const submitBtn = document.getElementById("calorie-manual-submit");
  const description = document.getElementById("calorie-manual-description");
  const photoInput = document.getElementById("calorie-manual-photo-input");
  const choosePhotoBtn = document.querySelector('[data-action="choose-manual-photo"]');
  const photoRemoveButtons = document.querySelectorAll(".calories-photo-remove");
  if (submitBtn) {
    submitBtn.disabled = isBusy;
    submitBtn.textContent = isBusy ? "Analyzing..." : "Analyze meal";
  }
  if (description) description.disabled = isBusy;
  if (photoInput) photoInput.disabled = isBusy;
  if (choosePhotoBtn) choosePhotoBtn.disabled = isBusy;
  for (let i = 0; i < photoRemoveButtons.length; i += 1) {
    photoRemoveButtons[i].disabled = isBusy;
  }
}

function setPreviewLoading(isLoading) {
  const loading = document.getElementById("calorie-preview-loading");
  const nameInput = document.getElementById("calorie-preview-name");
  const slider = document.getElementById("calorie-portion-slider");
  const submitBtn = document.getElementById("calorie-preview-submit");
  const deleteBtn = document.getElementById("calorie-preview-delete");

  if (loading) loading.classList.toggle("hidden", !isLoading);
  if (nameInput) nameInput.disabled = isLoading;
  if (slider) slider.disabled = isLoading;
  if (submitBtn) submitBtn.disabled = isLoading;
  if (deleteBtn) deleteBtn.disabled = isLoading;
}

function setFabMenuOpen(isOpen) {
  const menu = document.getElementById("calories-fab-menu");
  const toggle = document.getElementById("calories-fab-more");
  if (!menu || !toggle) return;

  if (fabMenuCloseTimer !== null) {
    window.clearTimeout(fabMenuCloseTimer);
    fabMenuCloseTimer = null;
  }

  if (isOpen) {
    menu.classList.remove("hidden");
    menu.classList.remove("is-closing");
    menu.setAttribute("aria-hidden", "false");
    toggle.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => {
      menu.classList.add("is-open");
    });
    return;
  }

  menu.setAttribute("aria-hidden", "true");
  toggle.setAttribute("aria-expanded", "false");

  if (menu.classList.contains("hidden")) return;

  const prefersReducedMotion = typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const closeDelay = prefersReducedMotion ? 1 : 180;

  menu.classList.remove("is-open");
  menu.classList.add("is-closing");

  fabMenuCloseTimer = window.setTimeout(() => {
    menu.classList.add("hidden");
    menu.classList.remove("is-closing");
    fabMenuCloseTimer = null;
  }, closeDelay);
}

function closeFabMenu() {
  setFabMenuOpen(false);
}

function toggleFabMenu() {
  const menu = document.getElementById("calories-fab-menu");
  if (!menu) return;
  setFabMenuOpen(menu.classList.contains("hidden"));
}

function triggerScanPicker() {
  const input = document.getElementById("calorie-scan-input");
  if (!input) return;
  closeFabMenu();
  input.click();
}

function renderManualPhotoPreviews() {
  const list = document.getElementById("calorie-manual-photo-list");
  if (!list) return;

  if (!manualPhotoFiles.length) {
    list.innerHTML = "";
    list.classList.add("hidden");
    return;
  }

  const markup = new Array(manualPhotoFiles.length);
  for (let i = 0; i < manualPhotoFiles.length; i += 1) {
    const photo = manualPhotoFiles[i];
    markup[i] = `<div class="calories-photo-thumb">
      <img src="${escapeHtml(photo.url)}" alt="${escapeHtml(photo.file.name || "Meal photo")}">
      <button type="button"
              class="calories-photo-remove"
              data-action="remove-manual-photo"
              data-photo-id="${escapeHtml(photo.id)}"
              aria-label="Remove ${escapeHtml(photo.file.name || "photo")}">
        <span aria-hidden="true">x</span>
      </button>
    </div>`;
  }

  list.innerHTML = markup.join("");
  list.classList.remove("hidden");
}

function revokeManualPhotoPreviews() {
  for (let i = 0; i < manualPhotoFiles.length; i += 1) {
    const item = manualPhotoFiles[i];
    if (item && item.url && window.URL && typeof window.URL.revokeObjectURL === "function") {
      window.URL.revokeObjectURL(item.url);
    }
  }
  manualPhotoFiles = [];
  renderManualPhotoPreviews();
}

function addManualPhotos(fileList) {
  const files = Array.isArray(fileList) ? fileList : Array.from(fileList || []);
  if (!files.length) return;

  let hitLimit = false;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i];
    if (!file || !String(file.type || "").startsWith("image/")) continue;

    if (manualPhotoFiles.length >= MAX_MANUAL_PHOTOS) {
      hitLimit = true;
      break;
    }

    const url = window.URL && typeof window.URL.createObjectURL === "function"
      ? window.URL.createObjectURL(file)
      : "";

    manualPhotoFiles.push({
      id: createManualPhotoId(),
      file,
      url
    });
  }

  renderManualPhotoPreviews();

  if (hitLimit) {
    showToast("You can add up to 3 photos.");
  }
}

function removeManualPhoto(photoId) {
  if (!photoId) return;

  const nextFiles = [];
  for (let i = 0; i < manualPhotoFiles.length; i += 1) {
    const item = manualPhotoFiles[i];
    if (item.id !== photoId) {
      nextFiles.push(item);
      continue;
    }

    if (item.url && window.URL && typeof window.URL.revokeObjectURL === "function") {
      window.URL.revokeObjectURL(item.url);
    }
  }

  manualPhotoFiles = nextFiles;
  renderManualPhotoPreviews();
}

function resetManualComposer() {
  const description = document.getElementById("calorie-manual-description");
  const photoInput = document.getElementById("calorie-manual-photo-input");

  revokeManualPhotoPreviews();
  manualEntryMode = "manual";

  if (description) description.value = "";
  if (photoInput) photoInput.value = "";

  stopVoiceRecognition();
  hideVoiceStatus();
  setManualError("");
  setManualBusy(false);
}

function openManualModal(mode = "manual") {
  manualEntryMode = mode === "voice" ? "voice" : "manual";
  if (mode !== "voice") {
    stopVoiceRecognition();
    hideVoiceStatus();
  }
  closeTrackerOverlays("calorie-manual-modal");
  openOverlay("calorie-manual-modal");
}

function closeManualModal() {
  stopVoiceRecognition();
  hideVoiceStatus();
  closeOverlay("calorie-manual-modal");
}

function buildPreviewDraft(meal, mode = "create") {
  const portion = clampPortion(meal && meal.portion ? meal.portion : 1);
  const baseCalories = Math.max(0, Math.round((meal && meal.baseCalories) || (meal && meal.calories) || 0));
  const baseProtein = Math.max(0, Math.round((meal && meal.baseProtein) || (meal && meal.protein) || 0));
  const baseCarbs = Math.max(0, Math.round((meal && meal.baseCarbs) || (meal && meal.carbs) || 0));
  const baseFat = Math.max(0, Math.round((meal && meal.baseFat) || (meal && meal.fat) || 0));

  return {
    id: meal && meal.id ? meal.id : null,
    mode,
    source: meal && meal.source ? meal.source : "manual",
    confidence: meal && meal.confidence ? meal.confidence : "medium",
    name: meal && meal.name ? meal.name : "Meal",
    loggedAt: meal && meal.loggedAt ? meal.loggedAt : null,
    portion,
    baseCalories,
    baseProtein,
    baseCarbs,
    baseFat
  };
}

function getPreviewSourceLabel(source) {
  if (source === "scan") return "AI Food Scan";
  if (source === "voice") return "Voice Estimate";
  if (source === "recent") return "Recent Food";
  return "AI Result";
}

function getConfidenceCopy(confidence) {
  if (confidence === "high") return "High confidence estimate";
  if (confidence === "low") return "Low confidence estimate";
  return "Medium confidence estimate";
}

function getPreviewSliderPortion(slider, fallback = 1) {
  if (!slider) return fallback;

  const liveValue = parseNumber(slider.dataset ? slider.dataset.appleSliderLiveValue : null);
  const currentValue = liveValue !== null ? liveValue : parseNumber(slider.value);
  const min = parseNumber(slider.min);
  const max = parseNumber(slider.max);
  let portion = currentValue !== null ? currentValue : fallback;

  if (min !== null) portion = Math.max(min, portion);
  if (max !== null) portion = Math.min(max, portion);

  return clampPortion(portion) || fallback;
}

function scalePreviewNutritionLive(baseValues, portion = 1) {
  const normalizedPortion = Math.max(0, portion || 0);
  const baseCalories = Math.max(0, Math.round((baseValues && baseValues.baseCalories) || 0));
  const baseProtein = Math.max(0, Math.round((baseValues && baseValues.baseProtein) || 0));
  const baseCarbs = Math.max(0, Math.round((baseValues && baseValues.baseCarbs) || 0));
  const baseFat = Math.max(0, Math.round((baseValues && baseValues.baseFat) || 0));

  return {
    portion: normalizedPortion,
    calories: Math.max(0, Math.round(baseCalories * normalizedPortion)),
    protein: Math.max(0, Math.round(baseProtein * normalizedPortion)),
    carbs: Math.max(0, Math.round(baseCarbs * normalizedPortion)),
    fat: Math.max(0, Math.round(baseFat * normalizedPortion))
  };
}

function updatePreviewMetrics() {
  if (!previewDraft) return;

  const nameInput = document.getElementById("calorie-preview-name");
  const slider = document.getElementById("calorie-portion-slider");
  const portionValue = document.getElementById("calorie-portion-value");
  const caloriesValue = document.getElementById("calorie-preview-calories");
  const proteinValue = document.getElementById("calorie-preview-protein");
  const carbsValue = document.getElementById("calorie-preview-carbs");
  const fatValue = document.getElementById("calorie-preview-fat");

  const portion = getPreviewSliderPortion(slider, previewDraft.portion);
  const scaled = scalePreviewNutritionLive(previewDraft, portion);
  previewDraft.portion = portion;

  if (nameInput) {
    previewDraft.name = nameInput.value.trim() || previewDraft.name;
  }

  syncRangeInputVisual(slider);

  if (portionValue) portionValue.textContent = `${portion}x`;
  if (caloriesValue) caloriesValue.textContent = formatCalories(scaled.calories);
  if (proteinValue) proteinValue.textContent = `${scaled.protein}g`;
  if (carbsValue) carbsValue.textContent = `${scaled.carbs}g`;
  if (fatValue) fatValue.textContent = `${scaled.fat}g`;
}

function applyPreviewDraft() {
  const title = document.getElementById("calorie-preview-title");
  const source = document.getElementById("calorie-preview-source");
  const nameInput = document.getElementById("calorie-preview-name");
  const slider = document.getElementById("calorie-portion-slider");
  const confidence = document.getElementById("calorie-preview-confidence");
  const submitLabel = document.getElementById("calorie-preview-submit-label");
  const deleteBtn = document.getElementById("calorie-preview-delete");

  if (!previewDraft || !title || !source || !nameInput || !slider || !confidence || !submitLabel || !deleteBtn) {
    return;
  }

  if (previewDraft.mode === "edit") {
    title.textContent = "Edit meal";
    source.textContent = getPreviewSourceLabel(previewDraft.source);
    submitLabel.textContent = "Save meal";
  } else if (previewDraft.mode === "clone") {
    title.textContent = "Clone meal";
    source.textContent = "Duplicate meal";
    submitLabel.textContent = "Create clone";
  } else {
    title.textContent = "Confirm meal";
    source.textContent = getPreviewSourceLabel(previewDraft.source);
    submitLabel.textContent = "Add meal";
  }
  nameInput.value = previewDraft.name;
  slider.value = String(previewDraft.portion);
  confidence.textContent = getConfidenceCopy(previewDraft.confidence);
  deleteBtn.classList.toggle("hidden", previewDraft.mode !== "edit");
  setPreviewError("");
  setPreviewLoading(false);
  updatePreviewMetrics();
}

function openPreviewModalWithDraft(meal, mode = "create") {
  previewDraft = buildPreviewDraft(meal, mode);
  previewMode = mode;
  closeTrackerOverlays("calorie-preview-modal");
  openOverlay("calorie-preview-modal");
  applyPreviewDraft();
}

function openPreviewLoading(source = "scan") {
  previewDraft = buildPreviewDraft({
    source,
    confidence: "medium",
    name: "Meal",
    calories: 0,
    protein: 0,
    carbs: 0,
    fat: 0
  }, "create");
  previewMode = "create";
  closeTrackerOverlays("calorie-preview-modal");
  openOverlay("calorie-preview-modal");
  applyPreviewDraft();
  setPreviewLoading(true);
}

function closePreviewModal() {
  closeOverlay("calorie-preview-modal");
}

function getMealBadgeIcon(source) {
  if (source === "scan") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M4 7h3l1.4-2h7.2L17 7h3a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"></path><circle cx="12" cy="13" r="3.8" stroke-width="1.8"></circle></svg>';
  }

  if (source === "voice") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 3a3 3 0 0 0-3 3v5a3 3 0 1 0 6 0V6a3 3 0 0 0-3-3Z"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M19 10v1a7 7 0 0 1-14 0v-1"></path><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 18v3"></path></svg>';
  }

  if (source === "recent") {
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="M12 8v4l2.5 2.5"></path><circle cx="12" cy="12" r="8" stroke-width="1.8"></circle></svg>';
  }

  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true"><circle cx="11" cy="11" r="6.5" stroke-width="1.8"></circle><path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.8" d="m20 20-3.5-3.5"></path></svg>';
}

function formatFeedTimestamp(iso) {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "Unknown time";

  const todayKey = getLocalDayKey(new Date());
  const entryDayKey = getLocalDayKey(date);
  const timeText = formatTime(iso);

  if (todayKey === entryDayKey) return timeText;

  const now = new Date();
  const dateOptions = (date.getFullYear() === now.getFullYear())
    ? { month: "short", day: "numeric" }
    : { year: "numeric", month: "short", day: "numeric" };

  return `${date.toLocaleDateString(undefined, dateOptions)} · ${timeText}`;
}

function buildMergedRecentFoods(summary) {
  const recentFoods = summary && Array.isArray(summary.recentFoods) ? summary.recentFoods : [];
  const frequentFoods = summary && Array.isArray(summary.frequentFoods) ? summary.frequentFoods : [];
  const merged = [];
  const seen = new Set();
  const maxLength = Math.max(recentFoods.length, frequentFoods.length);

  for (let i = 0; i < maxLength; i += 1) {
    const candidates = [frequentFoods[i], recentFoods[i]];
    for (let j = 0; j < candidates.length; j += 1) {
      const item = candidates[j];
      if (!item || typeof item !== "object") continue;

      const key = String(item.name || item.id || "").trim().toLowerCase();
      if (!key || seen.has(key)) continue;

      seen.add(key);
      merged.push(item);
    }
  }

  return merged;
}

function renderRecentFoods(summary) {
  const container = document.getElementById("calorie-recent-foods");
  if (!container) return;

  const mergedFoods = buildMergedRecentFoods(summary);

  if (mergedFoods.length === 0) {
    container.innerHTML = '<p class="apple-caption calories-recent-empty">Recent and frequent foods will appear here after your first meal.</p>';
    return;
  }

  const markup = [];
  for (let i = 0; i < mergedFoods.length; i += 1) {
    const item = mergedFoods[i];
    const fullName = item && item.name ? String(item.name) : "Meal";
    const shortName = truncateLabel(fullName);
    const safeTitle = shortName !== fullName ? ` title="${escapeHtml(fullName)}"` : "";

    markup.push(`
      <button type="button" class="calories-recent-food" data-action="log-recent-food" data-meal-id="${escapeHtml(item.id)}"${safeTitle}>
        <span class="calories-recent-food-name">${escapeHtml(shortName)}</span>
        <span class="calories-recent-food-meta">${formatCalories(item.calories)} kcal</span>
      </button>
    `);
  }

  container.innerHTML = markup.join("");
}

function renderMacroChip(label, value, tone) {
  return `<span class="meal-macro-chip ${tone}"><span class="meal-macro-chip-key">${label}</span><span class="meal-macro-chip-value">${formatCalories(value)}g</span></span>`;
}

function mealMacroRowHtml(meal) {
  return `<div class="meal-macro-row" aria-label="Meal macros">${renderMacroChip("P", meal.protein, "protein")}${renderMacroChip("C", meal.carbs, "carbs")}${renderMacroChip("F", meal.fat, "fat")}</div>`;
}

function mealMetaHtml(meal) {
  return `<p class="meal-feed-meta"><span class="meal-feed-meta-icon" aria-hidden="true">${getMealBadgeIcon(meal.source)}</span><span class="meal-feed-meta-divider" aria-hidden="true">|</span><span class="meal-feed-meta-text">On ${escapeHtml(formatFeedTimestamp(meal.loggedAt))}</span></p>`;
}

function startOfDay(value) {
  const date = new Date(value);
  date.setHours(0, 0, 0, 0);
  return date;
}

function startOfWeek(value) {
  const date = startOfDay(value);
  const offset = (date.getDay() + 6) % 7;
  date.setDate(date.getDate() - offset);
  return date;
}

function startOfMonth(value) {
  const date = startOfDay(value);
  date.setDate(1);
  return date;
}

function shiftDateByDays(value, days) {
  const date = new Date(value);
  date.setDate(date.getDate() + days);
  return date;
}

function shiftDateByMonths(value, months) {
  const date = new Date(value);
  date.setMonth(date.getMonth() + months);
  return date;
}

function buildMealFeedGroups(meals) {
  const source = Array.isArray(meals) ? meals : [];
  const now = new Date();
  const todayStartMs = startOfDay(now).getTime();
  const yesterdayStartMs = startOfDay(shiftDateByDays(now, -1)).getTime();
  const thisWeekStartMs = startOfWeek(now).getTime();
  const lastWeekStartMs = startOfWeek(shiftDateByDays(now, -7)).getTime();
  const currentMonthStartMs = startOfMonth(now).getTime();
  const lastMonthStartMs = startOfMonth(shiftDateByMonths(now, -1)).getTime();
  const fixedGroups = [
    { key: "today", title: "Today", entries: [] },
    { key: "yesterday", title: "Yesterday", entries: [] },
    { key: "this-week", title: "This Week", entries: [] },
    { key: "last-week", title: "Last Week", entries: [] },
    { key: "last-month", title: "Last Month", entries: [] }
  ];
  const monthGroups = new Map();

  for (let i = 0; i < source.length; i += 1) {
    const meal = source[i];
    const timestamp = new Date(meal.loggedAt).getTime();
    if (!Number.isFinite(timestamp)) continue;

    if (timestamp >= todayStartMs) {
      fixedGroups[0].entries.push(meal);
      continue;
    }

    if (timestamp >= yesterdayStartMs) {
      fixedGroups[1].entries.push(meal);
      continue;
    }

    if (timestamp >= thisWeekStartMs) {
      fixedGroups[2].entries.push(meal);
      continue;
    }

    if (timestamp >= lastWeekStartMs) {
      fixedGroups[3].entries.push(meal);
      continue;
    }

    if (timestamp >= lastMonthStartMs && timestamp < currentMonthStartMs) {
      fixedGroups[4].entries.push(meal);
      continue;
    }

    const mealDate = new Date(meal.loggedAt);
    const monthKey = `${mealDate.getFullYear()}-${String(mealDate.getMonth() + 1).padStart(2, "0")}`;
    if (!monthGroups.has(monthKey)) {
      monthGroups.set(monthKey, {
        key: `month-${monthKey}`,
        title: mealDate.toLocaleDateString(undefined, { month: "long", year: "numeric" }),
        sortValue: mealDate.getFullYear() * 100 + mealDate.getMonth(),
        entries: []
      });
    }

    monthGroups.get(monthKey).entries.push(meal);
  }

  const datedMonthGroups = Array.from(monthGroups.values()).sort((a, b) => b.sortValue - a.sortValue);
  const normalizedMonthGroups = datedMonthGroups.map((group) => ({
    key: group.key,
    title: group.title,
    entries: group.entries
  }));

  return fixedGroups.filter((group) => group.entries.length > 0).concat(normalizedMonthGroups);
}

function mealGroupHtml(group, useMobileUi) {
  const entryMarkup = new Array(group.entries.length);
  for (let i = 0; i < group.entries.length; i += 1) {
    entryMarkup[i] = useMobileUi ? mobileMealRowHtml(group.entries[i]) : desktopMealCardHtml(group.entries[i]);
  }

  return `<section class="meal-feed-group" data-meal-group="${escapeHtml(group.key)}">
    <div class="meal-feed-group-header">
      <p class="apple-overline meal-feed-group-title">${escapeHtml(group.title)}</p>
      <p class="apple-caption meal-feed-group-count">${escapeHtml(formatCountLabel(group.entries.length, "meal"))}</p>
    </div>
    <div class="meal-feed-group-list${useMobileUi ? " meal-feed-group-list-mobile" : ""}">
      ${entryMarkup.join("")}
    </div>
  </section>`;
}

function desktopMealCardHtml(meal) {
  const mealId = escapeHtml(meal.id);
  const mealName = escapeHtml(meal.name);

  return `<article class="meal-feed-card meal-feed-card-desktop" data-meal-id="${mealId}" role="listitem">
    <div class="meal-feed-main" aria-label="${mealName}">
      <div class="meal-feed-leading">
        <div class="meal-feed-copy">
          <p class="meal-feed-name">${mealName}</p>
          ${mealMetaHtml(meal)}
          ${mealMacroRowHtml(meal)}
        </div>
      </div>
      <div class="meal-feed-calories">
        <p class="meal-feed-calories-value">${formatCalories(meal.calories)}</p>
        <p class="meal-feed-calories-unit">kcal</p>
      </div>
    </div>
    <div class="meal-feed-actions">
      <div class="meal-menu-anchor">
        <button type="button"
                class="meal-menu-trigger"
                aria-label="Open meal actions"
                aria-haspopup="menu"
                aria-expanded="false"
                data-meal-menu-toggle="${mealId}">
          ${MEAL_ICONS.MENU}
        </button>
        <div class="meal-menu" role="menu" data-meal-menu="${mealId}">
          <button type="button" class="meal-menu-item" role="menuitem" data-action="edit-meal" data-meal-id="${mealId}">Edit</button>
          <button type="button" class="meal-menu-item" role="menuitem" data-action="clone-meal" data-meal-id="${mealId}">Clone</button>
          <button type="button" class="meal-menu-item danger" role="menuitem" data-action="delete-meal" data-meal-id="${mealId}">Delete</button>
        </div>
      </div>
    </div>
  </article>`;
}

function mobileMealRowHtml(meal) {
  const mealId = escapeHtml(meal.id);

  return `<article class="meal-swipe-row" data-meal-id="${mealId}" role="listitem">
    <div class="meal-pill-actions">
      <button type="button" class="meal-pill-btn edit" aria-label="Edit meal" data-action="edit-meal" data-meal-id="${mealId}">${MEAL_ICONS.EDIT}</button>
      <button type="button" class="meal-pill-btn clone" aria-label="Clone meal" data-action="clone-meal" data-meal-id="${mealId}">${MEAL_ICONS.CLONE}</button>
      <button type="button" class="meal-pill-btn delete" aria-label="Delete meal" data-action="delete-meal" data-meal-id="${mealId}">${MEAL_ICONS.DELETE}</button>
    </div>
    <div class="meal-row-content">
      <div class="meal-feed-leading meal-feed-leading-compact">
        <div class="meal-feed-copy meal-feed-copy-compact">
          <p class="meal-feed-name">${escapeHtml(meal.name)}</p>
          ${mealMetaHtml(meal)}
          ${mealMacroRowHtml(meal)}
        </div>
      </div>
      <div class="meal-feed-calories meal-feed-calories-compact">
        <p class="meal-feed-calories-value">${formatCalories(meal.calories)}</p>
        <p class="meal-feed-calories-unit">kcal</p>
      </div>
    </div>
  </article>`;
}

function renderFeed(summary) {
  const emptyState = document.getElementById("calories-empty-state");
  const list = document.getElementById("meal-feed-list");
  const feedMeta = document.getElementById("calories-feed-meta");

  if (!emptyState || !list || !feedMeta) return;

  const meals = summary && Array.isArray(summary.meals) ? summary.meals : [];
  const todayCount = summary ? summary.mealCount : 0;
  const useMobileUi = isMobileCaloriesUI();

  lastCaloriesUiMode = useMobileUi;
  closeOpenMealMenu();
  closeOpenMealSwipeRow();

  if (todayCount > 0) {
    feedMeta.textContent = `${formatCountLabel(todayCount, "meal")} today`;
  } else if (meals.length > 0) {
    feedMeta.textContent = "No meals logged today";
  } else {
    feedMeta.textContent = "No meals logged yet";
  }

  if (meals.length === 0) {
    emptyState.classList.remove("hidden");
    list.innerHTML = "";
    closeMealDeleteSheet();
    return;
  }

  emptyState.classList.add("hidden");

  const groups = buildMealFeedGroups(meals);
  const markup = new Array(groups.length);
  for (let i = 0; i < groups.length; i += 1) {
    markup[i] = mealGroupHtml(groups[i], useMobileUi);
  }

  list.innerHTML = markup.join("");

  if (useMobileUi) {
    initMealSwipeRows(list);
  }
}

function renderMacroModal(summary) {
  const goalCopy = document.getElementById("calorie-macro-goal-copy");
  const totalCopy = document.getElementById("calorie-macro-total-copy");
  const proteinValue = document.getElementById("calorie-macro-protein-value");
  const carbsValue = document.getElementById("calorie-macro-carbs-value");
  const fatValue = document.getElementById("calorie-macro-fat-value");
  const proteinBar = document.getElementById("calorie-macro-protein-bar");
  const carbsBar = document.getElementById("calorie-macro-carbs-bar");
  const fatBar = document.getElementById("calorie-macro-fat-bar");

  if (!goalCopy || !totalCopy || !proteinValue || !carbsValue || !fatValue || !proteinBar || !carbsBar || !fatBar) {
    return;
  }

  const macroCalories = {
    protein: (summary.protein || 0) * 4,
    carbs: (summary.carbs || 0) * 4,
    fat: (summary.fat || 0) * 9
  };
  const totalMacroCalories = macroCalories.protein + macroCalories.carbs + macroCalories.fat;
  const goalText = `${formatCalories(summary.goalCalories)} kcal`;
  const macroProfile = summary.macroProfile;
  const macroPlanText = `${formatDecimal(macroProfile.proteinMultiplierDisplayValue)} ${macroProfile.proteinMultiplierDisplayUnit} protein • ${formatPercent(macroProfile.carbPercent)} carbs • ${formatPercent(macroProfile.fatPercent)} fat`;

  if (summary.goalSource === "saved-goal") {
    goalCopy.textContent = `Goal uses ${summary.goalLabel}: ${goalText}. Macro plan: ${macroPlanText}.`;
  } else if (summary.goalSource === "maintenance-default") {
    goalCopy.textContent = `Goal matches your maintenance estimate: ${goalText}. Macro plan: ${macroPlanText}.`;
  } else {
    goalCopy.textContent = `Goal is using the quick default estimate: ${goalText}. Macro plan: ${macroPlanText}.`;
  }
  totalCopy.textContent = `${formatCalories(summary.consumedCalories)} kcal eaten today`;
  proteinValue.textContent = `${summary.protein}g`;
  carbsValue.textContent = `${summary.carbs}g`;
  fatValue.textContent = `${summary.fat}g`;

  proteinBar.style.width = totalMacroCalories ? `${(macroCalories.protein / totalMacroCalories) * 100}%` : "0%";
  carbsBar.style.width = totalMacroCalories ? `${(macroCalories.carbs / totalMacroCalories) * 100}%` : "0%";
  fatBar.style.width = totalMacroCalories ? `${(macroCalories.fat / totalMacroCalories) * 100}%` : "0%";
}

function renderReminder(summary) {
  const card = document.getElementById("calories-reminder-card");
  const title = document.getElementById("calories-reminder-title");
  const note = document.getElementById("calories-reminder-note");
  const enableBtn = document.getElementById("calories-reminder-enable");
  if (!card || !title || !note || !enableBtn) return;

  if (!summary.reminder) {
    card.classList.add("hidden");
    return;
  }

  const meta = getCalorieTrackerMeta(latestState);
  const notificationsSupported = typeof Notification !== "undefined";
  const permission = notificationsSupported ? Notification.permission : "denied";

  title.textContent = summary.reminder.title;
  note.textContent = summary.reminder.note;
  card.classList.remove("hidden");

  const shouldShowEnable = notificationsSupported
    && meta.reminderOptIn !== true
    && (permission === "default" || permission === "granted");

  enableBtn.classList.toggle("hidden", !shouldShowEnable);
}

function maybeSendReminderNotification(summary) {
  if (!summary || !summary.reminder) return;
  if (typeof Notification === "undefined") return;
  if (Notification.permission !== "granted") return;
  if (document.visibilityState && document.visibilityState !== "visible") return;

  const meta = getCalorieTrackerMeta(latestState);
  if (meta.reminderOptIn !== true) return;

  const todayKey = getLocalDayKey(new Date());
  if (meta.lastReminderDay === todayKey) return;

  try {
    new Notification(summary.reminder.title, { body: summary.reminder.note });
    latestState = setCalorieTrackerMeta({ lastReminderDay: todayKey });
  } catch (_err) {
    // Ignore browser notification failures and fall back to the inline reminder card.
  }
}

function renderSummaryCard(summary) {
  const maintenanceCopy = document.getElementById("calories-maintenance-copy");
  const goalCopy = document.getElementById("calories-goal-copy");
  const remainingValue = document.getElementById("calories-remaining-value");
  const remainingLabel = document.getElementById("calories-remaining-label");
  const proteinValue = document.getElementById("calories-protein-value");
  const carbsValue = document.getElementById("calories-carbs-value");
  const fatValue = document.getElementById("calories-fat-value");

  if (
    !maintenanceCopy
    || !goalCopy
    || !remainingValue
    || !remainingLabel
    || !proteinValue
    || !carbsValue
    || !fatValue
  ) {
    return;
  }

  const macroTargets = summary.macroTargets;

  maintenanceCopy.textContent = summary.maintenanceCalories
    ? `Maintenance ${formatCalories(summary.maintenanceCalories)} kcal`
    : "Maintenance --";
  goalCopy.textContent = summary.goalSource === "saved-goal"
    ? `Goal ${formatCalories(summary.goalCalories)} kcal (${summary.goalLabel})`
    : `Goal ${formatCalories(summary.goalCalories)} kcal`;
  remainingValue.textContent = formatCalories(summary.isOver ? summary.overCalories : summary.remainingCalories);
  remainingLabel.textContent = summary.isOver ? "Over" : "Remaining";
  proteinValue.textContent = formatMacroProgress(summary.protein, macroTargets.protein);
  carbsValue.textContent = formatMacroProgress(summary.carbs, macroTargets.carbs);
  fatValue.textContent = formatMacroProgress(summary.fat, macroTargets.fat);

  setRadialProgress("primary", summary.progressRatioCapped);
  setRadialProgress("overflow", summary.overflowProgressRatioCapped);
}

function renderTrackerView(state) {
  latestState = state || loadState();
  const summary = buildCalorieTrackerSummary(latestState);

  renderSummaryCard(summary);
  renderMacroModal(summary);
  renderGoalModalState(latestState);
  renderReminder(summary);
  renderFeed(summary);
  renderRecentFoods(summary);
  maybeSendReminderNotification(summary);
}

function isValidGoalObjective(objective) {
  return CALORIE_GOAL_OBJECTIVES.includes(objective);
}

function getGoalObjectiveMeta(objective) {
  return isValidGoalObjective(objective) ? GOAL_OBJECTIVE_META[objective] : null;
}

function getSelectedGoalPreset() {
  const preset = getCalorieGoalPreset(selectedGoalPresetKey);
  if (!preset || preset.objective !== selectedGoalObjective) return null;
  return preset;
}

function getGoalStepCopy(objective, maintenanceCalories) {
  const maintenanceText = maintenanceCalories !== null
    ? `${formatCalories(maintenanceCalories)} kcal`
    : "your TDEE";

  if (objective === "lose") {
    return {
      phase: "Cutting",
      title: "Choose your calorie deficit",
      note: `Each option below sets a daily target below ${maintenanceText}.`
    };
  }

  if (objective === "gain") {
    return {
      phase: "Bulking",
      title: "Choose your calorie surplus",
      note: `Each option below sets a daily target above ${maintenanceText}.`
    };
  }

  if (objective === "maintain") {
    return {
      phase: "Maintenance",
      title: "Stay right at maintenance",
      note: `This keeps your goal aligned with ${maintenanceText}.`
    };
  }

  return {
    phase: "Step 2",
    title: "Pick your pace",
    note: "Each option below turns your TDEE into one exact daily calorie goal."
  };
}

function getGoalMissingReasonItems(state) {
  const reasons = getCalorieMissingReasons(state);
  const items = new Array(reasons.length);
  for (let i = 0; i < reasons.length; i += 1) {
    items[i] = GOAL_MISSING_REASON_LABELS[reasons[i]] || "Complete your calorie setup";
  }
  return items;
}

function renderGoalObjectiveOptions() {
  const container = document.getElementById("calorie-goal-objective-options");
  if (!container) return;

  const markup = new Array(CALORIE_GOAL_OBJECTIVES.length);
  for (let i = 0; i < CALORIE_GOAL_OBJECTIVES.length; i += 1) {
    const objective = CALORIE_GOAL_OBJECTIVES[i];
    const meta = getGoalObjectiveMeta(objective);
    const isSelected = selectedGoalObjective === objective;

    markup[i] = `<button type="button"
      class="calorie-goal-option-card${isSelected ? " is-selected" : ""}"
      data-action="select-calorie-goal-objective"
      data-goal-objective="${escapeHtml(objective)}"
      aria-pressed="${isSelected ? "true" : "false"}">
      <span class="calorie-goal-option-indicator" aria-hidden="true"></span>
      <div class="calorie-goal-copy">
        <div class="calorie-goal-option-title-row">
          <p class="apple-subtitle apple-subtitle-sm">${escapeHtml(meta.title)}</p>
          <span class="calorie-goal-badge">${escapeHtml(meta.badge)}</span>
        </div>
        <p class="apple-caption">${escapeHtml(meta.description)}</p>
      </div>
    </button>`;
  }

  container.innerHTML = markup.join("");
}

function renderGoalPresetOptions(state) {
  const phaseLabel = document.getElementById("calorie-goal-phase-label");
  const title = document.getElementById("calorie-goal-step-title");
  const note = document.getElementById("calorie-goal-step-note");
  const missingCard = document.getElementById("calorie-goal-missing-card");
  const missingNote = document.getElementById("calorie-goal-missing-note");
  const missingList = document.getElementById("calorie-goal-missing-list");
  const container = document.getElementById("calorie-goal-preset-options");

  if (!phaseLabel || !title || !note || !missingCard || !missingNote || !missingList || !container) {
    return;
  }

  const goalSummary = resolveCalorieGoalFromState(state);
  const maintenanceCalories = goalSummary.maintenanceCalories;
  const copy = getGoalStepCopy(selectedGoalObjective, maintenanceCalories);

  phaseLabel.textContent = copy.phase;
  title.textContent = copy.title;
  note.textContent = copy.note;

  if (!isValidGoalObjective(selectedGoalObjective)) {
    missingCard.classList.add("hidden");
    missingList.innerHTML = "";
    container.innerHTML = "";
    return;
  }

  if (maintenanceCalories === null) {
    const missingItems = getGoalMissingReasonItems(state);
    missingNote.textContent = "We need enough profile data to calculate your TDEE before we can save a goal.";
    missingList.innerHTML = missingItems.map((item) => `<li>${escapeHtml(item)}</li>`).join("");
    missingCard.classList.remove("hidden");
    container.innerHTML = "";
    return;
  }

  missingCard.classList.add("hidden");
  missingList.innerHTML = "";

  const presets = getCalorieGoalPresets(selectedGoalObjective);
  const markup = new Array(presets.length);
  for (let i = 0; i < presets.length; i += 1) {
    const preset = presets[i];
    const isSelected = preset.key === selectedGoalPresetKey;
    const targetCalories = Math.max(0, maintenanceCalories + preset.delta);
    const appliedDeltaText = preset.delta === 0
      ? "Matches maintenance"
      : `${formatSignedCalories(preset.delta)} kcal vs TDEE`;

    markup[i] = `<button type="button"
      class="calorie-goal-preset-card${isSelected ? " is-selected" : ""}"
      data-action="select-calorie-goal-preset"
      data-goal-preset="${escapeHtml(preset.key)}"
      aria-pressed="${isSelected ? "true" : "false"}">
      <div class="calorie-goal-preset-top">
        <div class="calorie-goal-copy">
          <div class="calorie-goal-preset-header">
            <p class="apple-subtitle apple-subtitle-sm">${escapeHtml(preset.title)}</p>
            ${preset.recommended ? '<span class="calorie-goal-badge">Recommended</span>' : ""}
          </div>
          <p class="apple-caption">${escapeHtml(`${preset.phase} · ${preset.approach}`)}</p>
        </div>
      </div>
      <div class="calorie-goal-preset-body">
        <div class="calorie-goal-preset-target-block">
          <div class="calorie-goal-preset-target">
            <span class="calorie-goal-target">${formatCalories(targetCalories)}</span>
            <span class="calorie-goal-target-unit">kcal/day</span>
          </div>
          <p class="apple-caption calorie-goal-preset-delta">${escapeHtml(appliedDeltaText)}</p>
        </div>
        <div class="calorie-goal-preset-grid">
          <div class="calorie-goal-metric">
            <span class="calorie-goal-metric-label">Range</span>
            <span class="calorie-goal-metric-value">${escapeHtml(preset.rangeText)}</span>
          </div>
          <div class="calorie-goal-metric">
            <span class="calorie-goal-metric-label">Expected rate</span>
            <span class="calorie-goal-metric-value">${escapeHtml(preset.rateText)}</span>
          </div>
        </div>
      </div>
      <p class="apple-caption calorie-goal-preset-note">${escapeHtml(preset.notes)}</p>
    </button>`;
  }

  container.innerHTML = markup.join("");
}

function syncGoalStepUi(state) {
  const track = document.getElementById("calorie-goal-step-track");
  const label = document.getElementById("calorie-goal-step-label");
  const dots = document.querySelectorAll("#calorie-goal-step-dots .calorie-step-dot");
  const backBtn = document.getElementById("calorie-goal-back-btn");
  const primaryBtn = document.getElementById("calorie-goal-primary-btn");

  if (!track || !label || !backBtn || !primaryBtn) return;

  track.style.transform = `translateX(-${goalCurrentStep * 100}%)`;
  label.textContent = `Step ${goalCurrentStep + 1} of ${GOAL_STEP_COUNT}`;

  const hasObjective = isValidGoalObjective(selectedGoalObjective);
  const hasMaintenance = resolveCalorieGoalFromState(state).maintenanceCalories !== null;
  const selectedPreset = getSelectedGoalPreset();

  for (let i = 0; i < dots.length; i += 1) {
    const isActive = i === goalCurrentStep;
    const isDisabled = i > 0 && !hasObjective;
    dots[i].classList.toggle("is-active", isActive);
    dots[i].classList.toggle("is-disabled", isDisabled);
    dots[i].disabled = isDisabled;
  }

  backBtn.classList.toggle("hidden", goalCurrentStep === 0);
  primaryBtn.textContent = goalCurrentStep === 0 ? "Continue" : "Save goal";
  primaryBtn.disabled = goalCurrentStep === 0
    ? !hasObjective
    : !(hasMaintenance && selectedPreset);
}

function renderGoalModalState(state) {
  renderGoalObjectiveOptions();
  renderGoalPresetOptions(state);
  syncGoalStepUi(state);
}

function applyGoalSelectionFromState(state) {
  const savedGoal = getCalorieGoal(state);
  selectedGoalObjective = savedGoal.objective || "";
  selectedGoalPresetKey = savedGoal.presetKey || (savedGoal.objective === "maintain" ? "maintain" : "");
  goalCurrentStep = 0;
  setGoalError("");
  renderGoalModalState(state);
}

function openGoalModal() {
  latestState = latestState || loadState();
  applyGoalSelectionFromState(latestState);
  closeTrackerOverlays("calorie-goal-modal");
  openOverlay("calorie-goal-modal");
}

function closeGoalModal() {
  setGoalError("");
  closeOverlay("calorie-goal-modal");
}

function selectGoalObjective(objective) {
  if (!isValidGoalObjective(objective)) return;

  selectedGoalObjective = objective;
  const currentPreset = getCalorieGoalPreset(selectedGoalPresetKey);
  if (objective === "maintain") {
    selectedGoalPresetKey = "maintain";
  } else if (!currentPreset || currentPreset.objective !== objective) {
    selectedGoalPresetKey = "";
  }

  setGoalError("");
  renderGoalModalState(latestState || loadState());
}

function selectGoalPreset(presetKey) {
  const preset = getCalorieGoalPreset(presetKey);
  if (!preset || preset.objective !== selectedGoalObjective) return;

  selectedGoalPresetKey = preset.key;
  setGoalError("");
  renderGoalModalState(latestState || loadState());
}

function moveGoalStep(nextIndex) {
  if (nextIndex > 0 && !isValidGoalObjective(selectedGoalObjective)) {
    setGoalError("Choose whether you want to lose, maintain, or gain.");
    return false;
  }

  goalCurrentStep = Math.max(0, Math.min(GOAL_STEP_COUNT - 1, nextIndex));
  setGoalError("");
  renderGoalModalState(latestState || loadState());
  return true;
}

function openSetupFromGoalModal() {
  hideOverlayImmediately("calorie-goal-modal");
  openSetupModal();
}

function saveGoalSelection() {
  const state = latestState || loadState();
  const resolvedGoal = resolveCalorieGoalFromState(state);
  const preset = getSelectedGoalPreset();

  if (resolvedGoal.maintenanceCalories === null) {
    setGoalError("Complete calorie setup before saving a goal.");
    return false;
  }

  if (!preset) {
    setGoalError("Choose a goal option to continue.");
    return false;
  }

  latestState = setCalorieGoal({
    objective: preset.objective,
    presetKey: preset.key
  });

  closeGoalModal();
  renderTrackerView(latestState);
  showToast("Calorie goal updated");
  return true;
}

function advanceGoalFlow() {
  if (goalCurrentStep === 0) {
    if (!isValidGoalObjective(selectedGoalObjective)) {
      setGoalError("Choose whether you want to lose, maintain, or gain.");
      return false;
    }

    goalCurrentStep = 1;
    setGoalError("");
    renderGoalModalState(latestState || loadState());
    return true;
  }

  return saveGoalSelection();
}

async function requestMealEstimate({ mode, note, files }) {
  const formData = new FormData();
  formData.set("mode", mode || "manual");
  formData.set("note", note || "");
  const imageFiles = Array.isArray(files) ? files : [];
  for (let i = 0; i < imageFiles.length; i += 1) {
    if (imageFiles[i]) {
      formData.append("images", imageFiles[i]);
    }
  }

  let response;
  try {
    response = await fetch("/api/calories/analyze", {
      method: "POST",
      body: formData
    });
  } catch (_err) {
    throw new Error("Meal analysis needs an online connection.");
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch (_err) {
    payload = null;
  }

  if (response.status === 404) {
    throw new Error("AI meal analysis isn't live on the current server yet. Restart `uv run uvicorn main:app --reload` and try again.");
  }

  if (!response.ok) {
    throw new Error(payload && payload.detail ? payload.detail : "Unable to analyze this meal right now.");
  }

  if (!payload || !payload.meal) {
    throw new Error("AI did not return a usable meal.");
  }

  return payload.meal;
}

async function handleScanFile(file) {
  if (!file) return;

  openPreviewLoading("scan");
  setPreviewError("");

  try {
    const meal = await requestMealEstimate({
      mode: "scan",
      note: "",
      files: file ? [file] : []
    });
    openPreviewModalWithDraft({
      ...meal,
      source: "scan"
    }, "create");
  } catch (error) {
    closePreviewModal();
    showToast(error instanceof Error ? error.message : "Unable to analyze this meal right now.");
  }
}

async function submitManualAnalysis(event = null) {
  if (event) event.preventDefault();

  const description = document.getElementById("calorie-manual-description");
  if (!description) return false;

  const note = description.value.trim();
  const sourceMode = manualEntryMode;
  setManualError("");

  if (!note && manualPhotoFiles.length === 0) {
    setManualError("Add a description or a photo.");
    return true;
  }

  setManualBusy(true);

  try {
    const meal = await requestMealEstimate({
      mode: manualEntryMode,
      note,
      files: manualPhotoFiles.map((item) => item.file)
    });

    resetManualComposer();
    closeManualModal();
    openPreviewModalWithDraft({
      ...meal,
      source: sourceMode
    }, "create");
  } catch (error) {
    setManualError(error instanceof Error ? error.message : "Unable to analyze this meal right now.");
  } finally {
    setManualBusy(false);
  }

  return true;
}

function handleRecentFoodLog(mealId) {
  const meal = getMealById(mealId);
  if (!meal) return;

  addMeal({
    name: meal.name,
    source: "recent",
    confidence: meal.confidence,
    portion: 1,
    baseCalories: meal.baseCalories,
    baseProtein: meal.baseProtein,
    baseCarbs: meal.baseCarbs,
    baseFat: meal.baseFat,
    loggedAt: new Date().toISOString()
  });

  latestState = loadState();
  renderTrackerView(latestState);
  closeManualModal();
  showToast(`${meal.name} added`);
}

function handleEditMeal(mealId) {
  closeOpenMealMenu();
  closeOpenMealSwipeRow();
  const meal = getMealById(mealId);
  if (!meal) return;
  openPreviewModalWithDraft(meal, "edit");
}

function handleCloneMeal(mealId) {
  closeOpenMealMenu();
  closeOpenMealSwipeRow();
  const meal = getMealById(mealId);
  if (!meal) return;
  openPreviewModalWithDraft(meal, "clone");
}

function submitPreviewMeal(event) {
  if (event) event.preventDefault();
  if (!previewDraft) return false;

  const nameInput = document.getElementById("calorie-preview-name");
  const slider = document.getElementById("calorie-portion-slider");
  if (!nameInput || !slider) return true;

  const name = nameInput.value.trim();
  if (!name) {
    setPreviewError("Give this meal a name before saving.");
    return true;
  }

  const portion = clampPortion(slider.value);
  const payload = {
    name,
    source: previewDraft.source,
    confidence: previewDraft.confidence,
    portion,
    baseCalories: previewDraft.baseCalories,
    baseProtein: previewDraft.baseProtein,
    baseCarbs: previewDraft.baseCarbs,
    baseFat: previewDraft.baseFat
  };

  if (previewDraft.mode === "edit" && previewDraft.id) {
    updateMeal(previewDraft.id, payload);
    showToast(`${name} updated`);
  } else {
    addMeal({
      ...payload,
      loggedAt: new Date().toISOString()
    });
    showToast(previewDraft.mode === "clone" ? `${name} cloned` : `${name} added`);
  }

  latestState = loadState();
  closePreviewModal();
  renderTrackerView(latestState);
  return true;
}

function deletePreviewMeal() {
  if (!previewDraft || previewDraft.mode !== "edit" || !previewDraft.id) return;

  deleteMeal(previewDraft.id);
  latestState = loadState();
  closePreviewModal();
  renderTrackerView(latestState);
  showToast("Meal deleted");
}

async function enableReminderNotifications() {
  if (typeof Notification === "undefined") {
    showToast("Notifications are not supported in this browser.");
    return;
  }

  try {
    const permission = await Notification.requestPermission();
    if (permission === "granted") {
      latestState = setCalorieTrackerMeta({ reminderOptIn: true });
      renderTrackerView(latestState);
      showToast("Daily reminder enabled");
      return;
    }
  } catch (_err) {
    // Fall through to the generic message below.
  }

  showToast("Reminder permission was not enabled.");
}

function bindManualEvents() {
  const photoInput = document.getElementById("calorie-manual-photo-input");
  if (photoInput && photoInput.dataset.bound !== "1") {
    photoInput.dataset.bound = "1";
    photoInput.addEventListener("change", () => {
      addManualPhotos(photoInput.files);
      photoInput.value = "";
    });
  }

  const scanInput = document.getElementById("calorie-scan-input");
  if (scanInput && scanInput.dataset.bound !== "1") {
    scanInput.dataset.bound = "1";
    scanInput.addEventListener("change", () => {
      const file = scanInput.files && scanInput.files[0] ? scanInput.files[0] : null;
      if (file) {
        void handleScanFile(file);
      }
      scanInput.value = "";
    });
  }

  const slider = document.getElementById("calorie-portion-slider");
  if (slider && slider.dataset.bound !== "1") {
    slider.dataset.bound = "1";
    slider.addEventListener("input", () => {
      updatePreviewMetrics();
    });
  }
}

function bindFabGesture() {
  const primary = document.getElementById("calories-fab-primary");
  if (!primary || primary.dataset.bound === "1") return;

  primary.dataset.bound = "1";

  const clearPress = () => {
    clearTimer(fabLongPressTimer);
    fabLongPressTimer = null;
  };

  primary.addEventListener("pointerdown", (event) => {
    if (event.button !== undefined && event.button !== 0) return;

    clearPress();
    fabLongPressHandled = false;
    fabLongPressTimer = window.setTimeout(() => {
      fabLongPressHandled = true;
      setFabMenuOpen(true);
    }, FAB_LONG_PRESS_MS);
  });

  primary.addEventListener("pointerup", clearPress);
  primary.addEventListener("pointerleave", clearPress);
  primary.addEventListener("pointercancel", clearPress);
}

function initMealSwipeRow(row) {
  if (!row || row.dataset.swipeBound === "1") return;
  row.dataset.swipeBound = "1";

  const content = row.querySelector(".meal-row-content");
  const actions = row.querySelector(".meal-pill-actions");
  if (!content || !actions) return;

  const buttons = Array.prototype.slice.call(actions.querySelectorAll(".meal-pill-btn"));
  const deleteButton = row.querySelector(".meal-pill-btn.delete");
  const openPx = measureOpenPx();
  row._openPx = openPx;

  let startX = 0;
  let startY = 0;
  let baseX = 0;
  let curX = 0;
  let lastMoveX = 0;
  let lastMoveTime = 0;
  let velocityX = 0;
  let dragging = false;
  let locked = false;
  let queuedX = 0;
  let translateFrame = null;
  let willChangeTimer = null;
  let actionsHideTimer = null;

  function measureOpenPx() {
    if (!buttons.length) return 0;

    const actionsStyle = window.getComputedStyle(actions);
    let gap = parseFloat(actionsStyle.columnGap || actionsStyle.gap || "0");
    let rightInset = parseFloat(actionsStyle.right || "0");
    if (!Number.isFinite(gap)) gap = 0;
    if (!Number.isFinite(rightInset)) rightInset = 0;

    let actionWidth = 0;
    for (let i = 0; i < buttons.length; i += 1) {
      let layoutWidth = buttons[i].offsetWidth;
      if (!layoutWidth) {
        const btnStyle = window.getComputedStyle(buttons[i]);
        layoutWidth = parseFloat(btnStyle.width || "0");
      }
      actionWidth += layoutWidth;
    }
    actionWidth += Math.max(0, buttons.length - 1) * gap;

    return Math.max(
      MEAL_SWIPE_CONFIG.MIN_OPEN_PX,
      Math.ceil(actionWidth + rightInset + MEAL_SWIPE_CONFIG.OPEN_EXTRA_PX)
    );
  }

  function clearWillChangeSoon() {
    if (willChangeTimer !== null) {
      window.clearTimeout(willChangeTimer);
    }

    const delay = Math.max(90, Math.round(getMaxTransitionMs(content)));
    willChangeTimer = window.setTimeout(() => {
      willChangeTimer = null;
      if (!dragging) {
        content.style.willChange = "";
      }
    }, delay);
  }

  function clearActionsHideSoon() {
    if (actionsHideTimer !== null) {
      window.clearTimeout(actionsHideTimer);
      actionsHideTimer = null;
    }
  }

  function cancelTranslateFrame() {
    if (translateFrame !== null) {
      window.cancelAnimationFrame(translateFrame);
      translateFrame = null;
    }
  }

  function toggleDeleteExpansion(x) {
    if (!deleteButton) return;
    if (x < -(window.innerWidth * MEAL_SWIPE_CONFIG.FULL_FRAC)) {
      deleteButton.classList.add("expanding");
    } else {
      deleteButton.classList.remove("expanding");
    }
  }

  function toggleButtons(progress) {
    for (let i = 0; i < buttons.length; i += 1) {
      if (progress > (0.08 + i * 0.12)) {
        buttons[i].classList.add("show");
      } else {
        buttons[i].classList.remove("show");
      }
    }
  }

  function applyTranslate(x, animate) {
    content.style.transition = animate
      ? "transform var(--motion-duration-snap) var(--motion-ease-emphasized)"
      : "none";
    content.style.transform = `translate3d(${x}px, 0, 0)`;

    if (x < -4) {
      actions.classList.add("visible");
      toggleButtons(Math.min(1, Math.abs(x) / Math.max(openPx, 1)));
    } else if (Math.abs(x) < 8) {
      actions.classList.remove("visible");
      toggleButtons(0);
    }
  }

  function scheduleTranslate(x) {
    queuedX = x;
    if (translateFrame !== null) return;

    translateFrame = requestAnimationFrame(() => {
      translateFrame = null;
      applyTranslate(queuedX, false);
      toggleDeleteExpansion(queuedX);
    });
  }

  function flushTranslateFrame() {
    if (translateFrame === null) return;
    window.cancelAnimationFrame(translateFrame);
    translateFrame = null;
    applyTranslate(queuedX, false);
    toggleDeleteExpansion(queuedX);
  }

  function snapTo(x) {
    cancelTranslateFrame();
    clearActionsHideSoon();
    curX = x;
    queuedX = x;
    applyTranslate(x, true);
    toggleDeleteExpansion(x);

    if (x < 0) {
      row.classList.add("is-open");
    } else {
      row.classList.remove("is-open");
    }

    if (x === 0) {
      const delay = Math.max(90, Math.round(getMaxTransitionMs(content)));
      actionsHideTimer = window.setTimeout(() => {
        actionsHideTimer = null;
        actions.classList.remove("visible");
        toggleButtons(0);
      }, delay);
    }

    clearWillChangeSoon();
  }

  function closeRow() {
    snapTo(0);
    if (openMealSwipeRow === row) openMealSwipeRow = null;
  }

  function onStart(event) {
    if (!event.touches || event.touches.length !== 1) return;

    if (openMealSwipeRow && openMealSwipeRow !== row) {
      closeOpenMealSwipeRow();
    }

    startX = event.touches[0].clientX;
    startY = event.touches[0].clientY;
    baseX = curX;
    lastMoveX = startX;
    lastMoveTime = Date.now();
    velocityX = 0;
    dragging = true;
    locked = false;
    cancelTranslateFrame();
    clearActionsHideSoon();
    if (willChangeTimer !== null) {
      window.clearTimeout(willChangeTimer);
      willChangeTimer = null;
    }
    content.style.willChange = "transform";
    content.style.transition = "none";
  }

  function onMove(event) {
    if (!dragging || !event.touches || event.touches.length !== 1) return;

    const x = event.touches[0].clientX;
    const y = event.touches[0].clientY;
    const dx = x - startX;
    const dy = y - startY;

    if (!locked) {
      if (Math.hypot(dx, dy) < 5) return;
      if (Math.abs(dy) > Math.abs(dx)) {
        dragging = false;
        content.style.willChange = "";
        return;
      }
      locked = true;
    }

    if (event.cancelable) event.preventDefault();

    let raw = baseX + dx;
    const now = Date.now();
    const dt = now - lastMoveTime;
    if (dt > 0) {
      velocityX = (x - lastMoveX) / dt;
    }
    lastMoveX = x;
    lastMoveTime = now;

    if (raw > 0) {
      raw *= 0.2;
    }

    if (raw < -openPx) {
      raw = -openPx + (raw + openPx) * MEAL_SWIPE_CONFIG.DAMP;
    }

    curX = raw;
    scheduleTranslate(raw);
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;

    flushTranslateFrame();

    if (deleteButton) deleteButton.classList.remove("expanding");

    if (curX < -(window.innerWidth * MEAL_SWIPE_CONFIG.FULL_FRAC)) {
      closeRow();
      if (navigator.vibrate) navigator.vibrate(10);
      openMealDeleteSheet(row.getAttribute("data-meal-id"));
      return;
    }

    if ((Math.abs(curX) > MEAL_SWIPE_CONFIG.SNAP_PX || velocityX < MEAL_SWIPE_CONFIG.FLICK_VELOCITY) && buttons.length > 0) {
      snapTo(-(row._openPx || openPx));
      openMealSwipeRow = row;
      row._close = closeRow;
    } else {
      closeRow();
    }
  }

  content.addEventListener("touchstart", onStart, { passive: true });
  content.addEventListener("touchmove", onMove, { passive: false });
  content.addEventListener("touchend", onEnd);
  content.addEventListener("touchcancel", onEnd);
  content.addEventListener("click", () => {
    if (openMealSwipeRow === row) {
      closeRow();
    }
  });

  row._close = closeRow;
}

function initMealSwipeRows(list) {
  if (!list) return;
  const rows = list.querySelectorAll(".meal-swipe-row");
  for (let i = 0; i < rows.length; i += 1) {
    initMealSwipeRow(rows[i]);
  }
}

function startVoiceEntry() {
  openManualModal("voice");
  const description = document.getElementById("calorie-manual-description");
  if (description) description.focus();

  const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognitionCtor) {
    manualEntryMode = "manual";
    setManualError("Voice input is not supported here. Type instead.");
    return;
  }

  stopVoiceRecognition();
  setManualError("");
  showVoiceStatus("Listening...");

  const recognition = new SpeechRecognitionCtor();
  voiceRecognition = recognition;
  recognition.lang = navigator.language || "en-US";
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  recognition.onresult = (event) => {
    let transcript = "";
    let hasFinal = false;

    for (let i = event.resultIndex; i < event.results.length; i += 1) {
      const result = event.results[i];
      if (!result || !result[0]) continue;
      transcript += `${result[0].transcript} `;
      if (result.isFinal) hasFinal = true;
    }

    const cleaned = transcript.trim();
    if (description && cleaned) {
      description.value = cleaned;
    }

    if (hasFinal && cleaned) {
      showVoiceStatus("Analyzing voice note...");
      manualEntryMode = "voice";
      void submitManualAnalysis();
      return;
    }

    showVoiceStatus(cleaned ? cleaned : "Listening...");
  };

  recognition.onerror = () => {
    stopVoiceRecognition();
    hideVoiceStatus();
    manualEntryMode = "manual";
    setManualError("Voice input couldn't start. Try typing instead.");
  };

  recognition.onend = () => {
    if (voiceRecognition !== recognition) return;
    voiceRecognition = null;
    if (description && description.value.trim()) {
      hideVoiceStatus();
      return;
    }
    manualEntryMode = "manual";
    showVoiceStatus("Listening stopped. You can type instead.");
  };

  try {
    recognition.start();
  } catch (_err) {
    stopVoiceRecognition();
    hideVoiceStatus();
    manualEntryMode = "manual";
    setManualError("Voice input couldn't start. Try typing instead.");
  }
}

function hasExistingWeightEntries() {
  return !!(latestState && Array.isArray(latestState.chartSeries) && latestState.chartSeries.length > 0);
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
    setSetupError("");
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
  currentStep = Math.max(0, Math.min(STEP_COUNT - 1, stepIndex));
  updateStepTrack();
  updateStepStatus(valuesInput);
}

function canNavigateToStep(targetStep, values, showError) {
  if (targetStep <= currentStep) return true;

  for (let i = 0; i < targetStep; i += 1) {
    const error = validateStep(i, values);
    if (error) {
      if (showError) {
        setSetupError(error);
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
  if (!canNavigateToStep(bounded, values, showError)) return;

  setSetupError("");
  setStep(bounded, values);
}

function handleLiveFormChange() {
  const values = parseStepValues();
  if (!values) return;

  updateStepStatus(values);
  if (!validateStep(currentStep, values)) {
    setSetupError("");
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
      const cm = feetInchesToCm(parseNumber(ftInput.value), parseNumber(inInput.value));
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
        input.value = String(roundToTwo(currentValue / 0.45359237));
      } else if (currentUnit === "lb" && normalized === "kg") {
        input.value = String(roundToTwo(currentValue * 0.45359237));
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

  setSetupError("");
  setStep(0, parseStepValues());
  updateWeightSetupVisibility();
  handleLiveFormChange();
}

function openSetupModal() {
  applyProfileToForm();
  closeTrackerOverlays();
  openOverlay("calorie-setup-modal");
}

function closeSetupModal() {
  closeOverlay("calorie-setup-modal");
}

function submitSetupForm() {
  const values = parseStepValues();
  if (!values) {
    setSetupError("Unable to save setup details.");
    return;
  }

  for (let i = 0; i < STEP_COUNT; i += 1) {
    const validationError = validateStep(i, values);
    if (validationError) {
      setStep(i, values);
      setSetupError(validationError);
      return;
    }
  }

  const roundedHeightCm = roundToTwo(values.heightCm);
  setCalorieProfile({
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
  });

  setUserPreferences({
    heightUnit: values.heightUnit,
    weightUnit: values.weightUnit
  });

  if (!hasExistingWeightEntries()) {
    addWeight(values.weightValue, values.weightUnit);
  }

  latestState = loadState();
  closeSetupModal();
  renderTrackerView(latestState);
  showToast("Calorie setup updated");
}

function bindSetupEvents() {
  const form = document.getElementById("calorie-setup-form");
  if (!form || form.dataset.bound === "1") return;

  form.dataset.bound = "1";
  const onValueChange = () => handleLiveFormChange();

  form.addEventListener("input", onValueChange);
  form.addEventListener("change", onValueChange);
  form.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.defaultPrevented) return;

    const target = event.target;
    if (!(target instanceof HTMLElement) || target.tagName === "TEXTAREA") return;

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
    setSetupError(validationError);
    return false;
  }

  setSetupError("");
  if (currentStep < STEP_COUNT - 1) {
    moveToStep(currentStep + 1, true);
    return true;
  }

  submitSetupForm();
  return true;
}

function bindSwipeGestures() {
  const viewport = document.getElementById("calorie-step-viewport");
  if (!viewport || viewport.dataset.swipeBound === "1") return;

  viewport.dataset.swipeBound = "1";
  viewport.addEventListener("touchstart", (event) => {
    if (!isOverlayOpen("calorie-setup-modal")) return;
    if (!event.touches || event.touches.length !== 1) return;

    touchStartX = event.touches[0].clientX;
    touchStartY = event.touches[0].clientY;
    touchTracking = true;
  }, { passive: true });

  viewport.addEventListener("touchend", (event) => {
    if (!touchTracking || !isOverlayOpen("calorie-setup-modal")) return;
    touchTracking = false;
    if (!event.changedTouches || event.changedTouches.length === 0) return;

    const dx = event.changedTouches[0].clientX - touchStartX;
    const dy = event.changedTouches[0].clientY - touchStartY;
    if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) <= Math.abs(dy)) return;

    if (dx < 0) {
      moveToStep(currentStep + 1, true);
    } else {
      moveToStep(currentStep - 1, false);
      setSetupError("");
    }
  });

  viewport.addEventListener("touchcancel", () => {
    touchTracking = false;
  });
}

export function handleDocumentClick(event) {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return false;

  const fabZone = document.getElementById("calories-fab-zone");
  if (fabZone && !fabZone.contains(target)) {
    closeFabMenu();
  }

  const mealMenuToggle = target.closest("[data-meal-menu-toggle]");
  if (mealMenuToggle) {
    toggleMealMenu(mealMenuToggle.getAttribute("data-meal-menu-toggle"));
    return true;
  }

  if (target.closest("[data-calorie-delete-confirm]")) {
    confirmDeleteMeal();
    return true;
  }

  if (target.closest("[data-calorie-delete-dismiss]")) {
    closeMealDeleteSheet();
    return true;
  }

  const action = target.closest("[data-action]");
  if (action) {
    const actionName = action.getAttribute("data-action");

    if (actionName === "toggle-calorie-fab-menu") {
      toggleFabMenu();
      return true;
    }

    if (actionName === "trigger-scan-food") {
      if (fabLongPressHandled) {
        fabLongPressHandled = false;
        return true;
      }
      triggerScanPicker();
      return true;
    }

    if (actionName === "open-calorie-macro-modal") {
      closeTrackerOverlays("calorie-macro-modal");
      openOverlay("calorie-macro-modal");
      return true;
    }

    if (actionName === "close-calorie-macro-modal") {
      closeOverlay("calorie-macro-modal");
      return true;
    }

    if (actionName === "open-manual-entry-modal") {
      resetManualComposer();
      openManualModal("manual");
      return true;
    }

    if (actionName === "close-manual-entry-modal") {
      closeManualModal();
      return true;
    }

    if (actionName === "choose-manual-photo") {
      const input = document.getElementById("calorie-manual-photo-input");
      if (input) input.click();
      return true;
    }

    if (actionName === "remove-manual-photo") {
      removeManualPhoto(action.getAttribute("data-photo-id"));
      return true;
    }

    if (actionName === "open-voice-entry") {
      resetManualComposer();
      startVoiceEntry();
      closeFabMenu();
      return true;
    }

    if (actionName === "close-calorie-preview-modal") {
      closePreviewModal();
      return true;
    }

    if (actionName === "delete-preview-meal") {
      deletePreviewMeal();
      return true;
    }

    if (actionName === "log-recent-food") {
      handleRecentFoodLog(action.getAttribute("data-meal-id"));
      return true;
    }

    if (actionName === "edit-meal") {
      handleEditMeal(action.getAttribute("data-meal-id"));
      return true;
    }

    if (actionName === "clone-meal") {
      handleCloneMeal(action.getAttribute("data-meal-id"));
      return true;
    }

    if (actionName === "delete-meal") {
      openMealDeleteSheet(action.getAttribute("data-meal-id"));
      return true;
    }

    if (actionName === "enable-calorie-reminders") {
      void enableReminderNotifications();
      return true;
    }

    if (actionName === "open-calorie-goal-modal") {
      openGoalModal();
      return true;
    }

    if (actionName === "close-calorie-goal-modal") {
      closeGoalModal();
      return true;
    }

    if (actionName === "select-calorie-goal-objective") {
      selectGoalObjective(action.getAttribute("data-goal-objective"));
      return true;
    }

    if (actionName === "select-calorie-goal-preset") {
      selectGoalPreset(action.getAttribute("data-goal-preset"));
      return true;
    }

    if (actionName === "go-calorie-goal-step") {
      const index = parseInt(action.getAttribute("data-step-index"), 10);
      if (!Number.isNaN(index)) {
        moveGoalStep(index);
      }
      return true;
    }

    if (actionName === "go-calorie-goal-back") {
      moveGoalStep(goalCurrentStep - 1);
      return true;
    }

    if (actionName === "advance-calorie-goal") {
      advanceGoalFlow();
      return true;
    }

    if (actionName === "open-calorie-goal-setup") {
      openSetupFromGoalModal();
      return true;
    }

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
        moveToStep(index, index > currentStep);
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

  if (openMealMenuId && !target.closest("[data-meal-menu]") && !target.closest("[data-meal-menu-toggle]")) {
    closeOpenMealMenu();
  }

  if (target === document.getElementById("calorie-macro-modal")) {
    closeOverlay("calorie-macro-modal");
    return true;
  }

  if (target === document.getElementById("calorie-manual-modal")) {
    closeManualModal();
    return true;
  }

  if (target === document.getElementById("calorie-preview-modal")) {
    closePreviewModal();
    return true;
  }

  if (target === document.getElementById("calorie-goal-modal")) {
    closeGoalModal();
    return true;
  }

  if (target === document.getElementById("calorie-setup-modal")) {
    closeSetupModal();
    return true;
  }

  return false;
}

export function handleDocumentTouchStart(event) {
  const target = event.target;
  if (openMealSwipeRow && !openMealSwipeRow.contains(event.target)) {
    closeOpenMealSwipeRow();
  }

  if (
    openMealMenuId
    && target
    && typeof target.closest === "function"
    && !target.closest("[data-meal-menu]")
    && !target.closest("[data-meal-menu-toggle]")
  ) {
    closeOpenMealMenu();
  }
}

export function handleSubmit(event) {
  const form = event.target;
  if (!form) return false;

  if (form.id === "calorie-setup-form") {
    event.preventDefault();
    if (currentStep < STEP_COUNT - 1) {
      advanceCurrentStep();
      return true;
    }
    submitSetupForm();
    return true;
  }

  if (form.id === "calorie-manual-form") {
    event.preventDefault();
    void submitManualAnalysis();
    return true;
  }

  if (form.id === "calorie-preview-form") {
    event.preventDefault();
    submitPreviewMeal();
    return true;
  }

  return false;
}

export function handleEscape() {
  closeFabMenu();

  const deleteSheet = document.getElementById("calorie-delete-sheet");
  if (deleteSheet && !deleteSheet.classList.contains("hidden")) {
    closeMealDeleteSheet();
    return;
  }

  if (openMealMenuId) {
    closeOpenMealMenu();
    return;
  }

  if (openMealSwipeRow) {
    closeOpenMealSwipeRow();
    return;
  }

  if (isOverlayOpen("calorie-preview-modal")) {
    closePreviewModal();
    return;
  }

  if (isOverlayOpen("calorie-manual-modal")) {
    closeManualModal();
    return;
  }

  if (isOverlayOpen("calorie-macro-modal")) {
    closeOverlay("calorie-macro-modal");
    return;
  }

  if (isOverlayOpen("calorie-goal-modal")) {
    closeGoalModal();
    return;
  }

  if (isOverlayOpen("calorie-setup-modal")) {
    closeSetupModal();
  }
}

export function onViewportChange() {
  if (resizeFrame !== null) return;

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;

    const root = document.getElementById("calories-page-root");
    if (!root) {
      lastCaloriesUiMode = null;
      return;
    }

    const useMobileUi = isMobileCaloriesUI();
    if (lastCaloriesUiMode === null) {
      lastCaloriesUiMode = useMobileUi;
      return;
    }

    closeOpenMealMenu();
    closeOpenMealSwipeRow();

    if (useMobileUi !== lastCaloriesUiMode) {
      renderTrackerView(latestState || loadState());
    }
  });
}

export function resetViewUiState() {
  currentStep = 0;
  goalCurrentStep = 0;
  selectedGoalObjective = "";
  selectedGoalPresetKey = "";
  touchTracking = false;
  previewDraft = null;
  previewMode = "create";
  revokeManualPhotoPreviews();
  manualEntryMode = "manual";
  fabLongPressHandled = false;
  pendingDeleteMealId = null;
  openMealSwipeRow = null;
  openMealMenuId = null;
  lastCaloriesUiMode = null;

  clearTimer(fabLongPressTimer);
  fabLongPressTimer = null;
  if (resizeFrame !== null) {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = null;
  }
  clearToastTimers();
  clearDeleteSheetTransitionWatcher();
  clearCalorieOverlayUnlockWaiters();
  stopVoiceRecognition();

  hideVoiceStatus();
  setManualError("");
  setPreviewError("");
  setSetupError("");
  setGoalError("");
  closeFabMenu();

  const deleteSheet = document.getElementById("calorie-delete-sheet");
  if (deleteSheet) {
    deleteSheet.classList.remove("is-open");
    deleteSheet.classList.remove("is-closing");
    deleteSheet.classList.add("hidden");
    deleteSheet.setAttribute("aria-hidden", "true");
  }
  setDeleteSheetOpenState(false);
  hideOverlayImmediately("calorie-macro-modal");
  hideOverlayImmediately("calorie-manual-modal");
  hideOverlayImmediately("calorie-preview-modal");
  hideOverlayImmediately("calorie-goal-modal");
  hideOverlayImmediately("calorie-setup-modal");
  unlockCalorieOverlayScrollNow();
}

export function render(state) {
  const root = document.getElementById("calories-page-root");
  if (!root) return;

  latestState = state || loadState();
  if (!latestState.user) return;

  bindSetupEvents();
  bindSwipeGestures();
  bindManualEvents();
  bindFabGesture();
  updateWeightSetupVisibility();
  renderTrackerView(latestState);
}
