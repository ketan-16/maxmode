window.MaxMode = (function () {
  "use strict";

  // ── Storage Keys ──────────────────────────────────────────────────
  const KEYS = { USER: "maxmode_user", WEIGHTS: "maxmode_weights" };
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

  var editingWeightId = null;
  var pendingDeleteWeightId = null;
  var openSwipeRow = null;
  var openDesktopMenuId = null;
  var lastWeightUiMode = null;
  var resizeFrame = null;
  var globalEventsBound = false;
  var weightModalScrollY = 0;
  var weightModalScrollLocked = false;
  var weightModalUnlockTimer = null;
  var weightModalViewportCleanup = null;
  var weightModalTransitionCleanup = null;
  var deleteSheetTransitionCleanup = null;

  // ── Storage Helpers ───────────────────────────────────────────────
  function getUser() {
    try { return JSON.parse(localStorage.getItem(KEYS.USER)); }
    catch { return null; }
  }

  function setUser(user) {
    localStorage.setItem(KEYS.USER, JSON.stringify(user));
  }

  function createEntryId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return Date.now().toString(36) + Math.random().toString(36).slice(2);
  }

  function getWeights() {
    try {
      var raw = JSON.parse(localStorage.getItem(KEYS.WEIGHTS));
      if (!Array.isArray(raw)) return [];

      var changed = false;
      var normalized = [];

      for (var i = 0; i < raw.length; i++) {
        var item = raw[i];
        if (!item || typeof item !== "object") {
          changed = true;
          continue;
        }

        var parsedWeight = (typeof item.weight === "number") ? item.weight : parseFloat(item.weight);
        if (!isFinite(parsedWeight) || parsedWeight <= 0) {
          changed = true;
          continue;
        }

        var normalizedItem = {
          id: (typeof item.id === "string" && item.id.length > 0) ? item.id : createEntryId(),
          weight: parsedWeight,
          unit: (typeof item.unit === "string" && item.unit.length > 0) ? item.unit : "kg",
          timestamp: (typeof item.timestamp === "string" && item.timestamp.length > 0) ? item.timestamp : new Date().toISOString()
        };

        if (
          normalizedItem.id !== item.id ||
          normalizedItem.weight !== item.weight ||
          normalizedItem.unit !== item.unit ||
          normalizedItem.timestamp !== item.timestamp
        ) {
          changed = true;
        }

        normalized.push(normalizedItem);
      }

      if (changed) saveWeights(normalized);
      return normalized;
    } catch {
      return [];
    }
  }

  function saveWeights(weights) {
    localStorage.setItem(KEYS.WEIGHTS, JSON.stringify(weights));
  }

  function addWeight(entry) {
    var weights = getWeights();
    weights.unshift(entry);
    saveWeights(weights);
  }

  function updateWeight(id, newWeight) {
    var weights = getWeights();
    var didUpdate = false;

    var next = weights.map(function (entry) {
      if (entry.id !== id) return entry;
      didUpdate = true;
      return {
        id: entry.id,
        weight: newWeight,
        unit: entry.unit,
        timestamp: entry.timestamp
      };
    });

    if (didUpdate) saveWeights(next);
    return didUpdate;
  }

  function deleteWeight(id) {
    var weights = getWeights();
    var next = weights.filter(function (entry) {
      return entry.id !== id;
    });

    if (next.length === weights.length) return false;
    saveWeights(next);
    return true;
  }

  function getWeightById(id) {
    var weights = getWeights();
    for (var i = 0; i < weights.length; i++) {
      if (weights[i].id === id) return weights[i];
    }
    return null;
  }

  function clearAllData() {
    localStorage.removeItem(KEYS.USER);
    localStorage.removeItem(KEYS.WEIGHTS);
  }

  // ── Avatar ────────────────────────────────────────────────────────
  function avatarUrl(name) {
    return "https://api.dicebear.com/9.x/notionists/svg?seed=" + encodeURIComponent(name);
  }

  // ── Formatting ────────────────────────────────────────────────────
  function formatDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function formatTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + "d ago";
    return formatDate(iso);
  }

  // ── Utility ───────────────────────────────────────────────────────
  function cssEscape(value) {
    if (window.CSS && typeof window.CSS.escape === "function") {
      return window.CSS.escape(value);
    }
    return String(value).replace(/([\\"'])/g, "\\$1");
  }

  function parseCssTimeMs(rawValue) {
    if (!rawValue) return 0;

    var value = String(rawValue).trim();
    if (!value) return 0;

    if (value.slice(-2) === "ms") {
      var millis = parseFloat(value.slice(0, -2));
      return isFinite(millis) ? millis : 0;
    }

    if (value.slice(-1) === "s") {
      var seconds = parseFloat(value.slice(0, -1));
      return isFinite(seconds) ? seconds * 1000 : 0;
    }

    return 0;
  }

  function getMaxTransitionMs(element) {
    if (!element) return 0;

    var style = window.getComputedStyle(element);
    var durations = String(style.transitionDuration || "").split(",");
    var delays = String(style.transitionDelay || "").split(",");
    var total = Math.max(durations.length, delays.length);
    var maxMs = 0;

    for (var i = 0; i < total; i++) {
      var duration = parseCssTimeMs(durations[i % durations.length]);
      var delay = parseCssTimeMs(delays[i % delays.length]);
      if ((duration + delay) > maxMs) {
        maxMs = duration + delay;
      }
    }

    return maxMs;
  }

  function onTransitionEndOrTimeout(element, fallbackMs, callback) {
    if (!element || typeof callback !== "function") {
      return function () {};
    }

    var done = false;
    var timer = null;

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
      var cleanup = weightModalTransitionCleanup;
      weightModalTransitionCleanup = null;
      cleanup();
    }
  }

  function clearDeleteSheetTransitionWatcher() {
    if (typeof deleteSheetTransitionCleanup === "function") {
      var cleanup = deleteSheetTransitionCleanup;
      deleteSheetTransitionCleanup = null;
      cleanup();
    }
  }

  function isMobileWeightUI() {
    var ua = navigator.userAgent || "";
    var touchPoints = navigator.maxTouchPoints || 0;
    var isIpad = /iPad/i.test(ua) || (/Macintosh/i.test(ua) && touchPoints > 1);
    if (isIpad) return true;

    var isTouchDevice = touchPoints > 0 || ("ontouchstart" in window);
    if (!isTouchDevice) return false;

    return window.matchMedia("(max-width: 1024px)").matches || /Android|iPhone|iPod|Mobile|Tablet/i.test(ua);
  }

  function clearWeightModalUnlockWaiters() {
    if (weightModalUnlockTimer !== null) {
      window.clearTimeout(weightModalUnlockTimer);
      weightModalUnlockTimer = null;
    }

    if (typeof weightModalViewportCleanup === "function") {
      var cleanup = weightModalViewportCleanup;
      weightModalViewportCleanup = null;
      cleanup();
    }
  }

  function lockWeightModalScroll() {
    clearWeightModalUnlockWaiters();
    if (weightModalScrollLocked) return;

    weightModalScrollY = window.scrollY || window.pageYOffset || 0;
    document.body.classList.add("modal-scroll-locked");
    document.body.style.top = "-" + weightModalScrollY + "px";
    weightModalScrollLocked = true;
  }

  function unlockWeightModalScrollNow() {
    clearWeightModalUnlockWaiters();
    if (!weightModalScrollLocked) return;

    var restoreY = weightModalScrollY;
    document.body.classList.remove("modal-scroll-locked");
    document.body.style.top = "";
    window.scrollTo(0, restoreY);
    requestAnimationFrame(function () {
      window.scrollTo(0, restoreY);
    });

    weightModalScrollLocked = false;
  }

  function unlockWeightModalScrollAfterKeyboard() {
    clearWeightModalUnlockWaiters();
    if (!weightModalScrollLocked) return;

    if (window.visualViewport && isMobileWeightUI()) {
      var viewport = window.visualViewport;
      var deadlineTs = Date.now() + 420;

      function finalizeUnlock() {
        unlockWeightModalScrollNow();
      }

      function queueUnlock() {
        if (weightModalUnlockTimer !== null) {
          window.clearTimeout(weightModalUnlockTimer);
        }

        var msLeft = deadlineTs - Date.now();
        var delay = msLeft <= 0 ? 0 : Math.min(120, msLeft);
        weightModalUnlockTimer = window.setTimeout(finalizeUnlock, delay);
      }

      function onViewportChange() {
        queueUnlock();
      }

      viewport.addEventListener("resize", onViewportChange);
      viewport.addEventListener("scroll", onViewportChange);
      weightModalViewportCleanup = function () {
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

    window.setTimeout(function () {
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

  function refreshWeightDerivedViews() {
    populateDashboard();
    populateProfile();
  }

  function closeOpenSwipeRow() {
    if (openSwipeRow && typeof openSwipeRow._close === "function") {
      openSwipeRow._close();
    }
    openSwipeRow = null;
  }

  function closeDesktopMenu() {
    if (!openDesktopMenuId) return;

    var escapedId = cssEscape(openDesktopMenuId);
    var menu = document.querySelector('[data-weight-menu="' + escapedId + '"]');
    var trigger = document.querySelector('[data-weight-menu-toggle="' + escapedId + '"]');

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

    var escapedId = cssEscape(id);
    var menu = document.querySelector('[data-weight-menu="' + escapedId + '"]');
    var trigger = document.querySelector('[data-weight-menu-toggle="' + escapedId + '"]');

    if (!menu || !trigger) return;

    menu.classList.add("open");
    trigger.setAttribute("aria-expanded", "true");
    openDesktopMenuId = id;
  }

  function setWeightModalMode(isEdit) {
    var title = document.getElementById("weight-modal-title");
    var submitLabel = document.getElementById("weight-submit-label");
    if (title) title.textContent = isEdit ? "Edit Weight" : "Log Weight";
    if (submitLabel) submitLabel.textContent = isEdit ? "Save Changes" : "Save";
  }

  // ── Onboarding ────────────────────────────────────────────────────
  function checkOnboarding() {
    var overlay = document.getElementById("onboarding-overlay");
    if (!overlay) return;

    var user = getUser();
    if (!user) {
      overlay.classList.remove("hidden");
    } else {
      overlay.classList.add("hidden");
      updateNavAvatar(user.name);
    }
  }

  function handleOnboardingSubmit(e) {
    e.preventDefault();
    var input = document.getElementById("onboarding-name");
    var name = input.value.trim();
    if (!name) return;

    setUser({ name: name, createdAt: new Date().toISOString() });
    checkOnboarding();
    onPageLoad();
  }

  // ── Nav Avatar ────────────────────────────────────────────────────
  function updateNavAvatar(name) {
    var img = document.getElementById("nav-avatar");
    if (img) img.src = avatarUrl(name);
  }

  // ── Dashboard ─────────────────────────────────────────────────────
  function populateDashboard() {
    var valueEl = document.getElementById("latest-weight-value");
    if (!valueEl) return;

    var timeEl = document.getElementById("latest-weight-time");
    var weights = getWeights();

    if (weights.length === 0) {
      valueEl.textContent = "--";
      timeEl.textContent = "No entries yet";
    } else {
      var latest = weights[0];
      valueEl.textContent = latest.weight + " " + latest.unit;
      timeEl.textContent = relativeTime(latest.timestamp) + " · " + formatDate(latest.timestamp);
    }
  }

  // ── Weights ───────────────────────────────────────────────────────
  function desktopWeightRowHtml(weight) {
    var id = escapeHtml(weight.id);
    return '<tr class="apple-table-row">'
      + '<td class="apple-table-cell">' + escapeHtml(formatDate(weight.timestamp)) + "</td>"
      + '<td class="apple-table-cell apple-table-cell-muted">' + escapeHtml(formatTime(weight.timestamp)) + "</td>"
      + '<td class="apple-table-cell apple-table-cell-strong apple-table-cell-right">' + escapeHtml(weight.weight + " " + weight.unit) + "</td>"
      + '<td class="apple-table-cell apple-table-cell-right weight-actions-cell">'
      + '<button type="button" class="weight-kebab-trigger" aria-label="Open actions menu" aria-haspopup="menu" aria-expanded="false" data-weight-menu-toggle="' + id + '">'
      + ICONS.KEBAB
      + "</button>"
      + '<div class="weight-kebab-menu" role="menu" data-weight-menu="' + id + '">'
      + '<button type="button" class="weight-kebab-item" role="menuitem" data-weight-action="edit" data-weight-id="' + id + '">Edit</button>'
      + '<button type="button" class="weight-kebab-item danger" role="menuitem" data-weight-action="delete" data-weight-id="' + id + '">Delete</button>'
      + "</div>"
      + "</td>"
      + "</tr>";
  }

  function mobileWeightRowHtml(weight) {
    var id = escapeHtml(weight.id);
    return '<article class="weight-swipe-row" data-weight-id="' + id + '">'
      + '<div class="weight-pill-actions">'
      + '<button type="button" class="weight-pill-btn edit" aria-label="Edit weight" data-weight-action="edit" data-weight-id="' + id + '">' + ICONS.EDIT + "</button>"
      + '<button type="button" class="weight-pill-btn delete" aria-label="Delete weight" data-weight-action="delete" data-weight-id="' + id + '">' + ICONS.DELETE + "</button>"
      + "</div>"
      + '<div class="weight-row-content">'
      + '<div class="weight-row-main">'
      + '<p class="weight-row-weight">' + escapeHtml(weight.weight + " " + weight.unit) + "</p>"
      + '<p class="weight-row-meta">' + escapeHtml(formatDate(weight.timestamp) + " · " + formatTime(weight.timestamp)) + "</p>"
      + "</div>"
      + '<div class="weight-row-relative">' + escapeHtml(relativeTime(weight.timestamp)) + "</div>"
      + "</div>"
      + "</article>";
  }

  function renderDesktopWeights(weights, tbody) {
    var rows = new Array(weights.length);
    for (var i = 0; i < weights.length; i++) {
      rows[i] = desktopWeightRowHtml(weights[i]);
    }
    tbody.innerHTML = rows.join("");
  }

  function renderMobileWeights(weights, list) {
    var rows = new Array(weights.length);
    for (var i = 0; i < weights.length; i++) {
      rows[i] = mobileWeightRowHtml(weights[i]);
    }
    list.innerHTML = rows.join("");
  }

  function initWeightSwipeRow(row) {
    if (!row || row.dataset.swipeBound === "1") return;
    row.dataset.swipeBound = "1";

    var content = row.querySelector(".weight-row-content");
    var actions = row.querySelector(".weight-pill-actions");
    if (!content || !actions) return;

    var buttons = Array.prototype.slice.call(actions.querySelectorAll(".weight-pill-btn"));
    var deleteButton = row.querySelector(".weight-pill-btn.delete");
    var openPx = measureOpenPx();
    row._openPx = openPx;

    var startX = 0;
    var startY = 0;
    var baseX = 0;
    var curX = 0;
    var lastMoveX = 0;
    var lastMoveTime = 0;
    var velocityX = 0;
    var dragging = false;
    var locked = false;
    var queuedX = 0;
    var translateFrame = null;
    var willChangeTimer = null;
    var actionsHideTimer = null;

    function measureOpenPx() {
      if (!buttons.length) return 0;

      var actionsStyle = window.getComputedStyle(actions);
      var gap = parseFloat(actionsStyle.columnGap || actionsStyle.gap || "0");
      var rightInset = parseFloat(actionsStyle.right || "0");
      if (!isFinite(gap)) gap = 0;
      if (!isFinite(rightInset)) rightInset = 0;

      var actionWidth = 0;
      for (var i = 0; i < buttons.length; i++) {
        var layoutWidth = buttons[i].offsetWidth;
        if (!layoutWidth) {
          var btnStyle = window.getComputedStyle(buttons[i]);
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

      var delay = Math.max(90, Math.round(getMaxTransitionMs(content)));
      willChangeTimer = window.setTimeout(function () {
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
      for (var i = 0; i < buttons.length; i++) {
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
      content.style.transform = "translate3d(" + x + "px, 0, 0)";

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

      translateFrame = requestAnimationFrame(function () {
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
        var delay = Math.max(90, Math.round(getMaxTransitionMs(content)));
        actionsHideTimer = window.setTimeout(function () {
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

      var x = e.touches[0].clientX;
      var y = e.touches[0].clientY;
      var dx = x - startX;
      var dy = y - startY;

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

      var raw = baseX + dx;
      var now = Date.now();
      var dt = now - lastMoveTime;
      if (dt > 0) {
        velocityX = (x - lastMoveX) / dt;
      }
      lastMoveX = x;
      lastMoveTime = now;

      if (raw > 0) {
        raw = raw * 0.2;
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
    content.addEventListener("click", function () {
      if (openSwipeRow === row) {
        closeRow();
      }
    });

    row._close = closeRow;
  }

  function initWeightSwipeRows(list) {
    if (!list) return;
    var rows = list.querySelectorAll(".weight-swipe-row");
    for (var i = 0; i < rows.length; i++) {
      initWeightSwipeRow(rows[i]);
    }
  }

  function populateWeights() {
    var tbody = document.getElementById("weight-table-body");
    var mobileList = document.getElementById("weight-mobile-list");
    if (!tbody || !mobileList) {
      lastWeightUiMode = null;
      return;
    }

    var weights = getWeights();
    var emptyState = document.getElementById("weight-empty-state");
    var tableContainer = document.getElementById("weight-table-container");
    var mobileContainer = document.getElementById("weight-mobile-list-container");

    closeDesktopMenu();
    closeOpenSwipeRow();

    if (weights.length === 0) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (tableContainer) tableContainer.classList.add("hidden");
      if (mobileContainer) mobileContainer.classList.add("hidden");
      tbody.innerHTML = "";
      mobileList.innerHTML = "";
      closeDeleteSheet();
      return;
    }

    if (emptyState) emptyState.classList.add("hidden");

    var useMobileUi = isMobileWeightUI();
    lastWeightUiMode = useMobileUi;

    if (useMobileUi) {
      if (mobileContainer) mobileContainer.classList.remove("hidden");
      if (tableContainer) tableContainer.classList.add("hidden");
      renderMobileWeights(weights, mobileList);
      initWeightSwipeRows(mobileList);
    } else {
      if (tableContainer) tableContainer.classList.remove("hidden");
      if (mobileContainer) mobileContainer.classList.add("hidden");
      renderDesktopWeights(weights, tbody);
    }
  }

  function openWeightModal(weightId) {
    var modal = document.getElementById("weight-modal");
    var input = document.getElementById("weight-input");
    if (!modal || !input) return;

    var isEdit = (typeof weightId === "string" && weightId.length > 0);
    var entry = null;

    if (isEdit) {
      entry = getWeightById(weightId);
      if (!entry) return;
    }

    lockWeightModalScroll();
    clearWeightModalTransitionWatcher();

    if (isEdit) {
      editingWeightId = entry.id;
      input.value = entry.weight;
      setWeightModalMode(true);
      modal.classList.remove("hidden");
      modal.classList.remove("is-closing");
      modal.setAttribute("aria-hidden", "false");
      requestAnimationFrame(function () {
        modal.classList.add("is-open");
      });
      focusWeightInput(input, true);
      return;
    }

    editingWeightId = null;
    setWeightModalMode(false);
    modal.classList.remove("hidden");
    modal.classList.remove("is-closing");
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(function () {
      modal.classList.add("is-open");
    });
    input.value = "";
    focusWeightInput(input, false);
  }

  function closeWeightModal() {
    var modal = document.getElementById("weight-modal");
    var input = document.getElementById("weight-input");
    var active = document.activeElement;

    var modalIsOpen = !!(modal && !modal.classList.contains("hidden"));
    var activeIsFormControl = !!(active && typeof active.matches === "function" && active.matches("input, textarea, select, [contenteditable='true']"));
    var shouldBlur = !!(modalIsOpen && active && typeof active.blur === "function" && (active === input || (modal && modal.contains(active)) || activeIsFormControl));

    if (shouldBlur) {
      active.blur();
    }

    clearWeightModalTransitionWatcher();
    if (modal && !modal.classList.contains("hidden")) {
      modal.classList.remove("is-open");
      modal.classList.add("is-closing");
      modal.setAttribute("aria-hidden", "true");

      var modalPanel = modal.querySelector(".apple-modal-weight") || modal;
      var closeMs = Math.max(getMaxTransitionMs(modal), getMaxTransitionMs(modalPanel)) + 48;

      weightModalTransitionCleanup = onTransitionEndOrTimeout(modalPanel, closeMs, function () {
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

    var sheet = document.getElementById("weight-delete-sheet");
    if (!sheet) {
      if (confirm("Delete this entry?")) {
        if (deleteWeight(weightId)) {
          populateWeights();
          refreshWeightDerivedViews();
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

    requestAnimationFrame(function () {
      sheet.classList.add("is-open");
    });
  }

  function closeDeleteSheet(shouldClearPending) {
    if (typeof shouldClearPending === "undefined") shouldClearPending = true;

    var sheet = document.getElementById("weight-delete-sheet");

    if (shouldClearPending) {
      pendingDeleteWeightId = null;
    }

    clearDeleteSheetTransitionWatcher();
    if (!sheet) return;
    if (sheet.classList.contains("hidden")) {
      sheet.classList.remove("is-closing");
      sheet.setAttribute("aria-hidden", "true");
      return;
    }

    sheet.classList.remove("is-open");
    sheet.classList.add("is-closing");
    sheet.setAttribute("aria-hidden", "true");

    var panel = sheet.querySelector(".weight-delete-sheet-panel") || sheet;
    var backdrop = sheet.querySelector(".weight-delete-sheet-backdrop");
    var closeMs = Math.max(getMaxTransitionMs(panel), getMaxTransitionMs(backdrop), getMaxTransitionMs(sheet)) + 48;

    deleteSheetTransitionCleanup = onTransitionEndOrTimeout(panel, closeMs, function () {
      deleteSheetTransitionCleanup = null;
      if (sheet.classList.contains("is-open")) return;
      sheet.classList.remove("is-closing");
      sheet.classList.add("hidden");
    });
  }

  function confirmDeleteWeight() {
    var deletingId = pendingDeleteWeightId;
    if (!deletingId) return;

    closeDeleteSheet(false);
    pendingDeleteWeightId = null;

    if (!deleteWeight(deletingId)) return;

    populateWeights();
    refreshWeightDerivedViews();
  }

  function handleWeightAction(action, weightId) {
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

  function handleWeightSubmit(e) {
    e.preventDefault();
    var input = document.getElementById("weight-input");
    if (!input) return;

    var value = parseFloat(input.value);
    if (!isFinite(value) || value <= 0) return;

    if (editingWeightId) {
      if (!updateWeight(editingWeightId, value)) return;
    } else {
      addWeight({
        id: createEntryId(),
        weight: value,
        unit: "kg",
        timestamp: new Date().toISOString()
      });
    }

    closeWeightModal();
    populateWeights();
    refreshWeightDerivedViews();
  }

  // ── Profile ───────────────────────────────────────────────────────
  function populateProfile() {
    var nameEl = document.getElementById("profile-name");
    if (!nameEl) return;

    var user = getUser();
    if (!user) return;

    nameEl.textContent = user.name;

    var avatarEl = document.getElementById("profile-avatar");
    if (avatarEl) avatarEl.src = avatarUrl(user.name);

    var sinceEl = document.getElementById("profile-since");
    if (sinceEl) sinceEl.textContent = "Member since " + formatDate(user.createdAt);

    var totalEl = document.getElementById("profile-total-entries");
    if (totalEl) totalEl.textContent = getWeights().length;
  }

  function resetData() {
    if (!confirm("This will permanently delete all your data. Are you sure?")) return;
    clearAllData();
    window.location.href = "/";
  }

  // ── Escape HTML ───────────────────────────────────────────────────
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  function onViewportChange() {
    if (resizeFrame !== null) return;

    resizeFrame = requestAnimationFrame(function () {
      resizeFrame = null;

      var tbody = document.getElementById("weight-table-body");
      var mobileList = document.getElementById("weight-mobile-list");
      if (!tbody || !mobileList) return;

      var useMobileUi = isMobileWeightUI();
      if (lastWeightUiMode === null) {
        lastWeightUiMode = useMobileUi;
        return;
      }

      if (useMobileUi !== lastWeightUiMode) {
        populateWeights();
      }
    });
  }

  function bindGlobalEvents() {
    if (globalEventsBound) return;
    globalEventsBound = true;

    document.addEventListener("click", function (e) {
      var target = e.target;

      var actionBtn = target.closest("[data-weight-action]");
      if (actionBtn) {
        handleWeightAction(
          actionBtn.getAttribute("data-weight-action"),
          actionBtn.getAttribute("data-weight-id")
        );
        return;
      }

      var menuToggle = target.closest("[data-weight-menu-toggle]");
      if (menuToggle) {
        toggleDesktopMenu(menuToggle.getAttribute("data-weight-menu-toggle"));
        return;
      }

      if (target.closest("[data-weight-delete-confirm]")) {
        confirmDeleteWeight();
        return;
      }

      if (target.closest("[data-weight-delete-dismiss]")) {
        closeDeleteSheet();
        return;
      }

      var modal = document.getElementById("weight-modal");
      if (target === modal) {
        closeWeightModal();
        return;
      }

      if (openDesktopMenuId && !target.closest("[data-weight-menu]")) {
        closeDesktopMenu();
      }
    });

    document.addEventListener("touchstart", function (e) {
      if (openSwipeRow && !openSwipeRow.contains(e.target)) {
        closeOpenSwipeRow();
      }
    }, { passive: true });

    document.addEventListener("keydown", function (e) {
      if (e.key !== "Escape") return;
      closeDeleteSheet();
      closeDesktopMenu();
      closeOpenSwipeRow();
      closeWeightModal();
    });

    window.addEventListener("resize", onViewportChange, { passive: true });
    window.addEventListener("orientationchange", onViewportChange, { passive: true });
  }

  // ── Master Page Load ──────────────────────────────────────────────
  function onPageLoad() {
    clearWeightModalTransitionWatcher();
    clearDeleteSheetTransitionWatcher();
    editingWeightId = null;
    pendingDeleteWeightId = null;
    closeDesktopMenu();
    closeOpenSwipeRow();
    unlockWeightModalScrollNow();
    bindGlobalEvents();
    checkOnboarding();
    populateDashboard();
    populateWeights();
    populateProfile();
  }

  // ── Event Listeners ───────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", onPageLoad);
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.detail && e.detail.target && e.detail.target.id === "main-content") {
      onPageLoad();
    }
  });

  // ── Public API ────────────────────────────────────────────────────
  return {
    handleOnboardingSubmit: handleOnboardingSubmit,
    handleWeightSubmit: handleWeightSubmit,
    openWeightModal: openWeightModal,
    closeWeightModal: closeWeightModal,
    closeDeleteSheet: closeDeleteSheet,
    confirmDeleteWeight: confirmDeleteWeight,
    resetData: resetData,
    onPageLoad: onPageLoad
  };
})();
