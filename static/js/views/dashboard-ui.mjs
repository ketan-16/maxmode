import {
  escapeHtml,
  filterWeightSeriesForRange,
  formatSignedWeightDeltaFromKg,
  formatTime,
  formatWeightWithUnit,
  mapWeightsToDisplay,
  relativeTimeStrict
} from "../modules/data-utils.mjs";
import { renderDashboardWeightChart } from "../modules/charts.mjs";
import { getUserPreferences } from "../modules/storage.mjs";
import {
  buildCalorieTrackerSummary,
  buildWeeklyCalorieIntakeSeries
} from "../modules/meal-utils.mjs";

const MACRO_RING_RADII = Object.freeze({
  protein: 54,
  carbs: 42,
  fat: 30
});
const WEEKLY_BAR_RATIO_CAP = 1.18;
const MEAL_ROW_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.85" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 3v7"></path><path d="M6 3v6"></path><path d="M10 3v6"></path><path d="M8 13v8"></path><path d="M16 3v18"></path><path d="M16 3c2.2 0 4 1.8 4 4v2h-4"></path></svg>';

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

function setTextContent(id, value) {
  const element = document.getElementById(id);
  if (!element) return null;
  element.textContent = value;
  return element;
}

function setMacroRingProgress(elementId, radius, ratio) {
  const element = document.getElementById(elementId);
  if (!element) return;

  const safeRadius = Math.max(1, Number(radius) || 1);
  const circumference = 2 * Math.PI * safeRadius;
  const boundedRatio = Math.max(0, Math.min(1, ratio || 0));

  element.style.strokeDasharray = `${circumference.toFixed(2)} ${circumference.toFixed(2)}`;
  element.style.strokeDashoffset = `${(circumference * (1 - boundedRatio)).toFixed(2)}`;
}

function renderGoalCard(summary) {
  const card = document.getElementById("dashboard-goal-card");
  if (!card) return;

  const remainingValue = summary.isOver ? summary.overCalories : summary.remainingCalories;
  const goalProgress = summary.goalCalories > 0
    ? Math.max(0, Math.min(1, summary.consumedCalories / summary.goalCalories))
    : 0;

  card.classList.toggle("is-over", summary.isOver);
  setTextContent("dashboard-goal-remaining", formatCalories(remainingValue));
  setTextContent("dashboard-goal-status", summary.isOver ? "Over goal" : "Remaining");
  setTextContent("dashboard-goal-consumed", formatCalories(summary.consumedCalories));
  setTextContent("dashboard-goal-target", formatCalories(summary.goalCalories));
  setTextContent(
    "dashboard-goal-note",
    summary.mealCount > 0 ? `${summary.mealCount} meals logged today` : "No meals logged today"
  );

  const progress = document.getElementById("dashboard-goal-progress");
  if (progress) {
    progress.style.width = `${(goalProgress * 100).toFixed(1)}%`;
  }
}

function renderMacroCard(summary) {
  const targets = summary.macroTargets;
  const macroProfile = summary.macroProfile;

  setMacroRingProgress(
    "dashboard-macro-ring-protein",
    MACRO_RING_RADII.protein,
    targets.protein > 0 ? (summary.protein / targets.protein) : 0
  );
  setMacroRingProgress(
    "dashboard-macro-ring-carbs",
    MACRO_RING_RADII.carbs,
    targets.carbs > 0 ? (summary.carbs / targets.carbs) : 0
  );
  setMacroRingProgress(
    "dashboard-macro-ring-fat",
    MACRO_RING_RADII.fat,
    targets.fat > 0 ? (summary.fat / targets.fat) : 0
  );

  setTextContent("dashboard-macro-protein-value", `${formatCalories(summary.protein)}g`);
  setTextContent("dashboard-macro-carbs-value", `${formatCalories(summary.carbs)}g`);
  setTextContent("dashboard-macro-fat-value", `${formatCalories(summary.fat)}g`);
  setTextContent("dashboard-macro-protein-target", `Goal ${formatCalories(targets.protein)}g`);
  setTextContent("dashboard-macro-carbs-target", `Goal ${formatCalories(targets.carbs)}g`);
  setTextContent("dashboard-macro-fat-target", `Goal ${formatCalories(targets.fat)}g`);
  setTextContent(
    "dashboard-macro-center-value",
    `${formatDecimal(macroProfile.proteinMultiplierDisplayValue)} ${macroProfile.proteinMultiplierDisplayUnit} • ${formatPercent(macroProfile.carbPercent)} • ${formatPercent(macroProfile.fatPercent)}`
  );
}

