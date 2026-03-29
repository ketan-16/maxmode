import {
  addMeal,
  addWeight,
  deleteMeal,
  getCalorieTrackerMeta,
  getMealById,
  getUserPreferences,
  loadState,
  setCalorieProfile,
  setCalorieTrackerMeta,
  setUserPreferences,
  updateMeal
} from "../modules/storage.mjs";
import {
  ACTIVITY_OPTIONS,
  cmToFeetInches,
  feetInchesToCm,
  weightToKg
} from "../modules/calories-utils.mjs";
import { escapeHtml, formatTime, getHeightDisplay } from "../modules/data-utils.mjs";
import {
  buildCalorieTrackerSummary,
  clampPortion,
  getLocalDayKey,
  scaleMealNutrition
} from "../modules/meal-utils.mjs";

const STEP_COUNT = 3;
const SWIPE_THRESHOLD = 56;
const OVERLAY_CLOSE_MS = 220;
const TOAST_VISIBLE_MS = 2400;
const FAB_LONG_PRESS_MS = 420;

let currentStep = 0;
let latestState = null;
let closeTimers = new Map();
let touchStartX = 0;
let touchStartY = 0;
let touchTracking = false;
let toastTimer = null;
let toastHideTimer = null;
let manualPhotoFile = null;
let manualEntryMode = "manual";
let previewDraft = null;
let previewMode = "create";
let fabLongPressTimer = null;
let fabLongPressHandled = false;
let voiceRecognition = null;

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

function formatMacroProgress(current, target) {
  return `${formatCalories(current)}/${formatCalories(target)}g`;
}

function getMacroTargets(goalCalories) {
  const safeGoal = Math.max(0, Math.round(goalCalories || 0));
  return {
    protein: Math.round((safeGoal * 0.3) / 4),
    carbs: Math.round((safeGoal * 0.4) / 4),
    fat: Math.round((safeGoal * 0.3) / 9)
  };
}

function setRadialProgress(ratio) {
  const segments = document.querySelectorAll("[data-radial-segment]");
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
}

function openOverlay(id) {
  const overlay = getOverlayElement(id);
  if (!overlay) return;

  clearTimer(closeTimers.get(id) || null);
  closeTimers.delete(id);
  overlay.classList.remove("hidden");
  overlay.classList.remove("is-closing");
  overlay.setAttribute("aria-hidden", "false");
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
  }, OVERLAY_CLOSE_MS);

  closeTimers.set(id, timer);
}

