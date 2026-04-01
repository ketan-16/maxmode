import {
  addWeight,
  deleteWeight,
  getWeightById,
  getUserPreferences,
  loadState,
  updateWeight
} from "../modules/storage.mjs";
import {
  buildWeightLogGroups,
  convertWeightForDisplay,
  escapeHtml,
  formatDate,
  formatEntryCount,
  formatWeightNumber,
  formatTime,
  mapWeightsToDisplay,
  relativeTime,
  weightLogHasEntries
} from "../modules/data-utils.mjs";
import {
  bindWeightChartRangeEvents,
  renderWeightsTrendChart
} from "../modules/charts.mjs";
import {
  cssEscape,
  getMaxTransitionMs,
  onTransitionEndOrTimeout
} from "../modules/motion-utils.mjs";
import { createBodyScrollLock } from "../modules/scroll-lock.mjs";
import { initSwipeRows } from "../modules/swipe-row.mjs";
import {
  kgToLb,
  resolveCalorieGoalFromState
} from "../modules/calories-utils.mjs";

const SWIPE_CONFIG = {
  SNAP_PX: 52,
  FULL_FRAC: 0.72,
  DAMP: 0.48,
  FLICK_VELOCITY: -0.45,
  OPEN_EXTRA_PX: 8,
  MIN_OPEN_PX: 88
};

const ICONS = {
  KEBAB: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"></circle><circle cx="12" cy="12" r="2"></circle><circle cx="19" cy="12" r="2"></circle></svg>',
  EDIT: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zm17.71-10.21a1 1 0 000-1.41l-2.34-2.34a1 1 0 00-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"></path></svg>',
  DELETE: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zm12-15h-3.5l-1-1h-5l-1 1H4v2h14V4z"></path></svg>'
};

let editingWeightId = null;
let pendingDeleteWeightId = null;
let openSwipeRow = null;
let openDesktopMenuId = null;
let lastWeightUiMode = null;
let resizeFrame = null;
let weightModalTransitionCleanup = null;
let deleteSheetTransitionCleanup = null;
let latestState = null;
let requestRender = () => {};
let weightInputUnit = "kg";
let calorieToastTimer = null;
let calorieToastHideTimer = null;

export function setRequestRender(fn) {
  requestRender = (typeof fn === "function") ? fn : (() => {});
}

function setDeleteSheetOpenState(isOpen) {
  if (!document.body) return;
  document.body.classList.toggle("is-delete-sheet-open", !!isOpen);
}

function clearWeightModalTransitionWatcher() {
  if (typeof weightModalTransitionCleanup === "function") {
    const cleanup = weightModalTransitionCleanup;
    weightModalTransitionCleanup = null;
    cleanup();
  }
}

function clearDeleteSheetTransitionWatcher() {
  if (typeof deleteSheetTransitionCleanup === "function") {
    const cleanup = deleteSheetTransitionCleanup;
    deleteSheetTransitionCleanup = null;
    cleanup();
  }
}

function isMobileWeightUI() {
  const ua = navigator.userAgent || "";
  const touchPoints = navigator.maxTouchPoints || 0;
  const isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
  if (isIpad) return true;

  const isTouchDevice = touchPoints > 0 || ("ontouchstart" in window);
  if (!isTouchDevice) return false;

  return window.matchMedia("(max-width: 1024px)").matches || /Android|iPhone|iPod|Mobile|Tablet/i.test(ua);
}

const weightModalScrollLock = createBodyScrollLock({
  isMobileUi: isMobileWeightUI
});

function focusWeightInput(input, selectValue) {
  if (!input) return;

  window.setTimeout(() => {
    try {
      input.focus({ preventScroll: true });
    } catch {
      input.focus();
    }

    if (selectValue) {
      input.select();
    }
  }, 0);
}

function closeOpenSwipeRow() {
  if (openSwipeRow && typeof openSwipeRow._close === "function") {
    openSwipeRow._close();
  }
  openSwipeRow = null;
}

