import {
  escapeHtml,
  filterWeightSeriesForRange,
  formatDate,
  formatTime,
  formatWeightNumber,
  WEIGHT_CHART_RANGES,
  weightChartRangeLabel
} from "./data-utils.mjs";

let weightChartRange = "30d";
let chartThemeEventsBound = false;

export function getWeightChartRange() {
  return weightChartRange;
}

export function setWeightChartRange(rangeKey) {
  if (!Object.prototype.hasOwnProperty.call(WEIGHT_CHART_RANGES, rangeKey)) return;
  weightChartRange = rangeKey;
}

function formatChartDate(timestamp, includeYear) {
  const date = new Date(timestamp);
  const options = { month: "short", day: "numeric" };
  if (includeYear) options.year = "2-digit";
  return date.toLocaleDateString(undefined, options);
}

function buildSmoothLinePath(points) {
  if (!points || points.length === 0) return "";

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  if (points.length === 1) {
    const only = points[0];
    const x1 = (only.x - 0.01).toFixed(2);
    const x2 = (only.x + 0.01).toFixed(2);
    const y = only.y.toFixed(2);
    return `M ${x1} ${y} L ${x2} ${y}`;
  }

  const first = points[0];
  if (points.length === 2) {
    const second = points[1];
    return `M ${first.x.toFixed(2)} ${first.y.toFixed(2)} L ${second.x.toFixed(2)} ${second.y.toFixed(2)}`;
  }

  let path = `M ${first.x.toFixed(2)} ${first.y.toFixed(2)}`;

  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];

    if (p2.x <= p1.x) {
      path += ` L ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
      continue;
    }

    let cp1x = p1.x + ((p2.x - p0.x) / 6);
    let cp1y = p1.y + ((p2.y - p0.y) / 6);
    let cp2x = p2.x - ((p3.x - p1.x) / 6);
    let cp2y = p2.y - ((p3.y - p1.y) / 6);

    cp1x = clamp(cp1x, p1.x, p2.x);
    cp2x = clamp(cp2x, p1.x, p2.x);
    if (cp1x > cp2x) {
      const midX = (p1.x + p2.x) / 2;
      cp1x = midX;
      cp2x = midX;
    }

    const minY = Math.min(p1.y, p2.y);
    const maxY = Math.max(p1.y, p2.y);
    cp1y = clamp(cp1y, minY, maxY);
    cp2y = clamp(cp2y, minY, maxY);

    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)}, ${cp2x.toFixed(2)} ${cp2y.toFixed(2)}, ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }

  return path;
}

function buildWeightChartModel(points, options) {
  const interactive = !!(options && options.interactive);
  const widthInput = options && options.width ? Math.floor(options.width) : 0;
  const width = Math.max(300, widthInput || 640);
  const height = interactive ? 248 : 220;

  const padding = interactive
    ? { top: 54, right: 18, bottom: 30, left: 48 }
    : { top: 24, right: 18, bottom: 30, left: 48 };

  const plotLeft = padding.left;
  const plotTop = padding.top;
  const plotWidth = Math.max(120, width - padding.left - padding.right);
  const plotHeight = Math.max(90, height - padding.top - padding.bottom);
  const plotRight = plotLeft + plotWidth;
  const plotBottom = plotTop + plotHeight;

  let minWeight = points[0].weight;
  let maxWeight = points[0].weight;
  const minTimestamp = points[0].timestamp;
  const maxTimestamp = points[points.length - 1].timestamp;

  for (let i = 1; i < points.length; i += 1) {
    const weight = points[i].weight;
    if (weight < minWeight) minWeight = weight;
    if (weight > maxWeight) maxWeight = weight;
  }

  const spread = maxWeight - minWeight;
  const pad = spread === 0 ? Math.max(0.8, maxWeight * 0.02) : Math.max(0.5, spread * 0.18);
  const domainMin = Math.max(0, minWeight - pad);
  let domainMax = maxWeight + pad;

  if ((domainMax - domainMin) < 0.1) {
    domainMax = domainMin + 0.1;
  }

  const domainSpan = domainMax - domainMin;
  const timeSpan = maxTimestamp - minTimestamp;
  const singleTimestamp = timeSpan <= 0;

  function xForTimestamp(timestamp) {
    if (singleTimestamp) return plotLeft + (plotWidth / 2);
    return plotLeft + (((timestamp - minTimestamp) / timeSpan) * plotWidth);
  }

  function yForWeight(weight) {
    return plotTop + ((1 - ((weight - domainMin) / domainSpan)) * plotHeight);
  }

  const projected = new Array(points.length);
  for (let p = 0; p < points.length; p += 1) {
    const point = points[p];
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

  const linePath = buildSmoothLinePath(projected);
  let areaPath = "";
  if (projected.length > 1 && linePath) {
    areaPath = `${linePath} L ${projected[projected.length - 1].x.toFixed(2)} ${plotBottom.toFixed(2)} L ${projected[0].x.toFixed(2)} ${plotBottom.toFixed(2)} Z`;
  }

  const yTicks = [];
  for (let yIndex = 0; yIndex <= 4; yIndex += 1) {
    const yRatio = yIndex / 4;
    yTicks.push({
      y: plotTop + (yRatio * plotHeight),
      value: domainMax - (yRatio * domainSpan)
    });
  }

  const xTicks = [];
  const includeYear = new Date(minTimestamp).getFullYear() !== new Date(maxTimestamp).getFullYear();
  const tickIndices = [0, Math.floor((projected.length - 1) / 2), projected.length - 1];
  const seen = {};

  for (let t = 0; t < tickIndices.length; t += 1) {
    const idx = tickIndices[t];
    if (seen[idx]) continue;
    seen[idx] = true;

    xTicks.push({
      x: projected[idx].x,
      label: formatChartDate(projected[idx].timestamp, includeYear)
    });
  }

  const safeId = (options && options.chartId ? String(options.chartId) : "chart").replace(/[^a-zA-Z0-9_-]/g, "");
  const gradientId = `weight-chart-gradient-${safeId}`;

  return {
    width,
    height,
    plotLeft,
    plotRight,
    plotTop,
    plotBottom,
    plotWidth,
    plotHeight,
    linePath,
    areaPath,
    points: projected,
    yTicks,
    xTicks,
    gradientId,
    interactive
  };
}

function buildWeightChartSvg(model) {
  const parts = [];
  parts.push(`<svg class="weight-chart-svg weight-chart-animated" viewBox="0 0 ${model.width} ${model.height}" role="img" aria-label="Weight trend chart">`);
  parts.push("<defs>");
  parts.push(`<linearGradient id="${model.gradientId}" x1="0" y1="0" x2="0" y2="1">`);
  parts.push('<stop offset="0%" class="weight-chart-area-stop-start"></stop>');
  parts.push('<stop offset="100%" class="weight-chart-area-stop-end"></stop>');
  parts.push("</linearGradient>");
  parts.push("</defs>");

  parts.push('<g class="weight-chart-grid">');
  for (let i = 0; i < model.yTicks.length; i += 1) {
    const yTick = model.yTicks[i];
    parts.push(`<line class="weight-chart-grid-line" x1="${model.plotLeft.toFixed(2)}" y1="${yTick.y.toFixed(2)}" x2="${model.plotRight.toFixed(2)}" y2="${yTick.y.toFixed(2)}"></line>`);
    parts.push(`<text class="weight-chart-axis-label" x="${(model.plotLeft - 10).toFixed(2)}" y="${(yTick.y + 4).toFixed(2)}" text-anchor="end">${escapeHtml(formatWeightNumber(yTick.value))}</text>`);
  }

  for (let xIndex = 0; xIndex < model.xTicks.length; xIndex += 1) {
    const xTick = model.xTicks[xIndex];
    parts.push(`<text class="weight-chart-axis-label" x="${xTick.x.toFixed(2)}" y="${(model.plotBottom + 18).toFixed(2)}" text-anchor="middle">${escapeHtml(xTick.label)}</text>`);
  }
  parts.push("</g>");

  if (model.areaPath) {
    parts.push(`<path class="weight-chart-path-area" d="${model.areaPath}" fill="url(#${model.gradientId})"></path>`);
  }

  parts.push(`<path class="weight-chart-path-line" pathLength="1" d="${model.linePath}"></path>`);

  parts.push('<g class="weight-chart-points">');
  for (let pointIndex = 0; pointIndex < model.points.length; pointIndex += 1) {
    const point = model.points[pointIndex];
    parts.push(`<circle class="weight-chart-point" cx="${point.x.toFixed(2)}" cy="${point.y.toFixed(2)}" r="${model.interactive ? "2.9" : "2.5"}"></circle>`);
  }
  parts.push("</g>");

  if (model.interactive) {
    parts.push(`<line class="weight-chart-hover-line hidden" x1="0" y1="${model.plotTop.toFixed(2)}" x2="0" y2="${model.plotBottom.toFixed(2)}"></line>`);
    parts.push('<circle class="weight-chart-hover-dot hidden" cx="0" cy="0" r="5"></circle>');
    parts.push(`<rect class="weight-chart-hit-area" x="${model.plotLeft.toFixed(2)}" y="${model.plotTop.toFixed(2)}" width="${model.plotWidth.toFixed(2)}" height="${model.plotHeight.toFixed(2)}" rx="10" ry="10"></rect>`);
  }

  parts.push("</svg>");
  return parts.join("");
}

function renderWeightChartEmpty(container, message) {
  if (!container) return;
  container.innerHTML = `<div class="weight-chart-empty">${escapeHtml(message)}</div>`;
}

function getDashboardChartRenderKey(series, chartWidth) {
  if (!Array.isArray(series) || series.length === 0) {
    return "empty";
  }

  const parts = [String(chartWidth), String(series.length)];
  for (let i = 0; i < series.length; i += 1) {
    parts.push(String(series[i].timestamp));
    parts.push(String(series[i].weight));
  }
  return parts.join("|");
}

export function renderDashboardWeightChart(container, series) {
  if (!container) return;

  if (!series || series.length === 0) {
    if (container.dataset.chartKey === "empty") return;
    renderWeightChartEmpty(container, "Log weights to view your trend.");
    container.dataset.chartKey = "empty";
    return;
  }

  const width = Math.floor(container.clientWidth || container.getBoundingClientRect().width || 0);
  const chartWidth = Math.max(300, width || 640);
  const nextKey = getDashboardChartRenderKey(series, chartWidth);

  if (container.dataset.chartKey === nextKey) return;

  const model = buildWeightChartModel(series, {
    width: chartWidth,
    interactive: false,
    chartId: "dashboard"
  });

  container.innerHTML = buildWeightChartSvg(model);
  container.dataset.chartKey = nextKey;
}

function findNearestChartPoint(points, x) {
  if (!points || points.length === 0) return -1;
  if (points.length === 1) return 0;

  let low = 0;
  let high = points.length - 1;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (points[mid].x < x) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  let index = low;
  if (index > 0) {
    const prev = points[index - 1];
    const curr = points[index];
    if (Math.abs(prev.x - x) <= Math.abs(curr.x - x)) {
      index -= 1;
    }
  }

  return index;
}

function clearWeightsChartHover(svg, tooltip) {
  if (svg) {
    const hoverLine = svg.querySelector(".weight-chart-hover-line");
    const hoverDot = svg.querySelector(".weight-chart-hover-dot");
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

  const point = model.points[index];
  const hoverLine = svg.querySelector(".weight-chart-hover-line");
  const hoverDot = svg.querySelector(".weight-chart-hover-dot");

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

  tooltip.textContent = `${formatWeightNumber(point.weight)} ${point.unit} | ${formatDate(point.iso)} ${formatTime(point.iso)}`;
  tooltip.classList.remove("hidden");
  tooltip.setAttribute("aria-hidden", "false");

  const pointXPx = (point.x / model.width) * shellRect.width;
  const pointYPx = (point.y / model.height) * shellRect.height;
  const tipWidth = tooltip.offsetWidth || 0;
  const half = tipWidth / 2;
  let clampedLeft = pointXPx;

  if (tipWidth > 0) {
    clampedLeft = Math.max(half + 10, Math.min(shellRect.width - half - 10, pointXPx));
  }

  const top = Math.max(42, pointYPx - 10);
  tooltip.style.left = `${clampedLeft}px`;
  tooltip.style.top = `${top}px`;
}

function bindWeightsChartHover(model, svg) {
  const hitArea = svg ? svg.querySelector(".weight-chart-hit-area") : null;
  const tooltip = document.getElementById("weights-chart-tooltip");
  const shell = document.getElementById("weights-chart-shell");

  if (!hitArea || !tooltip || !shell) return;

  function updateFromPointer(e) {
    const rect = svg.getBoundingClientRect();
    if (!rect.width || !rect.height) return;

    let xRatio = (e.clientX - rect.left) / rect.width;
    if (!Number.isFinite(xRatio)) return;

    if (xRatio < 0) xRatio = 0;
    if (xRatio > 1) xRatio = 1;

    let svgX = xRatio * model.width;
    if (svgX < model.plotLeft) svgX = model.plotLeft;
    if (svgX > model.plotRight) svgX = model.plotRight;

    const nearestIndex = findNearestChartPoint(model.points, svgX);
    const shellRect = shell.getBoundingClientRect();
    setWeightsChartHover(model, svg, tooltip, shellRect, nearestIndex);
  }

  hitArea.addEventListener("pointerenter", updateFromPointer);
  hitArea.addEventListener("pointermove", updateFromPointer);
  hitArea.addEventListener("pointerdown", updateFromPointer);
  hitArea.addEventListener("pointerleave", () => clearWeightsChartHover(svg, tooltip));
  hitArea.addEventListener("pointercancel", () => clearWeightsChartHover(svg, tooltip));
}

export function bindWeightChartRangeEvents(onRangeChange) {
  const rangeControl = document.getElementById("weights-chart-range");
  if (!rangeControl || rangeControl.dataset.bound === "1") return;

  rangeControl.dataset.bound = "1";
  rangeControl.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || !target.closest) return;

    const button = target.closest("[data-chart-range]");
    if (!button) return;

    const nextRange = button.getAttribute("data-chart-range");
    if (!Object.prototype.hasOwnProperty.call(WEIGHT_CHART_RANGES, nextRange)) return;
    if (nextRange === weightChartRange) return;

    weightChartRange = nextRange;
    if (typeof onRangeChange === "function") onRangeChange(weightChartRange);
  });
}

export function updateWeightChartRangeButtons() {
  const rangeControl = document.getElementById("weights-chart-range");
  if (!rangeControl) return;

  const buttons = rangeControl.querySelectorAll("[data-chart-range]");
  for (let i = 0; i < buttons.length; i += 1) {
    const button = buttons[i];
    const isActive = button.getAttribute("data-chart-range") === weightChartRange;
    button.classList.toggle("is-active", isActive);
    button.setAttribute("aria-pressed", isActive ? "true" : "false");
  }
}

export function renderWeightsTrendChart(series) {
  const container = document.getElementById("weights-weight-chart");
  if (!container) return;

  updateWeightChartRangeButtons();

  const tooltip = document.getElementById("weights-chart-tooltip");
  if (tooltip) clearWeightsChartHover(null, tooltip);

  if (!Array.isArray(series) || series.length === 0) {
    renderWeightChartEmpty(container, "Log weights to unlock chart history.");
    return;
  }

  const filtered = filterWeightSeriesForRange(series, weightChartRange);
  if (filtered.length === 0) {
    renderWeightChartEmpty(container, `No entries in ${weightChartRangeLabel(weightChartRange)}.`);
    return;
  }

  const width = Math.floor(container.clientWidth || container.getBoundingClientRect().width || 0);
  const model = buildWeightChartModel(filtered, {
    width,
    interactive: true,
    chartId: "weights"
  });

  container.innerHTML = buildWeightChartSvg(model);
  const svg = container.querySelector("svg");
  if (svg) bindWeightsChartHover(model, svg);
}

export function bindWeightChartThemeEvents(onThemeChange) {
  if (chartThemeEventsBound || !window.matchMedia) return;
  chartThemeEventsBound = true;

  const themeMedia = window.matchMedia("(prefers-color-scheme: dark)");
  const handler = () => {
    if (typeof onThemeChange === "function") onThemeChange();
  };

  if (typeof themeMedia.addEventListener === "function") {
    themeMedia.addEventListener("change", handler);
  } else if (typeof themeMedia.addListener === "function") {
    themeMedia.addListener(handler);
  }
}