function closeTrackerOverlays(exceptId = "") {
  const overlays = [
    "calorie-macro-modal",
    "calorie-manual-modal",
    "calorie-preview-modal"
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

function setManualBusy(isBusy) {
  const submitBtn = document.getElementById("calorie-manual-submit");
  const description = document.getElementById("calorie-manual-description");
  if (submitBtn) {
    submitBtn.disabled = isBusy;
    submitBtn.textContent = isBusy ? "Analyzing..." : "Analyze meal";
  }
  if (description) description.disabled = isBusy;
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

  menu.classList.toggle("hidden", !isOpen);
  menu.setAttribute("aria-hidden", isOpen ? "false" : "true");
  toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
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

function resetManualComposer() {
  const description = document.getElementById("calorie-manual-description");
  const photoName = document.getElementById("calorie-manual-photo-name");
  const photoInput = document.getElementById("calorie-manual-photo-input");

  manualPhotoFile = null;
  manualEntryMode = "manual";

  if (description) description.value = "";
  if (photoName) photoName.textContent = "No photo selected";
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

function updatePreviewMetrics() {
  if (!previewDraft) return;

  const nameInput = document.getElementById("calorie-preview-name");
  const slider = document.getElementById("calorie-portion-slider");
  const portionValue = document.getElementById("calorie-portion-value");
  const caloriesValue = document.getElementById("calorie-preview-calories");
  const proteinValue = document.getElementById("calorie-preview-protein");
  const carbsValue = document.getElementById("calorie-preview-carbs");
  const fatValue = document.getElementById("calorie-preview-fat");

  const portion = clampPortion(slider ? slider.value : previewDraft.portion);
  const scaled = scaleMealNutrition(previewDraft, portion);
  previewDraft.portion = portion;

  if (nameInput) {
    previewDraft.name = nameInput.value.trim() || previewDraft.name;
  }

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

  title.textContent = (previewDraft.mode === "edit") ? "Edit meal" : "Confirm meal";
  source.textContent = getPreviewSourceLabel(previewDraft.source);
  nameInput.value = previewDraft.name;
  slider.value = String(previewDraft.portion);
  confidence.textContent = getConfidenceCopy(previewDraft.confidence);
  submitLabel.textContent = (previewDraft.mode === "edit") ? "Save meal" : "Add meal";
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

function renderRecentFoods(summary) {
  const container = document.getElementById("calorie-recent-foods");
  if (!container) return;

  const recentFoods = summary && Array.isArray(summary.recentFoods) ? summary.recentFoods : [];
  if (recentFoods.length === 0) {
    container.innerHTML = '<p class="apple-caption calories-recent-empty">Recent foods will appear here after your first meal.</p>';
    return;
  }

  const markup = [];
  for (let i = 0; i < recentFoods.length; i += 1) {
    const item = recentFoods[i];
    markup.push(`
      <button type="button" class="calories-recent-food" data-action="log-recent-food" data-meal-id="${escapeHtml(item.id)}">
        <span class="calories-recent-food-name">${escapeHtml(item.name)}</span>
        <span class="calories-recent-food-meta">${formatCalories(item.calories)} kcal</span>
      </button>
    `);
  }

  container.innerHTML = markup.join("");
}

function renderFeed(summary) {
  const emptyState = document.getElementById("calories-empty-state");
  const list = document.getElementById("meal-feed-list");
  const feedMeta = document.getElementById("calories-feed-meta");

  if (!emptyState || !list || !feedMeta) return;

  const meals = summary && Array.isArray(summary.meals) ? summary.meals : [];
  const todayCount = summary ? summary.mealCount : 0;

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
    return;
  }

  emptyState.classList.add("hidden");

  const markup = [];
  for (let i = 0; i < meals.length; i += 1) {
    const meal = meals[i];
    markup.push(`
      <button type="button" class="meal-feed-card" data-action="edit-meal" data-meal-id="${escapeHtml(meal.id)}" role="listitem">
        <div class="meal-feed-leading">
          <span class="meal-feed-badge" aria-hidden="true">${getMealBadgeIcon(meal.source)}</span>
          <div class="meal-feed-copy">
            <p class="meal-feed-name">${escapeHtml(meal.name)}</p>
            <p class="meal-feed-meta">${escapeHtml(formatFeedTimestamp(meal.loggedAt))}</p>
          </div>
        </div>
        <div class="meal-feed-calories">
          <p class="meal-feed-calories-value">${formatCalories(meal.calories)}</p>
          <p class="meal-feed-calories-unit">kcal</p>
        </div>
      </button>
    `);
  }

  list.innerHTML = markup.join("");
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

  goalCopy.textContent = summary.goalSource === "maintenance"
    ? `Goal is based on your maintenance estimate: ${goalText}.`
    : `Goal is using the quick default estimate: ${goalText}.`;
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

  const macroTargets = getMacroTargets(summary.goalCalories);

  maintenanceCopy.textContent = summary.maintenanceCalories
    ? `Maintenance ${formatCalories(summary.maintenanceCalories)} kcal`
    : "Maintenance --";
  goalCopy.textContent = `Goal ${formatCalories(summary.goalCalories)} kcal`;
  remainingValue.textContent = formatCalories(summary.remainingCalories);
  remainingLabel.textContent = "Remaining";
  proteinValue.textContent = formatMacroProgress(summary.protein, macroTargets.protein);
  carbsValue.textContent = formatMacroProgress(summary.carbs, macroTargets.carbs);
  fatValue.textContent = formatMacroProgress(summary.fat, macroTargets.fat);

  setRadialProgress(summary.progressRatioCapped);
}

function renderTrackerView(state) {
  latestState = state || loadState();
  const summary = buildCalorieTrackerSummary(latestState);

  renderSummaryCard(summary);
  renderMacroModal(summary);
  renderReminder(summary);
  renderFeed(summary);
  renderRecentFoods(summary);
  maybeSendReminderNotification(summary);
}

async function requestMealEstimate({ mode, note, file }) {
  const formData = new FormData();
  formData.set("mode", mode || "manual");
  formData.set("note", note || "");
  if (file) {
    formData.set("image", file);
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
      file
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

  if (!note && !manualPhotoFile) {
    setManualError("Add a description or a photo.");
    return true;
  }

  setManualBusy(true);

  try {
    const meal = await requestMealEstimate({
      mode: manualEntryMode,
      note,
      file: manualPhotoFile
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
  const meal = getMealById(mealId);
  if (!meal) return;
  openPreviewModalWithDraft(meal, "edit");
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
    showToast(`${name} added`);
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
      const file = photoInput.files && photoInput.files[0] ? photoInput.files[0] : null;
      manualPhotoFile = file;
      const photoName = document.getElementById("calorie-manual-photo-name");
      if (photoName) {
        photoName.textContent = file ? file.name : "No photo selected";
      }
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
  showToast("Daily goal updated");
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

    if (actionName === "enable-calorie-reminders") {
      void enableReminderNotifications();
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

  if (target === document.getElementById("calorie-setup-modal")) {
    closeSetupModal();
    return true;
  }

  return false;
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

  if (isOverlayOpen("calorie-setup-modal")) {
    closeSetupModal();
  }
}

export function resetViewUiState() {
  currentStep = 0;
  touchTracking = false;
  previewDraft = null;
  previewMode = "create";
  manualPhotoFile = null;
  manualEntryMode = "manual";
  fabLongPressHandled = false;

  clearTimer(fabLongPressTimer);
  fabLongPressTimer = null;
  clearToastTimers();
  stopVoiceRecognition();

  hideVoiceStatus();
  setManualError("");
  setPreviewError("");
  setSetupError("");
  closeFabMenu();

  hideOverlayImmediately("calorie-macro-modal");
  hideOverlayImmediately("calorie-manual-modal");
  hideOverlayImmediately("calorie-preview-modal");
  hideOverlayImmediately("calorie-setup-modal");
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