function renderWeightCard(state, preferredWeightUnit) {
  const valueEl = document.getElementById("dashboard-weight-value");
  const timeEl = document.getElementById("dashboard-weight-time");
  const deltaEl = document.getElementById("dashboard-weight-delta");
  const trendEl = document.getElementById("dashboard-weight-trend");
  if (!valueEl || !timeEl || !deltaEl || !trendEl) return;

  const series = state && Array.isArray(state.chartSeries) ? state.chartSeries : [];
  const displaySeries = mapWeightsToDisplay(series, preferredWeightUnit);

  renderDashboardWeightChart(trendEl, displaySeries.slice(-8));

  if (series.length === 0) {
    valueEl.textContent = "--";
    timeEl.textContent = "No entries yet";
    deltaEl.textContent = "";
    deltaEl.classList.add("hidden");
    deltaEl.classList.remove("is-up", "is-down", "is-compact");
    return;
  }

  const latest = series[series.length - 1];
  const trend30d = filterWeightSeriesForRange(series, "30d");
  const change30dKg = trend30d.length > 1 ? (latest.weight - trend30d[0].weight) : null;

  valueEl.textContent = formatWeightWithUnit(latest.weight, preferredWeightUnit);
  timeEl.textContent = `Logged ${relativeTimeStrict(latest.iso)}`;

  if (typeof change30dKg === "number" && Number.isFinite(change30dKg)) {
    deltaEl.textContent = formatSignedWeightDeltaFromKg(change30dKg, preferredWeightUnit);
    deltaEl.classList.remove("hidden");
    deltaEl.classList.toggle("is-up", change30dKg > 0.005);
    deltaEl.classList.toggle("is-down", change30dKg < -0.005);
    deltaEl.classList.toggle("is-compact", deltaEl.textContent.length >= 9);
  } else {
    deltaEl.textContent = "";
    deltaEl.classList.add("hidden");
    deltaEl.classList.remove("is-up", "is-down", "is-compact");
  }
}

function buildWeeklyBarsMarkup(days) {
  return days.map((day) => {
    const clampedRatio = Math.max(0, Math.min(WEEKLY_BAR_RATIO_CAP, day.ratio || 0));
    const visualRatio = WEEKLY_BAR_RATIO_CAP > 0 ? (clampedRatio / WEEKLY_BAR_RATIO_CAP) : 0;
    const height = day.hasMeals ? (18 + (visualRatio * 82)) : 18;
    const dayLabel = day.label || "";
    const title = `${day.fullLabel}: ${formatCalories(day.consumedCalories)} kcal`;

    return `<div class="dashboard-weekly-day">
      <div class="dashboard-weekly-bar-shell">
        <span class="dashboard-weekly-bar-fill${day.hasMeals ? " has-value" : ""}${day.isToday ? " is-today" : ""}${day.isOver ? " is-over" : ""}" style="height: ${height.toFixed(1)}%;" title="${escapeHtml(title)}"></span>
      </div>
      <span class="dashboard-weekly-label${day.isToday ? " is-today" : ""}">${escapeHtml(dayLabel)}</span>
    </div>`;
  }).join("");
}

function renderWeeklyCard(days, summary) {
  const noteEl = document.getElementById("dashboard-weekly-note");
  const barsEl = document.getElementById("dashboard-weekly-bars");
  if (!noteEl || !barsEl) return;

  const loggedDays = days.filter((day) => day.hasMeals).length;

  noteEl.textContent = loggedDays > 0
    ? `${loggedDays}/7 days logged / Goal ${formatCalories(summary.goalCalories)} kcal`
    : `Goal ${formatCalories(summary.goalCalories)} kcal`;
  barsEl.innerHTML = buildWeeklyBarsMarkup(days);
}