function closeDesktopMenu() {
  if (!openDesktopMenuId) return;

  const escapedId = cssEscape(openDesktopMenuId);
  const menu = document.querySelector(`[data-weight-menu="${escapedId}"]`);
  const trigger = document.querySelector(`[data-weight-menu-toggle="${escapedId}"]`);

  if (menu) menu.classList.remove("open");
  if (trigger) trigger.setAttribute("aria-expanded", "false");
  openDesktopMenuId = null;
}

function toggleDesktopMenu(id) {
  if (!id) return;

  if (openDesktopMenuId === id) {
    closeDesktopMenu();
    return;
  }

  closeDesktopMenu();

  const escapedId = cssEscape(id);
  const menu = document.querySelector(`[data-weight-menu="${escapedId}"]`);
  const trigger = document.querySelector(`[data-weight-menu-toggle="${escapedId}"]`);

  if (!menu || !trigger) return;

  menu.classList.add("open");
  trigger.setAttribute("aria-expanded", "true");
  openDesktopMenuId = id;
}

function setWeightModalMode(isEdit) {
  const title = document.getElementById("weight-modal-title");
  const submitLabel = document.getElementById("weight-submit-label");
  const inputLabel = document.getElementById("weight-input-label");
  const unitLabel = (weightInputUnit === "lb") ? "lb" : "kg";
  if (title) title.textContent = isEdit ? "Edit Weight" : "Log Weight";
  if (submitLabel) submitLabel.textContent = isEdit ? "Save Changes" : "Save";
  if (inputLabel) inputLabel.textContent = `Weight (${unitLabel})`;
}

function clearCalorieToastTimers() {
  if (calorieToastTimer !== null) {
    window.clearTimeout(calorieToastTimer);
    calorieToastTimer = null;
  }
  if (calorieToastHideTimer !== null) {
    window.clearTimeout(calorieToastHideTimer);
    calorieToastHideTimer = null;
  }
}

function hideCalorieToast() {
  const toast = document.getElementById("calorie-update-toast");
  if (!toast) return;

  clearCalorieToastTimers();
  toast.classList.remove("is-visible");
  calorieToastHideTimer = window.setTimeout(() => {
    toast.classList.add("hidden");
    calorieToastHideTimer = null;
  }, 180);
}

