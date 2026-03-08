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
  escapeHtml,
  formatDate,
  formatEntryCount,
  formatWeightNumber,
  formatTime,
  relativeTime,
  weightLogHasEntries
} from "../modules/data-utils.mjs";
import {
  bindWeightChartRangeEvents,
  renderWeightsTrendChart
} from "../modules/charts.mjs";
import {
  calculateMaintenanceFromState,
  kgToLb
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
let weightModalScrollY = 0;
let weightModalScrollLocked = false;
let weightModalUnlockTimer = null;
let weightModalViewportCleanup = null;
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

function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/([\\"'])/g, "\\$1");
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

  function onEnd(e) {
    if (e.target !== element) return;
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

function clearWeightModalUnlockWaiters() {
  if (weightModalUnlockTimer !== null) {
    window.clearTimeout(weightModalUnlockTimer);
    weightModalUnlockTimer = null;
  }

  if (typeof weightModalViewportCleanup === "function") {
    const cleanup = weightModalViewportCleanup;
    weightModalViewportCleanup = null;
    cleanup();
  }
}

function lockWeightModalScroll() {
  clearWeightModalUnlockWaiters();
  if (weightModalScrollLocked) return;

  weightModalScrollY = window.scrollY || window.pageYOffset || 0;
  document.body.classList.add("modal-scroll-locked");
  document.body.style.top = `-${weightModalScrollY}px`;
  weightModalScrollLocked = true;
}

function unlockWeightModalScrollNow() {
  clearWeightModalUnlockWaiters();
  if (!weightModalScrollLocked) return;

  const restoreY = weightModalScrollY;
  document.body.classList.remove("modal-scroll-locked");
  document.body.style.top = "";
  window.scrollTo(0, restoreY);
  requestAnimationFrame(() => {
    window.scrollTo(0, restoreY);
  });

  weightModalScrollLocked = false;
}

function unlockWeightModalScrollAfterKeyboard() {
  clearWeightModalUnlockWaiters();
  if (!weightModalScrollLocked) return;

  if (window.visualViewport && isMobileWeightUI()) {
    const viewport = window.visualViewport;
    const deadlineTs = Date.now() + 420;

    function finalizeUnlock() {
      unlockWeightModalScrollNow();
    }

    function queueUnlock() {
      if (weightModalUnlockTimer !== null) {
        window.clearTimeout(weightModalUnlockTimer);
      }

      const msLeft = deadlineTs - Date.now();
      const delay = msLeft <= 0 ? 0 : Math.min(120, msLeft);
      weightModalUnlockTimer = window.setTimeout(finalizeUnlock, delay);
    }

    function onViewportChange() {
      queueUnlock();
    }

    viewport.addEventListener("resize", onViewportChange);
    viewport.addEventListener("scroll", onViewportChange);
    weightModalViewportCleanup = () => {
      viewport.removeEventListener("resize", onViewportChange);
      viewport.removeEventListener("scroll", onViewportChange);
    };

    queueUnlock();
    return;
  }

  unlockWeightModalScrollNow();
}

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

function showCalorieUpdateToast() {
  const toast = document.getElementById("calorie-update-toast");
  if (!toast) return;

  clearCalorieToastTimers();
  toast.textContent = "Maintenance calories adjusted to current weight";
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

function initWeightSwipeRow(row) {
  if (!row || row.dataset.swipeBound === "1") return;
  row.dataset.swipeBound = "1";

  const content = row.querySelector(".weight-row-content");
  const actions = row.querySelector(".weight-pill-actions");
  if (!content || !actions) return;

  const buttons = Array.prototype.slice.call(actions.querySelectorAll(".weight-pill-btn"));
  const deleteButton = row.querySelector(".weight-pill-btn.delete");
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
      SWIPE_CONFIG.MIN_OPEN_PX,
      Math.ceil(actionWidth + rightInset + SWIPE_CONFIG.OPEN_EXTRA_PX)
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
    if (x < -(window.innerWidth * SWIPE_CONFIG.FULL_FRAC)) {
      deleteButton.classList.add("expanding");
    } else {
      deleteButton.classList.remove("expanding");
    }
  }

  function toggleButtons(progress) {
    for (let i = 0; i < buttons.length; i += 1) {
      if (progress > (0.08 + i * 0.14)) {
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
    if (openSwipeRow === row) openSwipeRow = null;
  }

  function onStart(e) {
    if (!e.touches || e.touches.length !== 1) return;

    if (openSwipeRow && openSwipeRow !== row) {
      closeOpenSwipeRow();
    }

    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
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

  function onMove(e) {
    if (!dragging || !e.touches || e.touches.length !== 1) return;

    const x = e.touches[0].clientX;
    const y = e.touches[0].clientY;
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

    if (e.cancelable) e.preventDefault();

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
      raw = -openPx + (raw + openPx) * SWIPE_CONFIG.DAMP;
    }

    curX = raw;
    scheduleTranslate(raw);
  }

  function onEnd() {
    if (!dragging) return;
    dragging = false;

    flushTranslateFrame();

    if (deleteButton) deleteButton.classList.remove("expanding");

    if (curX < -(window.innerWidth * SWIPE_CONFIG.FULL_FRAC)) {
      closeRow();
      if (navigator.vibrate) navigator.vibrate(10);
      openDeleteSheet(row.getAttribute("data-weight-id"));
      return;
    }

    if ((Math.abs(curX) > SWIPE_CONFIG.SNAP_PX || velocityX < SWIPE_CONFIG.FLICK_VELOCITY) && buttons.length > 0) {
      snapTo(-(row._openPx || openPx));
      openSwipeRow = row;
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
    if (openSwipeRow === row) {
      closeRow();
    }
  });

  row._close = closeRow;
}

function initWeightSwipeRows(list) {
  if (!list) return;
  const rows = list.querySelectorAll(".weight-swipe-row");
  for (let i = 0; i < rows.length; i += 1) {
    initWeightSwipeRow(rows[i]);
  }
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

  lockWeightModalScroll();
  clearWeightModalTransitionWatcher();

  if (isEdit) {
    editingWeightId = entry.id;
    setWeightInputUnit(preferredUnit, false);
    const displayWeight = (preferredUnit === "lb") ? kgToLb(entry.weight) : entry.weight;
    input.value = formatWeightNumber(displayWeight || entry.weight);
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
  unlockWeightModalScrollAfterKeyboard();
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

  const beforeSummary = calculateMaintenanceFromState(loadState());

  if (editingWeightId) {
    if (!updateWeight(editingWeightId, value, unit)) return;
  } else {
    addWeight(value, unit);
  }

  const afterSummary = calculateMaintenanceFromState(loadState());
  if (beforeSummary && afterSummary && beforeSummary.maintenanceRounded !== afterSummary.maintenanceRounded) {
    showCalorieUpdateToast();
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
      renderWeightsTrendChart((latestState && latestState.chartSeries) || []);
      return;
    }

    const useMobileUi = isMobileWeightUI();
    if (lastWeightUiMode === null) {
      lastWeightUiMode = useMobileUi;
      renderWeightsTrendChart((latestState && latestState.chartSeries) || []);
      return;
    }

    if (useMobileUi !== lastWeightUiMode) {
      requestRender();
    } else {
      renderWeightsTrendChart((latestState && latestState.chartSeries) || []);
    }
  });
}

function bindChartControls() {
  bindWeightChartRangeEvents(() => {
    renderWeightsTrendChart((latestState && latestState.chartSeries) || []);
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
  unlockWeightModalScrollNow();
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
  renderWeightsTrendChart(latestState.chartSeries);

  const groups = buildWeightLogGroups(latestState.weights);
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
