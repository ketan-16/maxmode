import {
  buildDashboardTrendNoteFromKg,
  filterWeightSeriesForRange,
  formatSignedWeightDeltaFromKg,
  formatWeightWithUnit,
  mapWeightsToDisplay,
  relativeTimeStrict
} from "../modules/data-utils.mjs";
import { renderDashboardWeightChart } from "../modules/charts.mjs";
import { getUserPreferences } from "../modules/storage.mjs";

let dashboardInsightsExpanded = false;

function setDashboardInsightsExpanded(expanded) {
  dashboardInsightsExpanded = !!expanded;

  const toggle = document.getElementById("dashboard-insights-toggle");
  const panel = document.getElementById("dashboard-insights-panel");

  if (toggle) {
    toggle.setAttribute("aria-expanded", dashboardInsightsExpanded ? "true" : "false");
  }

  if (panel) {
    panel.hidden = !dashboardInsightsExpanded;
  }
}

function bindDashboardInsightsToggle() {
  const toggle = document.getElementById("dashboard-insights-toggle");
  if (!toggle) return;

  if (toggle.dataset.bound !== "1") {
    toggle.dataset.bound = "1";
    toggle.addEventListener("click", () => {
      setDashboardInsightsExpanded(!dashboardInsightsExpanded);
    });
  }

  setDashboardInsightsExpanded(dashboardInsightsExpanded);
}

export function render(state) {
  const valueEl = document.getElementById("latest-weight-value");
  if (!valueEl) return;

  bindDashboardInsightsToggle();

  const timeEl = document.getElementById("latest-weight-time");
  const change30dEl = document.getElementById("dashboard-primary-change-30d");
  const avg30dEl = document.getElementById("dashboard-primary-avg-30d");
  const change7dEl = document.getElementById("dashboard-detail-change-7d");
  const entriesEl = document.getElementById("dashboard-detail-entries");
  const trendNoteEl = document.getElementById("dashboard-trend-note");

  const series = state && Array.isArray(state.chartSeries) ? state.chartSeries : [];
  const preferences = getUserPreferences(state);
  const preferredWeightUnit = preferences.weightUnit;
  const displaySeries = mapWeightsToDisplay(series, preferredWeightUnit);

  renderDashboardWeightChart(document.getElementById("dashboard-weight-chart"), displaySeries);

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

  const latest = series[series.length - 1];
  const trend7d = filterWeightSeriesForRange(series, "7d");
  const trend30d = filterWeightSeriesForRange(series, "30d");

  const change7dKg = (trend7d.length > 1) ? (latest.weight - trend7d[0].weight) : null;
  const change30dKg = (trend30d.length > 1) ? (latest.weight - trend30d[0].weight) : null;

  valueEl.textContent = formatWeightWithUnit(latest.weight, preferredWeightUnit);
  if (timeEl) {
    timeEl.textContent = relativeTimeStrict(latest.iso);
  }
  if (change30dEl) {
    change30dEl.textContent = formatSignedWeightDeltaFromKg(change30dKg, preferredWeightUnit);
  }

  if (avg30dEl) {
    if (trend30d.length === 0) {
      avg30dEl.textContent = "--";
    } else {
      let total30d = 0;
      for (let i = 0; i < trend30d.length; i += 1) {
        total30d += trend30d[i].weight;
      }
      avg30dEl.textContent = formatWeightWithUnit(total30d / trend30d.length, preferredWeightUnit);
    }
  }

  if (change7dEl) {
    change7dEl.textContent = formatSignedWeightDeltaFromKg(change7dKg, preferredWeightUnit);
  }

  if (entriesEl) {
    entriesEl.textContent = String(series.length);
  }

  if (trendNoteEl) {
    trendNoteEl.textContent = buildDashboardTrendNoteFromKg(change30dKg, preferredWeightUnit);
  }
}