function showCalorieUpdateToast(message = "Maintenance calories adjusted to current weight") {
  const toast = document.getElementById("calorie-update-toast");
  if (!toast) return;

  clearCalorieToastTimers();
  toast.textContent = message;
  toast.classList.remove("hidden");
  requestAnimationFrame(() => {
    toast.classList.add("is-visible");
  });

  calorieToastTimer = window.setTimeout(() => {
    hideCalorieToast();
  }, 2600);
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function getPreferredWeightUnit(state) {
  const preferences = getUserPreferences(state);
  return preferences.weightUnit === "lb" ? "lb" : "kg";
}

function getDisplayWeightEntries(state) {
  const source = state && Array.isArray(state.weights) ? state.weights : [];
  return mapWeightsToDisplay(source, getPreferredWeightUnit(state));
}

function getDisplayChartSeries(state) {
  const source = state && Array.isArray(state.chartSeries) ? state.chartSeries : [];
  return mapWeightsToDisplay(source, getPreferredWeightUnit(state));
}

function setWeightInputUnit(unit, shouldConvertValue = true) {
  const normalized = (unit === "lb") ? "lb" : "kg";
  const hiddenUnitInput = document.getElementById("weight-input-unit");
  const input = document.getElementById("weight-input");
  if (!hiddenUnitInput || !input) return;

  const current = (hiddenUnitInput.value === "lb") ? "lb" : "kg";
  if (current !== normalized && shouldConvertValue) {
    const value = parseFloat(input.value);
    if (Number.isFinite(value) && value > 0) {
      let converted = value;
      if (current === "kg" && normalized === "lb") {
        const pounds = kgToLb(value);
        converted = Number.isFinite(pounds) ? pounds : value;
      } else if (current === "lb" && normalized === "kg") {
        converted = value * 0.45359237;
      }
      input.value = String(roundToTwo(converted));
    }
  }

  hiddenUnitInput.value = normalized;
  weightInputUnit = normalized;
  setWeightModalMode(!!editingWeightId);
}

function desktopWeightRowHtml(weight) {
  const id = escapeHtml(weight.id);
  const formattedWeight = `${formatWeightNumber(weight.weight)} ${weight.unit}`;
  return '<tr class="apple-table-row">'
    + `<td class="apple-table-cell">${escapeHtml(formatDate(weight.timestamp))}</td>`
    + `<td class="apple-table-cell apple-table-cell-muted">${escapeHtml(formatTime(weight.timestamp))}</td>`
    + `<td class="apple-table-cell apple-table-cell-strong apple-table-cell-right">${escapeHtml(formattedWeight)}</td>`
    + '<td class="apple-table-cell apple-table-cell-right weight-actions-cell">'
    + `<button type="button" class="weight-kebab-trigger" aria-label="Open actions menu" aria-haspopup="menu" aria-expanded="false" data-weight-menu-toggle="${id}">`
    + ICONS.KEBAB
    + "</button>"
    + `<div class="weight-kebab-menu" role="menu" data-weight-menu="${id}">`
    + `<button type="button" class="weight-kebab-item" role="menuitem" data-weight-action="edit" data-weight-id="${id}">Edit</button>`
    + `<button type="button" class="weight-kebab-item danger" role="menuitem" data-weight-action="delete" data-weight-id="${id}">Delete</button>`
    + "</div>"
    + "</td>"
    + "</tr>";
}

function mobileWeightRowHtml(weight) {
  const id = escapeHtml(weight.id);
  const formattedWeight = `${formatWeightNumber(weight.weight)} ${weight.unit}`;
  return `<article class="weight-swipe-row" data-weight-id="${id}">`
    + '<div class="weight-pill-actions">'
    + `<button type="button" class="weight-pill-btn edit" aria-label="Edit weight" data-weight-action="edit" data-weight-id="${id}">${ICONS.EDIT}</button>`
    + `<button type="button" class="weight-pill-btn delete" aria-label="Delete weight" data-weight-action="delete" data-weight-id="${id}">${ICONS.DELETE}</button>`
    + "</div>"
    + '<div class="weight-row-content">'
    + '<div class="weight-row-main">'
    + `<p class="weight-row-weight">${escapeHtml(formattedWeight)}</p>`
    + `<p class="weight-row-meta">${escapeHtml(`${formatDate(weight.timestamp)} · ${formatTime(weight.timestamp)}`)}</p>`
    + "</div>"
    + `<div class="weight-row-relative">${escapeHtml(relativeTime(weight.timestamp))}</div>`
    + "</div>"
    + "</article>";
}

function desktopWeightGroupHtml(group) {
  const rows = new Array(group.entries.length);
  for (let i = 0; i < group.entries.length; i += 1) {
    rows[i] = desktopWeightRowHtml(group.entries[i]);
  }

  return `<section class="weight-log-group" data-weight-log-group="${escapeHtml(group.key)}">`
    + '<div class="weight-log-group-header">'
    + `<p class="apple-overline weight-log-group-title">${escapeHtml(group.title)}</p>`
    + `<p class="apple-caption weight-log-group-count">${escapeHtml(formatEntryCount(group.entries.length))}</p>`
    + "</div>"
    + '<div class="apple-card apple-table-card">'
    + '<table class="apple-table">'
    + "<thead>"
    + '<tr class="apple-table-head-row">'
    + '<th class="apple-table-head-cell">Date</th>'
    + '<th class="apple-table-head-cell">Time</th>'
    + '<th class="apple-table-head-cell apple-table-head-cell-right">Weight</th>'
    + '<th class="apple-table-head-cell apple-table-head-cell-right">Actions</th>'
    + "</tr>"
    + "</thead>"
    + '<tbody class="apple-table-body">'
    + rows.join("")
    + "</tbody>"
    + "</table>"
    + "</div>"
    + "</section>";
}

function mobileWeightGroupHtml(group) {
  const rows = new Array(group.entries.length);
  for (let i = 0; i < group.entries.length; i += 1) {
    rows[i] = mobileWeightRowHtml(group.entries[i]);
  }

  return `<section class="weight-log-group" data-weight-log-group="${escapeHtml(group.key)}">`
    + '<div class="weight-log-group-header">'
    + `<p class="apple-overline weight-log-group-title">${escapeHtml(group.title)}</p>`
    + `<p class="apple-caption weight-log-group-count">${escapeHtml(formatEntryCount(group.entries.length))}</p>`
    + "</div>"
    + '<div class="weight-mobile-list">'
    + rows.join("")
    + "</div>"
    + "</section>";
}

function renderDesktopWeightGroups(groups, container) {
  if (!container) return;

  const markup = [];
  for (let i = 0; i < groups.length; i += 1) {
    if (!groups[i].entries || groups[i].entries.length === 0) continue;
    markup.push(desktopWeightGroupHtml(groups[i]));
  }

  container.innerHTML = markup.join("");
}

function renderMobileWeightGroups(groups, container) {
  if (!container) return;

  const markup = [];
  for (let i = 0; i < groups.length; i += 1) {
    if (!groups[i].entries || groups[i].entries.length === 0) continue;
    markup.push(mobileWeightGroupHtml(groups[i]));
  }

  container.innerHTML = markup.join("");
}

function initWeightSwipeRows(list) {
  initSwipeRows(list, {
    rowSelector: ".weight-swipe-row",
    contentSelector: ".weight-row-content",
    actionsSelector: ".weight-pill-actions",
    buttonSelector: ".weight-pill-btn",
    deleteButtonSelector: ".weight-pill-btn.delete",
    config: SWIPE_CONFIG,
    revealThresholdBase: 0.08,
    revealThresholdStep: 0.14,
    getOpenRow() {
      return openSwipeRow;
    },
    setOpenRow(row) {
      openSwipeRow = row;
    },
    getDeleteId(row) {
      return row.getAttribute("data-weight-id");
    },
    onDelete(weightId) {
      openDeleteSheet(weightId);
    }
  });
}

function setLatestState(state) {
  latestState = state || loadState();
  if (!editingWeightId) {
    weightInputUnit = getPreferredWeightUnit(latestState);
  }
}

export function openWeightModal(weightId) {
  const modal = document.getElementById("weight-modal");
  const input = document.getElementById("weight-input");
  const unitInput = document.getElementById("weight-input-unit");
  if (!modal || !input || !unitInput) return;

  const isEdit = (typeof weightId === "string" && weightId.length > 0);
  const preferredUnit = getPreferredWeightUnit(latestState || loadState());
  let entry = null;

  if (isEdit) {
    entry = getWeightById(weightId);
    if (!entry) return;
  }

  weightModalScrollLock.lock();
  clearWeightModalTransitionWatcher();

  if (isEdit) {
    editingWeightId = entry.id;
    setWeightInputUnit(preferredUnit, false);
    const converted = convertWeightForDisplay(entry.weight, preferredUnit);
    const displayWeight = (converted.value !== null) ? converted.value : entry.weight;
    input.value = formatWeightNumber(displayWeight);
    const shouldSelectOnFocus = !isMobileWeightUI();
    setWeightModalMode(true);
    modal.classList.remove("hidden");
    modal.classList.remove("is-closing");
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => {
      modal.classList.add("is-open");
    });
    focusWeightInput(input, shouldSelectOnFocus);
    return;
  }

  editingWeightId = null;
  setWeightInputUnit(preferredUnit, false);
  setWeightModalMode(false);
  modal.classList.remove("hidden");
  modal.classList.remove("is-closing");
  modal.setAttribute("aria-hidden", "false");
  requestAnimationFrame(() => {
    modal.classList.add("is-open");
  });
  input.value = "";
  focusWeightInput(input, false);
}

