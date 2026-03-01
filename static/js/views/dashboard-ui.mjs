import {
  buildDashboardTrendNote,
  filterWeightSeriesForRange,
  formatSignedWeightDelta,
  formatWeightNumber,
  relativeTimeStrict
} from "../modules/data-utils.mjs";
import { renderDashboardWeightChart } from "../modules/charts.mjs";

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
  renderDashboardWeightChart(document.getElementById("dashboard-weight-chart"), series);

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
  const latestUnit = latest.unit || "kg";
  const trend7d = filterWeightSeriesForRange(series, "7d");
  const trend30d = filterWeightSeriesForRange(series, "30d");

  const change7d = (trend7d.length > 1) ? (latest.weight - trend7d[0].weight) : null;
  const change30d = (trend30d.length > 1) ? (latest.weight - trend30d[0].weight) : null;

  valueEl.textContent = `${formatWeightNumber(latest.weight)} ${latestUnit}`;
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
      let total30d = 0;
      for (let i = 0; i < trend30d.length; i += 1) {
        total30d += trend30d[i].weight;
      }
      avg30dEl.textContent = `${formatWeightNumber(total30d / trend30d.length)} ${latestUnit}`;
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
