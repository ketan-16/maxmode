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
  const WEIGHT_CHART_RANGES = {
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000,
    all: null
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
  var chartRefreshFrame = null;
  var chartThemeEventsBound = false;
  var weightChartRange = "30d";
  var dashboardInsightsExpanded = false;

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

  function relativeTimeStrict(iso) {
    var timestamp = new Date(iso).getTime();
    if (!isFinite(timestamp)) return "No entries yet";

    var diff = Date.now() - timestamp;
    if (!isFinite(diff) || diff < 0) diff = 0;

    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + "m ago";

    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";

    var days = Math.floor(hrs / 24);
    if (days <= 2) return "yesterday";
    if (days < 30) return days + "d ago";

    var months = Math.floor(days / 30);
    if (months < 12) return months + "mo ago";

    var years = Math.max(1, Math.floor(days / 365));
    return years + "y ago";
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

  function getChartReadyWeights(weights) {
    var source = Array.isArray(weights) ? weights : getWeights();
    var points = [];

    for (var i = 0; i < source.length; i++) {
      var entry = source[i];
      if (!entry || typeof entry !== "object") continue;

      var parsedWeight = (typeof entry.weight === "number") ? entry.weight : parseFloat(entry.weight);
      var parsedTimestamp = new Date(entry.timestamp).getTime();

      if (!isFinite(parsedWeight) || parsedWeight <= 0) continue;
      if (!isFinite(parsedTimestamp)) continue;

      points.push({
        id: entry.id,
        weight: parsedWeight,
        unit: entry.unit || "kg",
        iso: entry.timestamp,
        timestamp: parsedTimestamp
      });
    }

    points.sort(function (a, b) {
      return a.timestamp - b.timestamp;
    });

    return points;
  }

  function filterWeightSeriesForRange(points, rangeKey) {
    if (!Array.isArray(points) || points.length === 0) return [];
    if (!Object.prototype.hasOwnProperty.call(WEIGHT_CHART_RANGES, rangeKey) || rangeKey === "all") {
      return points.slice();
    }

    var windowMs = WEIGHT_CHART_RANGES[rangeKey];
    if (!windowMs) return points.slice();

    var latestTimestamp = points[points.length - 1].timestamp;
    var cutoff = latestTimestamp - windowMs;
    var filtered = [];

    for (var i = 0; i < points.length; i++) {
      if (points[i].timestamp >= cutoff) filtered.push(points[i]);
    }

    if (filtered.length === 1) {
      for (var j = points.length - 1; j >= 0; j--) {
        if (points[j].timestamp < cutoff) {
          filtered.unshift(points[j]);
          break;
        }
      }
    }

    return filtered;
  }

  function weightChartRangeLabel(rangeKey) {
    if (rangeKey === "7d") return "last 7 days";
    if (rangeKey === "30d") return "last 30 days";
    if (rangeKey === "90d") return "last 90 days";
    return "all time";
  }

  function formatWeightNumber(value) {
    var rounded = Math.round(value * 10) / 10;
    if (Math.abs(rounded - Math.round(rounded)) < 0.01) {
      return String(Math.round(rounded));
    }
    return rounded.toFixed(1);
  }

  function formatSignedWeightDelta(value, unit) {
    if (typeof value !== "number" || !isFinite(value)) return "--";

    var normalizedUnit = unit || "kg";
    var magnitude = Math.abs(value);
    if (magnitude < 0.05) return "0 " + normalizedUnit;

    var sign = value > 0 ? "+" : "-";
    return sign + formatWeightNumber(magnitude) + " " + normalizedUnit;
  }

  function buildDashboardTrendNote(change30d, unit) {
    if (typeof change30d !== "number" || !isFinite(change30d)) {
      return "Add one more entry to unlock 30D trend insights.";
    }

    var normalizedUnit = unit || "kg";
    if (Math.abs(change30d) < 0.05) {
      return "Stable over the last 30 days.";
    }

    var direction = change30d > 0 ? "Up" : "Down";
    return direction + " " + formatWeightNumber(Math.abs(change30d)) + " " + normalizedUnit + " over 30 days.";
  }

  function getDashboardChartRenderKey(series, chartWidth) {
    if (!Array.isArray(series) || series.length === 0) {
      return "empty";
    }

    var parts = [String(chartWidth), String(series.length)];
    for (var i = 0; i < series.length; i++) {
      parts.push(String(series[i].timestamp));
      parts.push(String(series[i].weight));
    }
    return parts.join("|");
  }

  function formatChartDate(timestamp, includeYear) {
    var date = new Date(timestamp);
    var options = { month: "short", day: "numeric" };
    if (includeYear) options.year = "2-digit";
    return date.toLocaleDateString(undefined, options);
  }

  function buildSmoothLinePath(points) {
    if (!points || points.length === 0) return "";

    if (points.length === 1) {
      var only = points[0];
      var x1 = (only.x - 0.01).toFixed(2);
      var x2 = (only.x + 0.01).toFixed(2);
      var y = only.y.toFixed(2);
      return "M " + x1 + " " + y + " L " + x2 + " " + y;
    }

    var first = points[0];
    var path = "M " + first.x.toFixed(2) + " " + first.y.toFixed(2);

    for (var i = 0; i < points.length - 1; i++) {
      var p0 = points[Math.max(0, i - 1)];
      var p1 = points[i];
      var p2 = points[i + 1];
      var p3 = points[Math.min(points.length - 1, i + 2)];

      var cp1x = p1.x + ((p2.x - p0.x) / 6);
      var cp1y = p1.y + ((p2.y - p0.y) / 6);
      var cp2x = p2.x - ((p3.x - p1.x) / 6);
      var cp2y = p2.y - ((p3.y - p1.y) / 6);

      path += " C "
        + cp1x.toFixed(2) + " " + cp1y.toFixed(2) + ", "
        + cp2x.toFixed(2) + " " + cp2y.toFixed(2) + ", "
        + p2.x.toFixed(2) + " " + p2.y.toFixed(2);
    }

    return path;
  }

  function buildWeightChartModel(points, options) {
    var interactive = !!(options && options.interactive);
    var widthInput = options && options.width ? Math.floor(options.width) : 0;
    var width = Math.max(300, widthInput || 640);
    var height = interactive ? 248 : 220;

    var padding = interactive
      ? { top: 54, right: 18, bottom: 30, left: 48 }
      : { top: 24, right: 18, bottom: 30, left: 48 };

    var plotLeft = padding.left;
    var plotTop = padding.top;
    var plotWidth = Math.max(120, width - padding.left - padding.right);
    var plotHeight = Math.max(90, height - padding.top - padding.bottom);
    var plotRight = plotLeft + plotWidth;
    var plotBottom = plotTop + plotHeight;

    var minWeight = points[0].weight;
    var maxWeight = points[0].weight;
    var minTimestamp = points[0].timestamp;
    var maxTimestamp = points[points.length - 1].timestamp;

    for (var i = 1; i < points.length; i++) {
      var weight = points[i].weight;
      if (weight < minWeight) minWeight = weight;
      if (weight > maxWeight) maxWeight = weight;
    }

    var spread = maxWeight - minWeight;
    var pad = spread === 0 ? Math.max(0.8, maxWeight * 0.02) : Math.max(0.5, spread * 0.18);
    var domainMin = Math.max(0, minWeight - pad);
    var domainMax = maxWeight + pad;

    if ((domainMax - domainMin) < 0.1) {
      domainMax = domainMin + 0.1;
    }

    var domainSpan = domainMax - domainMin;
    var timeSpan = maxTimestamp - minTimestamp;
    var singleTimestamp = timeSpan <= 0;

    function xForTimestamp(timestamp) {
      if (singleTimestamp) return plotLeft + (plotWidth / 2);
      return plotLeft + (((timestamp - minTimestamp) / timeSpan) * plotWidth);
    }

    function yForWeight(weight) {
      return plotTop + ((1 - ((weight - domainMin) / domainSpan)) * plotHeight);
    }

    var projected = new Array(points.length);
    for (var p = 0; p < points.length; p++) {
      var point = points[p];
      projected[p] = {
        id: point.id,
        weight: point.weight,
        unit: point.unit,
        iso: point.iso,
        timestamp: point.timestamp,
        x: xForTimestamp(point.timestamp),
        y: yForWeight(point.weight)
      };
    }

    var linePath = buildSmoothLinePath(projected);
    var areaPath = "";
    if (projected.length > 1 && linePath) {
      areaPath = linePath
        + " L " + projected[projected.length - 1].x.toFixed(2) + " " + plotBottom.toFixed(2)
        + " L " + projected[0].x.toFixed(2) + " " + plotBottom.toFixed(2)
        + " Z";
    }

    var yTicks = [];
    for (var yIndex = 0; yIndex <= 4; yIndex++) {
      var yRatio = yIndex / 4;
      yTicks.push({
        y: plotTop + (yRatio * plotHeight),
        value: domainMax - (yRatio * domainSpan)
      });
    }

    var xTicks = [];
    var includeYear = new Date(minTimestamp).getFullYear() !== new Date(maxTimestamp).getFullYear();
    var tickIndices = [0, Math.floor((projected.length - 1) / 2), projected.length - 1];
    var seen = {};

    for (var t = 0; t < tickIndices.length; t++) {
      var idx = tickIndices[t];
      if (seen[idx]) continue;
      seen[idx] = true;

      xTicks.push({
        x: projected[idx].x,
        label: formatChartDate(projected[idx].timestamp, includeYear)
      });
    }

    var safeId = (options && options.chartId ? String(options.chartId) : "chart").replace(/[^a-zA-Z0-9_-]/g, "");
    var gradientId = "weight-chart-gradient-" + safeId;

    return {
      width: width,
      height: height,
      plotLeft: plotLeft,
      plotRight: plotRight,
      plotTop: plotTop,
      plotBottom: plotBottom,
      plotWidth: plotWidth,
      plotHeight: plotHeight,
      linePath: linePath,
      areaPath: areaPath,
      points: projected,
      yTicks: yTicks,
      xTicks: xTicks,
      gradientId: gradientId,
      interactive: interactive
    };
  }

  function buildWeightChartSvg(model) {
    var parts = [];
    parts.push('<svg class="weight-chart-svg weight-chart-animated" viewBox="0 0 ' + model.width + " " + model.height + '" role="img" aria-label="Weight trend chart">');
    parts.push("<defs>");
    parts.push('<linearGradient id="' + model.gradientId + '" x1="0" y1="0" x2="0" y2="1">');
    parts.push('<stop offset="0%" class="weight-chart-area-stop-start"></stop>');
    parts.push('<stop offset="100%" class="weight-chart-area-stop-end"></stop>');
    parts.push("</linearGradient>");
    parts.push("</defs>");

    parts.push('<g class="weight-chart-grid">');
    for (var i = 0; i < model.yTicks.length; i++) {
      var yTick = model.yTicks[i];
      parts.push('<line class="weight-chart-grid-line" x1="' + model.plotLeft.toFixed(2) + '" y1="' + yTick.y.toFixed(2) + '" x2="' + model.plotRight.toFixed(2) + '" y2="' + yTick.y.toFixed(2) + '"></line>');
      parts.push('<text class="weight-chart-axis-label" x="' + (model.plotLeft - 10).toFixed(2) + '" y="' + (yTick.y + 4).toFixed(2) + '" text-anchor="end">' + escapeHtml(formatWeightNumber(yTick.value)) + "</text>");
    }

    for (var xIndex = 0; xIndex < model.xTicks.length; xIndex++) {
      var xTick = model.xTicks[xIndex];
      parts.push('<text class="weight-chart-axis-label" x="' + xTick.x.toFixed(2) + '" y="' + (model.plotBottom + 18).toFixed(2) + '" text-anchor="middle">' + escapeHtml(xTick.label) + "</text>");
    }
    parts.push("</g>");

    if (model.areaPath) {
      parts.push('<path class="weight-chart-path-area" d="' + model.areaPath + '" fill="url(#' + model.gradientId + ')"></path>');
    }

    parts.push('<path class="weight-chart-path-line" pathLength="1" d="' + model.linePath + '"></path>');

    parts.push('<g class="weight-chart-points">');
    for (var pointIndex = 0; pointIndex < model.points.length; pointIndex++) {
      var point = model.points[pointIndex];
      parts.push('<circle class="weight-chart-point" cx="' + point.x.toFixed(2) + '" cy="' + point.y.toFixed(2) + '" r="' + (model.interactive ? "2.9" : "2.5") + '"></circle>');
    }
    parts.push("</g>");

    if (model.interactive) {
      parts.push('<line class="weight-chart-hover-line hidden" x1="0" y1="' + model.plotTop.toFixed(2) + '" x2="0" y2="' + model.plotBottom.toFixed(2) + '"></line>');
      parts.push('<circle class="weight-chart-hover-dot hidden" cx="0" cy="0" r="5"></circle>');
      parts.push('<rect class="weight-chart-hit-area" x="' + model.plotLeft.toFixed(2) + '" y="' + model.plotTop.toFixed(2) + '" width="' + model.plotWidth.toFixed(2) + '" height="' + model.plotHeight.toFixed(2) + '" rx="10" ry="10"></rect>');
    }

    parts.push("</svg>");
    return parts.join("");
  }

  function renderWeightChartEmpty(container, message) {
    if (!container) return;
    container.innerHTML = '<div class="weight-chart-empty">' + escapeHtml(message) + "</div>";
  }

  function renderDashboardWeightChartFromSeries(series) {
    var container = document.getElementById("dashboard-weight-chart");
    if (!container) return;

    if (series.length === 0) {
      if (container.dataset.chartKey === "empty") return;
      renderWeightChartEmpty(container, "Log weights to view your trend.");
      container.dataset.chartKey = "empty";
      return;
    }

    var width = Math.floor(container.clientWidth || container.getBoundingClientRect().width || 0);
    var chartWidth = Math.max(300, width || 640);
    var nextKey = getDashboardChartRenderKey(series, chartWidth);

    if (container.dataset.chartKey === nextKey) return;

    var model = buildWeightChartModel(series, {
      width: chartWidth,
      interactive: false,
      chartId: "dashboard"
    });

    container.innerHTML = buildWeightChartSvg(model);
    container.dataset.chartKey = nextKey;
  }

  function renderDashboardWeightChart(weights) {
    renderDashboardWeightChartFromSeries(getChartReadyWeights(weights));
  }

  function setDashboardInsightsExpanded(expanded) {
    dashboardInsightsExpanded = !!expanded;

    var toggle = document.getElementById("dashboard-insights-toggle");
    var panel = document.getElementById("dashboard-insights-panel");

    if (toggle) {
      toggle.setAttribute("aria-expanded", dashboardInsightsExpanded ? "true" : "false");
    }

    if (panel) {
      panel.hidden = !dashboardInsightsExpanded;
    }
  }

  function bindDashboardInsightsToggle() {
    var toggle = document.getElementById("dashboard-insights-toggle");
    if (!toggle) return;

    if (toggle.dataset.bound !== "1") {
      toggle.dataset.bound = "1";
      dashboardInsightsExpanded = false;
      toggle.addEventListener("click", function () {
        setDashboardInsightsExpanded(!dashboardInsightsExpanded);
      });
    }

    setDashboardInsightsExpanded(dashboardInsightsExpanded);
  }

  function updateWeightChartRangeButtons() {
    var rangeControl = document.getElementById("weights-chart-range");
    if (!rangeControl) return;

    var buttons = rangeControl.querySelectorAll("[data-chart-range]");
    for (var i = 0; i < buttons.length; i++) {
      var button = buttons[i];
      var isActive = button.getAttribute("data-chart-range") === weightChartRange;
      button.classList.toggle("is-active", isActive);
      button.setAttribute("aria-pressed", isActive ? "true" : "false");
    }
  }

  function bindWeightChartRangeEvents() {
    var rangeControl = document.getElementById("weights-chart-range");
    if (!rangeControl || rangeControl.dataset.bound === "1") return;

    rangeControl.dataset.bound = "1";
    rangeControl.addEventListener("click", function (event) {
      var target = event.target;
      if (!target || !target.closest) return;

      var button = target.closest("[data-chart-range]");
      if (!button) return;

      var nextRange = button.getAttribute("data-chart-range");
      if (!Object.prototype.hasOwnProperty.call(WEIGHT_CHART_RANGES, nextRange)) return;
      if (nextRange === weightChartRange) return;

      weightChartRange = nextRange;
      renderWeightsTrendChart(getWeights());
    });
  }

  function findNearestChartPoint(points, x) {
    if (!points || points.length === 0) return -1;
    if (points.length === 1) return 0;

    var low = 0;
    var high = points.length - 1;

    while (low < high) {
      var mid = Math.floor((low + high) / 2);
      if (points[mid].x < x) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }

    var index = low;
    if (index > 0) {
      var prev = points[index - 1];
      var curr = points[index];
      if (Math.abs(prev.x - x) <= Math.abs(curr.x - x)) {
        index = index - 1;
      }
    }

    return index;
  }

  function clearWeightsChartHover(svg, tooltip) {
    if (svg) {
      var hoverLine = svg.querySelector(".weight-chart-hover-line");
      var hoverDot = svg.querySelector(".weight-chart-hover-dot");
      if (hoverLine) hoverLine.classList.add("hidden");
      if (hoverDot) hoverDot.classList.add("hidden");
    }

    if (tooltip) {
      tooltip.classList.add("hidden");
      tooltip.setAttribute("aria-hidden", "true");
    }
  }

  function setWeightsChartHover(model, svg, tooltip, shellRect, index) {
    if (!svg || !tooltip || !model || !model.points[index]) return;

    var point = model.points[index];
    var hoverLine = svg.querySelector(".weight-chart-hover-line");
    var hoverDot = svg.querySelector(".weight-chart-hover-dot");

    if (hoverLine) {
      hoverLine.setAttribute("x1", point.x.toFixed(2));
      hoverLine.setAttribute("x2", point.x.toFixed(2));
      hoverLine.classList.remove("hidden");
    }

    if (hoverDot) {
      hoverDot.setAttribute("cx", point.x.toFixed(2));
      hoverDot.setAttribute("cy", point.y.toFixed(2));
      hoverDot.classList.remove("hidden");
    }

    tooltip.textContent = formatWeightNumber(point.weight) + " " + point.unit + " | " + formatDate(point.iso) + " " + formatTime(point.iso);
    tooltip.classList.remove("hidden");
    tooltip.setAttribute("aria-hidden", "false");

    var pointXPx = (point.x / model.width) * shellRect.width;
    var pointYPx = (point.y / model.height) * shellRect.height;
    var tipWidth = tooltip.offsetWidth || 0;
    var half = tipWidth / 2;
    var clampedLeft = pointXPx;

    if (tipWidth > 0) {
      clampedLeft = Math.max(half + 10, Math.min(shellRect.width - half - 10, pointXPx));
    }

    var top = Math.max(42, pointYPx - 10);
    tooltip.style.left = clampedLeft + "px";
    tooltip.style.top = top + "px";
  }

  function bindWeightsChartHover(model, svg) {
    var hitArea = svg ? svg.querySelector(".weight-chart-hit-area") : null;
    var tooltip = document.getElementById("weights-chart-tooltip");
    var shell = document.getElementById("weights-chart-shell");

    if (!hitArea || !tooltip || !shell) return;

    function updateFromPointer(e) {
      var rect = svg.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      var xRatio = (e.clientX - rect.left) / rect.width;
      if (!isFinite(xRatio)) return;

      if (xRatio < 0) xRatio = 0;
      if (xRatio > 1) xRatio = 1;

      var svgX = xRatio * model.width;
      if (svgX < model.plotLeft) svgX = model.plotLeft;
      if (svgX > model.plotRight) svgX = model.plotRight;

      var nearestIndex = findNearestChartPoint(model.points, svgX);
      var shellRect = shell.getBoundingClientRect();
      setWeightsChartHover(model, svg, tooltip, shellRect, nearestIndex);
    }

    hitArea.addEventListener("pointerenter", updateFromPointer);
    hitArea.addEventListener("pointermove", updateFromPointer);
    hitArea.addEventListener("pointerdown", updateFromPointer);
    hitArea.addEventListener("pointerleave", function () {
      clearWeightsChartHover(svg, tooltip);
    });
    hitArea.addEventListener("pointercancel", function () {
      clearWeightsChartHover(svg, tooltip);
    });
  }

  function renderWeightsTrendChart(weights) {
    var container = document.getElementById("weights-weight-chart");
    if (!container) return;

    bindWeightChartRangeEvents();
    updateWeightChartRangeButtons();

    var allSeries = getChartReadyWeights(weights);
    var tooltip = document.getElementById("weights-chart-tooltip");
    if (tooltip) clearWeightsChartHover(null, tooltip);

    if (allSeries.length === 0) {
      renderWeightChartEmpty(container, "Log weights to unlock chart history.");
      return;
    }

    var filtered = filterWeightSeriesForRange(allSeries, weightChartRange);
    if (filtered.length === 0) {
      renderWeightChartEmpty(container, "No entries in " + weightChartRangeLabel(weightChartRange) + ".");
      return;
    }

    var width = Math.floor(container.clientWidth || container.getBoundingClientRect().width || 0);
    var model = buildWeightChartModel(filtered, {
      width: width,
      interactive: true,
      chartId: "weights"
    });

    container.innerHTML = buildWeightChartSvg(model);
    var svg = container.querySelector("svg");
    if (svg) bindWeightsChartHover(model, svg);
  }

  function refreshWeightCharts() {
    var weights = getWeights();
    renderDashboardWeightChart(weights);
    renderWeightsTrendChart(weights);
  }

  function queueWeightChartRefresh() {
    if (chartRefreshFrame !== null) return;

    chartRefreshFrame = requestAnimationFrame(function () {
      chartRefreshFrame = null;
      refreshWeightCharts();
    });
  }

  function bindWeightChartThemeEvents() {
    if (chartThemeEventsBound || !window.matchMedia) return;
    chartThemeEventsBound = true;

    var themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
    var onThemeChange = function () {
      queueWeightChartRefresh();
    };

    if (typeof themeMedia.addEventListener === "function") {
      themeMedia.addEventListener("change", onThemeChange);
      return;
    }

    if (typeof themeMedia.addListener === "function") {
      themeMedia.addListener(onThemeChange);
    }
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

    bindDashboardInsightsToggle();

    var timeEl = document.getElementById("latest-weight-time");
    var change30dEl = document.getElementById("dashboard-primary-change-30d");
    var avg30dEl = document.getElementById("dashboard-primary-avg-30d");
    var change7dEl = document.getElementById("dashboard-detail-change-7d");
    var entriesEl = document.getElementById("dashboard-detail-entries");
    var trendNoteEl = document.getElementById("dashboard-trend-note");

    var series = getChartReadyWeights(getWeights());
    renderDashboardWeightChartFromSeries(series);

    if (series.length === 0) {
      valueEl.textContent = "--";
      if (timeEl) timeEl.textContent = "No entries yet";
      if (change30dEl) change30dEl.textContent = "--";
      if (avg30dEl) avg30dEl.textContent = "--";
      if (change7dEl) change7dEl.textContent = "--";
      if (entriesEl) entriesEl.textContent = "0";
      if (trendNoteEl) trendNoteEl.textContent = "Log weights to view trend.";
      return;
    }

    var latest = series[series.length - 1];
    var latestUnit = latest.unit || "kg";
    var trend7d = filterWeightSeriesForRange(series, "7d");
    var trend30d = filterWeightSeriesForRange(series, "30d");

    var change7d = (trend7d.length > 1) ? (latest.weight - trend7d[0].weight) : null;
    var change30d = (trend30d.length > 1) ? (latest.weight - trend30d[0].weight) : null;

    valueEl.textContent = formatWeightNumber(latest.weight) + " " + latestUnit;
    if (timeEl) {
      timeEl.textContent = relativeTimeStrict(latest.iso);
    }
    if (change30dEl) {
      change30dEl.textContent = formatSignedWeightDelta(change30d, latestUnit);
    }
    if (avg30dEl) {
      if (trend30d.length === 0) {
        avg30dEl.textContent = "--";
      } else {
        var total30d = 0;
        for (var i = 0; i < trend30d.length; i++) {
          total30d += trend30d[i].weight;
        }
        avg30dEl.textContent = formatWeightNumber(total30d / trend30d.length) + " " + latestUnit;
      }
    }
    if (change7dEl) {
      change7dEl.textContent = formatSignedWeightDelta(change7d, latestUnit);
    }
    if (entriesEl) {
      entriesEl.textContent = String(series.length);
    }
    if (trendNoteEl) {
      trendNoteEl.textContent = buildDashboardTrendNote(change30d, latestUnit);
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

  function buildWeightLogGroups(weights) {
    var source = Array.isArray(weights) ? weights : getWeights();
    var sorted = [];

    for (var i = 0; i < source.length; i++) {
      var entry = source[i];
      if (!entry || typeof entry !== "object") continue;

      var parsedWeight = (typeof entry.weight === "number") ? entry.weight : parseFloat(entry.weight);
      var timestampMs = new Date(entry.timestamp).getTime();

      if (!isFinite(parsedWeight) || parsedWeight <= 0) continue;
      if (!isFinite(timestampMs)) continue;

      sorted.push({
        id: entry.id,
        weight: parsedWeight,
        unit: entry.unit || "kg",
        timestamp: entry.timestamp,
        timestampMs: timestampMs
      });
    }

    sorted.sort(function (a, b) {
      return b.timestampMs - a.timestampMs;
    });

    var startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    var msDay = 24 * 60 * 60 * 1000;
    var todayStartMs = startOfToday.getTime();
    var last7StartMs = todayStartMs - (7 * msDay);
    var last30StartMs = todayStartMs - (30 * msDay);

    var groups = [
      { key: "today", title: "Today", entries: [] },
      { key: "last-7-days", title: "Last 7 Days", entries: [] },
      { key: "last-30-days", title: "Last 30 Days", entries: [] },
      { key: "older", title: "Older", entries: [] }
    ];

    for (var j = 0; j < sorted.length; j++) {
      var item = sorted[j];
      if (item.timestampMs >= todayStartMs) {
        groups[0].entries.push(item);
      } else if (item.timestampMs >= last7StartMs) {
        groups[1].entries.push(item);
      } else if (item.timestampMs >= last30StartMs) {
        groups[2].entries.push(item);
      } else {
        groups[3].entries.push(item);
      }
    }

    return groups;
  }

  function weightLogHasEntries(groups) {
    if (!Array.isArray(groups)) return false;

    for (var i = 0; i < groups.length; i++) {
      if (groups[i].entries && groups[i].entries.length > 0) {
        return true;
      }
    }

    return false;
  }

  function formatEntryCount(count) {
    if (count === 1) return "1 entry";
    return count + " entries";
  }

  function desktopWeightGroupHtml(group) {
    var rows = new Array(group.entries.length);
    for (var i = 0; i < group.entries.length; i++) {
      rows[i] = desktopWeightRowHtml(group.entries[i]);
    }

    return '<section class="weight-log-group" data-weight-log-group="' + escapeHtml(group.key) + '">'
      + '<div class="weight-log-group-header">'
      + '<p class="apple-overline weight-log-group-title">' + escapeHtml(group.title) + "</p>"
      + '<p class="apple-caption weight-log-group-count">' + escapeHtml(formatEntryCount(group.entries.length)) + "</p>"
      + "</div>"
      + '<div class="apple-card apple-table-card">'
      + '<table class="apple-table">'
      + '<thead>'
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
    var rows = new Array(group.entries.length);
    for (var i = 0; i < group.entries.length; i++) {
      rows[i] = mobileWeightRowHtml(group.entries[i]);
    }

    return '<section class="weight-log-group" data-weight-log-group="' + escapeHtml(group.key) + '">'
      + '<div class="weight-log-group-header">'
      + '<p class="apple-overline weight-log-group-title">' + escapeHtml(group.title) + "</p>"
      + '<p class="apple-caption weight-log-group-count">' + escapeHtml(formatEntryCount(group.entries.length)) + "</p>"
      + "</div>"
      + '<div class="weight-mobile-list">'
      + rows.join("")
      + "</div>"
      + "</section>";
  }

  function renderDesktopWeightGroups(groups, container) {
    if (!container) return;

    var markup = [];
    for (var i = 0; i < groups.length; i++) {
      if (!groups[i].entries || groups[i].entries.length === 0) continue;
      markup.push(desktopWeightGroupHtml(groups[i]));
    }

    container.innerHTML = markup.join("");
  }

  function renderMobileWeightGroups(groups, container) {
    if (!container) return;

    var markup = [];
    for (var i = 0; i < groups.length; i++) {
      if (!groups[i].entries || groups[i].entries.length === 0) continue;
      markup.push(mobileWeightGroupHtml(groups[i]));
    }

    container.innerHTML = markup.join("");
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
    var desktopGroups = document.getElementById("weight-desktop-groups");
    var mobileGroups = document.getElementById("weight-mobile-groups");
    if (!desktopGroups || !mobileGroups) {
      lastWeightUiMode = null;
      return;
    }

    var weights = getWeights();
    var groups = buildWeightLogGroups(weights);
    var emptyState = document.getElementById("weight-empty-state");
    var desktopContainer = document.getElementById("weight-desktop-groups-container");
    var mobileContainer = document.getElementById("weight-mobile-groups-container");
    renderWeightsTrendChart(weights);

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

    var useMobileUi = isMobileWeightUI();
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
      var shouldSelectOnFocus = !isMobileWeightUI();
      setWeightModalMode(true);
      modal.classList.remove("hidden");
      modal.classList.remove("is-closing");
      modal.setAttribute("aria-hidden", "false");
      requestAnimationFrame(function () {
        modal.classList.add("is-open");
      });
      focusWeightInput(input, shouldSelectOnFocus);
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

      var desktopGroups = document.getElementById("weight-desktop-groups");
      var mobileGroups = document.getElementById("weight-mobile-groups");
      if (!desktopGroups || !mobileGroups) {
        queueWeightChartRefresh();
        return;
      }

      var useMobileUi = isMobileWeightUI();
      if (lastWeightUiMode === null) {
        lastWeightUiMode = useMobileUi;
        queueWeightChartRefresh();
        return;
      }

      if (useMobileUi !== lastWeightUiMode) {
        populateWeights();
      } else {
        queueWeightChartRefresh();
      }
    });
  }

  function bindGlobalEvents() {
    if (globalEventsBound) return;
    globalEventsBound = true;
    bindWeightChartThemeEvents();

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