export function closeWeightModal() {
  const modal = document.getElementById("weight-modal");
  const input = document.getElementById("weight-input");
  const active = document.activeElement;

  const modalIsOpen = !!(modal && !modal.classList.contains("hidden"));
  const activeIsFormControl = !!(active && typeof active.matches === "function" && active.matches("input, textarea, select, [contenteditable='true']"));
  const shouldBlur = !!(modalIsOpen && active && typeof active.blur === "function" && (active === input || (modal && modal.contains(active)) || activeIsFormControl));

  if (shouldBlur) {
    active.blur();
  }

  clearWeightModalTransitionWatcher();
  if (modal && !modal.classList.contains("hidden")) {
    modal.classList.remove("is-open");
    modal.classList.add("is-closing");
    modal.setAttribute("aria-hidden", "true");

    const modalPanel = modal.querySelector(".apple-modal-weight") || modal;
    const closeMs = Math.max(getMaxTransitionMs(modal), getMaxTransitionMs(modalPanel)) + 48;

    weightModalTransitionCleanup = onTransitionEndOrTimeout(modalPanel, closeMs, () => {
      weightModalTransitionCleanup = null;
      if (modal.classList.contains("is-open")) return;
      modal.classList.remove("is-closing");
      modal.classList.add("hidden");
    });
  } else if (modal) {
    modal.classList.remove("is-open");
    modal.classList.remove("is-closing");
    modal.setAttribute("aria-hidden", "true");
  }

  if (input) input.value = "";

  editingWeightId = null;
  setWeightModalMode(false);
  weightModalScrollLock.unlockAfterKeyboard();
}