function renderStreakCard(summary, weeklyDays) {
  const valueEl = document.getElementById("dashboard-streak-value");
  const labelEl = document.getElementById("dashboard-streak-label");
  const noteEl = document.getElementById("dashboard-streak-note");
  if (!valueEl || !labelEl || !noteEl) return;

  const streakCount = Math.max(0, Math.round(summary.streakCount || 0));
  const loggedDays = Array.isArray(weeklyDays)
    ? weeklyDays.filter((day) => day && day.hasMeals).length
    : 0;

  valueEl.textContent = String(streakCount);
  labelEl.textContent = streakCount === 1 ? "day in a row" : "days in a row";
  noteEl.textContent = loggedDays > 0
    ? `${loggedDays} of last 7 days logged`
    : "Log a meal to start your streak";
}

function getMealTone(loggedAt) {
  const hour = new Date(loggedAt).getHours();
  if (!Number.isFinite(hour)) return "snack";
  if (hour >= 5 && hour < 11) return "breakfast";
  if (hour >= 11 && hour < 17) return "lunch";
  if (hour >= 17 && hour < 22) return "dinner";
  return "snack";
}

function buildMealMacroText(meal) {
  const parts = [];

  if (meal.protein > 0) parts.push(`P ${formatCalories(meal.protein)}g`);
  if (meal.carbs > 0) parts.push(`C ${formatCalories(meal.carbs)}g`);
  if (meal.fat > 0) parts.push(`F ${formatCalories(meal.fat)}g`);

  return parts.join(" / ");
}

function mealRowHtml(meal) {
  const macroText = buildMealMacroText(meal);
  const tone = getMealTone(meal.loggedAt);
  const timeText = formatTime(meal.loggedAt);

  return `<article class="dashboard-meal-row">
    <span class="dashboard-meal-icon dashboard-meal-icon-${tone}" aria-hidden="true">${MEAL_ROW_ICON}</span>
    <span class="dashboard-meal-copy">
      <span class="dashboard-meal-name">${escapeHtml(meal.name)}</span>
      <span class="dashboard-meal-meta">
        <span>${escapeHtml(timeText)}</span>
        ${macroText ? `<span class="dashboard-meal-meta-divider" aria-hidden="true"></span><span>${escapeHtml(macroText)}</span>` : ""}
      </span>
    </span>
    <span class="dashboard-meal-calories">${formatCalories(meal.calories)} kcal</span>
  </article>`;
}

function renderMealsCard(summary) {
  const metaEl = document.getElementById("dashboard-meals-meta");
  const listEl = document.getElementById("dashboard-today-meals-list");
  if (!metaEl || !listEl) return;

  const todaysMeals = Array.isArray(summary.todaysMeals) ? summary.todaysMeals : [];
  const visibleMeals = todaysMeals.slice(0, 4).reverse();

  metaEl.textContent = summary.mealCount > 0
    ? `${summary.mealCount} logged today`
    : "No meals logged today";

  if (visibleMeals.length === 0) {
    listEl.innerHTML = '<div class="dashboard-meals-empty">Today\'s meals will show up here after you log them.</div>';
    return;
  }

  listEl.innerHTML = visibleMeals.map((meal) => mealRowHtml(meal)).join("");
}

export function render(state) {
  const root = document.getElementById("dashboard-page-root");
  if (!root) return;

  const summary = buildCalorieTrackerSummary(state);
  const weeklyDays = buildWeeklyCalorieIntakeSeries(state);
  const preferences = getUserPreferences(state);
  const preferredWeightUnit = preferences.weightUnit;

  renderGoalCard(summary);
  renderMacroCard(summary);
  renderWeightCard(state, preferredWeightUnit);
  renderWeeklyCard(weeklyDays, summary);
  renderStreakCard(summary, weeklyDays);
  renderMealsCard(summary);
}