function openDeleteSheet(weightId) {
  if (!weightId) return;

  const sheet = document.getElementById("weight-delete-sheet");
  if (!sheet) {
    if (confirm("Delete this entry?")) {
      if (deleteWeight(weightId)) {
        requestRender();
      }
    }
    return;
  }

  pendingDeleteWeightId = weightId;
  closeDesktopMenu();
  closeOpenSwipeRow();
  clearDeleteSheetTransitionWatcher();

  sheet.classList.remove("hidden");
  sheet.classList.remove("is-closing");
  sheet.setAttribute("aria-hidden", "false");
  setDeleteSheetOpenState(true);

  requestAnimationFrame(() => {
    sheet.classList.add("is-open");
  });
}

export function closeDeleteSheet(shouldClearPending = true) {
  const sheet = document.getElementById("weight-delete-sheet");

  if (shouldClearPending) {
    pendingDeleteWeightId = null;
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

export function confirmDeleteWeight() {
  const deletingId = pendingDeleteWeightId;
  if (!deletingId) return;

  closeDeleteSheet(false);
  pendingDeleteWeightId = null;

  if (!deleteWeight(deletingId)) return;
  requestRender();
}

export function handleWeightAction(action, weightId) {
  if (!action || !weightId) return;

  if (action === "edit") {
    closeDesktopMenu();
    closeOpenSwipeRow();
    openWeightModal(weightId);
    return;
  }

  if (action === "delete") {
    openDeleteSheet(weightId);
  }
}

export function handleWeightSubmit(event) {
  if (event) event.preventDefault();
  const input = document.getElementById("weight-input");
  const unitInput = document.getElementById("weight-input-unit");
  if (!input || !unitInput) return;

  const value = parseFloat(input.value);
  if (!Number.isFinite(value) || value <= 0) return;
  const unit = (unitInput.value === "lb") ? "lb" : "kg";

  const beforeSummary = resolveCalorieGoalFromState(loadState());

  if (editingWeightId) {
    if (!updateWeight(editingWeightId, value, unit)) return;
  } else {
    addWeight(value, unit);
  }

  const afterSummary = resolveCalorieGoalFromState(loadState());
  if (beforeSummary && afterSummary && beforeSummary.goalCalories !== afterSummary.goalCalories) {
    showCalorieUpdateToast(
      afterSummary.goalSource === "saved-goal"
        ? "Calorie goal adjusted to current weight"
        : "Maintenance calories adjusted to current weight"
    );
  }

  closeWeightModal();
  requestRender();
}

export function onViewportChange() {
  if (resizeFrame !== null) return;

  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null;

    const desktopGroups = document.getElementById("weight-desktop-groups");
    const mobileGroups = document.getElementById("weight-mobile-groups");
    if (!desktopGroups || !mobileGroups) {
      renderWeightsTrendChart(getDisplayChartSeries(latestState));
      return;
    }

    const useMobileUi = isMobileWeightUI();
    if (lastWeightUiMode === null) {
      lastWeightUiMode = useMobileUi;
      renderWeightsTrendChart(getDisplayChartSeries(latestState));
      return;
    }

    if (useMobileUi !== lastWeightUiMode) {
      requestRender();
    } else {
      renderWeightsTrendChart(getDisplayChartSeries(latestState));
    }
  });
}

function bindChartControls() {
  bindWeightChartRangeEvents(() => {
    renderWeightsTrendChart(getDisplayChartSeries(latestState));
  });
}

export function resetViewUiState() {
  clearWeightModalTransitionWatcher();
  clearDeleteSheetTransitionWatcher();
  editingWeightId = null;
  pendingDeleteWeightId = null;
  weightInputUnit = "kg";
  closeDesktopMenu();
  closeOpenSwipeRow();
  weightModalScrollLock.unlockNow();
  setDeleteSheetOpenState(false);
  hideCalorieToast();
}

export function handleDocumentClick(event) {
  const target = event.target;

  const actionBtn = target.closest("[data-weight-action]");
  if (actionBtn) {
    handleWeightAction(
      actionBtn.getAttribute("data-weight-action"),
      actionBtn.getAttribute("data-weight-id")
    );
    return true;
  }

  const menuToggle = target.closest("[data-weight-menu-toggle]");
  if (menuToggle) {
    toggleDesktopMenu(menuToggle.getAttribute("data-weight-menu-toggle"));
    return true;
  }

  if (target.closest("[data-weight-delete-confirm]")) {
    confirmDeleteWeight();
    return true;
  }

  if (target.closest("[data-weight-delete-dismiss]")) {
    closeDeleteSheet();
    return true;
  }

  const modal = document.getElementById("weight-modal");
  if (target === modal) {
    closeWeightModal();
    return true;
  }

  if (openDesktopMenuId && !target.closest("[data-weight-menu]")) {
    closeDesktopMenu();
  }

  return false;
}

export function handleDocumentTouchStart(event) {
  if (openSwipeRow && !openSwipeRow.contains(event.target)) {
    closeOpenSwipeRow();
  }
}

export function handleEscape() {
  closeDeleteSheet();
  closeDesktopMenu();
  closeOpenSwipeRow();
  closeWeightModal();
}

export function render(state) {
  setLatestState(state || loadState());

  const desktopGroups = document.getElementById("weight-desktop-groups");
  const mobileGroups = document.getElementById("weight-mobile-groups");
  if (!desktopGroups || !mobileGroups) {
    lastWeightUiMode = null;
    return;
  }

  setWeightInputUnit(weightInputUnit, false);
  bindChartControls();
  renderWeightsTrendChart(getDisplayChartSeries(latestState));

  const groups = buildWeightLogGroups(getDisplayWeightEntries(latestState));
  const emptyState = document.getElementById("weight-empty-state");
  const desktopContainer = document.getElementById("weight-desktop-groups-container");
  const mobileContainer = document.getElementById("weight-mobile-groups-container");

  closeDesktopMenu();
  closeOpenSwipeRow();

  if (!weightLogHasEntries(groups)) {
    if (emptyState) emptyState.classList.remove("hidden");
    if (desktopContainer) desktopContainer.classList.add("hidden");
    if (mobileContainer) mobileContainer.classList.add("hidden");
    desktopGroups.innerHTML = "";
    mobileGroups.innerHTML = "";
    closeDeleteSheet();
    return;
  }

  if (emptyState) emptyState.classList.add("hidden");

  const useMobileUi = isMobileWeightUI();
  lastWeightUiMode = useMobileUi;

  if (useMobileUi) {
    if (mobileContainer) mobileContainer.classList.remove("hidden");
    if (desktopContainer) desktopContainer.classList.add("hidden");
    renderMobileWeightGroups(groups, mobileGroups);
    initWeightSwipeRows(mobileGroups);
  } else {
    if (desktopContainer) desktopContainer.classList.remove("hidden");
    if (mobileContainer) mobileContainer.classList.add("hidden");
    renderDesktopWeightGroups(groups, desktopGroups);
  }
}
