import {
  DEFAULT_DAILY_GOAL as BASE_DEFAULT_DAILY_GOAL,
  resolveCalorieGoalFromState
} from "./calories-utils.mjs";

export const DEFAULT_DAILY_GOAL = BASE_DEFAULT_DAILY_GOAL;
export const PORTION_MIN = 0.5;
export const PORTION_MAX = 2.5;
export const PORTION_STEP = 0.25;
export const RECENT_FOOD_LIMIT = 5;
export const FREQUENT_FOOD_LIMIT = 5;

const VALID_SOURCES = new Set(["scan", "manual", "voice", "recent"]);
const VALID_CONFIDENCE = new Set(["low", "medium", "high"]);

function parseFiniteNumber(value) {
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWholeNumber(value) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed);
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function isValidDate(value) {
  return Number.isFinite(new Date(value).getTime());
}

function createEntryId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function normalizeSource(value) {
  return VALID_SOURCES.has(value) ? value : "manual";
}

function normalizeConfidence(value) {
  if (typeof value !== "string") return "medium";
  const normalized = value.trim().toLowerCase();
  return VALID_CONFIDENCE.has(normalized) ? normalized : "medium";
}

function normalizeMacroValue(value) {
  const parsed = parseWholeNumber(value);
  if (parsed === null || parsed < 0) return 0;
  return parsed;
}

function normalizeName(value) {
  const trimmed = (typeof value === "string") ? value.trim() : "";
  return trimmed || "Meal";
}

function deriveBaseValue(baseValue, totalValue, portion) {
  const parsedBase = parseWholeNumber(baseValue);
  if (parsedBase !== null && parsedBase >= 0) return parsedBase;

  const parsedTotal = parseWholeNumber(totalValue);
  if (parsedTotal !== null && parsedTotal >= 0 && portion > 0) {
    return Math.max(0, Math.round(parsedTotal / portion));
  }

  return 0;
}

export function clampPortion(value) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) return 1;

  const stepped = Math.round(parsed / PORTION_STEP) * PORTION_STEP;
  return roundToTwo(clamp(stepped, PORTION_MIN, PORTION_MAX)) || 1;
}

export function scaleMealNutrition(baseValues, portion = 1) {
  const normalizedPortion = clampPortion(portion);
  const baseCalories = normalizeMacroValue(baseValues && baseValues.baseCalories);
  const baseProtein = normalizeMacroValue(baseValues && baseValues.baseProtein);
  const baseCarbs = normalizeMacroValue(baseValues && baseValues.baseCarbs);
  const baseFat = normalizeMacroValue(baseValues && baseValues.baseFat);

  return {
    portion: normalizedPortion,
    baseCalories,
    baseProtein,
    baseCarbs,
    baseFat,
    calories: Math.max(0, Math.round(baseCalories * normalizedPortion)),
    protein: Math.max(0, Math.round(baseProtein * normalizedPortion)),
    carbs: Math.max(0, Math.round(baseCarbs * normalizedPortion)),
    fat: Math.max(0, Math.round(baseFat * normalizedPortion))
  };
}

function sortMealsNewestFirst(source) {
  return source.slice().sort((a, b) => {
    return new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime();
  });
}

export function normalizeMeals(rawMeals, nowIso) {
  if (!Array.isArray(rawMeals)) {
    return { meals: [], changed: rawMeals !== null };
  }

  const normalized = [];
  let changed = false;
  const fallbackIso = nowIso || new Date().toISOString();

  for (let i = 0; i < rawMeals.length; i += 1) {
    const item = rawMeals[i];
    if (!item || typeof item !== "object") {
      changed = true;
      continue;
    }

    const portion = clampPortion(item.portion);
    const baseCalories = deriveBaseValue(item.baseCalories, item.calories, portion);
    const baseProtein = deriveBaseValue(item.baseProtein, item.protein, portion);
    const baseCarbs = deriveBaseValue(item.baseCarbs, item.carbs, portion);
    const baseFat = deriveBaseValue(item.baseFat, item.fat, portion);
    const scaled = scaleMealNutrition({
      baseCalories,
      baseProtein,
      baseCarbs,
      baseFat
    }, portion);

    const normalizedItem = {
      id: (typeof item.id === "string" && item.id.length > 0) ? item.id : createEntryId(),
      name: normalizeName(item.name),
      source: normalizeSource(item.source),
      confidence: normalizeConfidence(item.confidence),
      loggedAt: isValidDate(item.loggedAt || item.timestamp) ? (item.loggedAt || item.timestamp) : fallbackIso,
      ...scaled
    };

    if (
      normalizedItem.id !== item.id
      || normalizedItem.name !== item.name
      || normalizedItem.source !== item.source
      || normalizedItem.confidence !== item.confidence
      || normalizedItem.loggedAt !== (item.loggedAt || item.timestamp)
      || normalizedItem.portion !== item.portion
      || normalizedItem.baseCalories !== item.baseCalories
      || normalizedItem.baseProtein !== item.baseProtein
      || normalizedItem.baseCarbs !== item.baseCarbs
      || normalizedItem.baseFat !== item.baseFat
      || normalizedItem.calories !== item.calories
      || normalizedItem.protein !== item.protein
      || normalizedItem.carbs !== item.carbs
      || normalizedItem.fat !== item.fat
    ) {
      changed = true;
    }

    normalized.push(normalizedItem);
  }

  const sorted = sortMealsNewestFirst(normalized);
  for (let i = 0; i < sorted.length; i += 1) {
    if (!rawMeals[i] || rawMeals[i].id !== sorted[i].id) {
      changed = true;
      break;
    }
  }

  return {
    meals: sorted,
    changed
  };
}

export function getLocalDayKey(value) {
  const date = (value instanceof Date) ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) return "";

  const year = String(date.getFullYear());
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function getMealsForDay(meals, referenceDate = new Date()) {
  const dayKey = getLocalDayKey(referenceDate);
  const source = Array.isArray(meals) ? meals : [];
  const filtered = [];

  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item || typeof item !== "object") continue;
    if (getLocalDayKey(item.loggedAt) !== dayKey) continue;
    filtered.push(item);
  }

  return sortMealsNewestFirst(filtered);
}

export function getRecentFoods(meals, limit = RECENT_FOOD_LIMIT) {
  const source = sortMealsNewestFirst(Array.isArray(meals) ? meals : []);
  const seen = new Set();
  const recent = [];

  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item || typeof item !== "object") continue;

    const key = normalizeName(item.name).toLowerCase();
    if (seen.has(key)) continue;

    seen.add(key);
    recent.push(item);

    if (recent.length >= limit) break;
  }

  return recent;
}

export function getFrequentFoods(meals, limit = FREQUENT_FOOD_LIMIT) {
  const source = sortMealsNewestFirst(Array.isArray(meals) ? meals : []);
  const entriesByKey = new Map();

  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item || typeof item !== "object") continue;

    const key = normalizeName(item.name).toLowerCase();
    if (!entriesByKey.has(key)) {
      entriesByKey.set(key, {
        count: 1,
        latestTs: new Date(item.loggedAt).getTime() || 0,
        item
      });
      continue;
    }

    entriesByKey.get(key).count += 1;
  }

  return Array.from(entriesByKey.values())
    .sort((a, b) => {
      if (b.count !== a.count) return b.count - a.count;
      return b.latestTs - a.latestTs;
    })
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.item);
}

export function getMealLoggingStreak(meals, referenceDate = new Date()) {
  const source = Array.isArray(meals) ? meals : [];
  const loggedDays = new Set();

  for (let i = 0; i < source.length; i += 1) {
    const key = getLocalDayKey(source[i] && source[i].loggedAt);
    if (key) loggedDays.add(key);
  }

  if (loggedDays.size === 0) return 0;

  let streak = 0;
  const cursor = new Date(referenceDate);
  cursor.setHours(0, 0, 0, 0);

  while (loggedDays.has(getLocalDayKey(cursor))) {
    streak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return streak;
}

function hasMealAfterHour(meals, hourThreshold) {
  const source = Array.isArray(meals) ? meals : [];
  for (let i = 0; i < source.length; i += 1) {
    const mealDate = new Date(source[i].loggedAt);
    if (!Number.isFinite(mealDate.getTime())) continue;
    if (mealDate.getHours() >= hourThreshold) return true;
  }
  return false;
}

export function getSmartReminder(meals, referenceDate = new Date()) {
  const todaysMeals = getMealsForDay(meals, referenceDate);
  const hour = referenceDate.getHours();

  if (hour >= 6 && hour < 10 && todaysMeals.length === 0) {
    return {
      slot: "breakfast",
      title: "Log breakfast?",
      note: "A quick photo keeps the streak going."
    };
  }

  if (hour >= 12 && hour < 16 && !hasMealAfterHour(todaysMeals, 11)) {
    return {
      slot: "lunch",
      title: "Log lunch?",
      note: "One estimate keeps today accurate."
    };
  }

  if (hour >= 18 && hour < 22 && !hasMealAfterHour(todaysMeals, 17)) {
    return {
      slot: "dinner",
      title: "Log dinner?",
      note: "You only need one quick check-in."
    };
  }

  return null;
}

export function getStreakLabel(streakCount) {
  const normalized = Math.max(0, Math.round(streakCount || 0));
  if (normalized === 1) return "1 day streak";
  return `${normalized} day streak`;
}

export function getCalorieFeedback({ consumedCalories, goalCalories, mealCount }) {
  if (!mealCount) return "Start with your first meal";
  if (!goalCalories || goalCalories <= 0) return "You're on track";

  const ratio = consumedCalories / goalCalories;
  if (ratio >= 1.02) return "You're over today";
  if (ratio >= 0.85) return "You're close to your limit";
  return "You're on track";
}

export function buildCalorieTrackerSummary(state, referenceDate = new Date()) {
  const allMeals = sortMealsNewestFirst(state && Array.isArray(state.meals) ? state.meals : []);
  const todaysMeals = getMealsForDay(allMeals, referenceDate);

  let consumedCalories = 0;
  let protein = 0;
  let carbs = 0;
  let fat = 0;

  for (let i = 0; i < todaysMeals.length; i += 1) {
    consumedCalories += normalizeMacroValue(todaysMeals[i].calories);
    protein += normalizeMacroValue(todaysMeals[i].protein);
    carbs += normalizeMacroValue(todaysMeals[i].carbs);
    fat += normalizeMacroValue(todaysMeals[i].fat);
  }

  const goalSummary = resolveCalorieGoalFromState(state);
  const goalCalories = goalSummary.goalCalories;

  const remainingCalories = goalCalories - consumedCalories;
  const progressRatio = goalCalories > 0 ? (consumedCalories / goalCalories) : 0;
  const overCalories = Math.max(0, consumedCalories - goalCalories);
  const isOver = remainingCalories < 0;

  return {
    maintenanceCalories: goalSummary.maintenanceCalories,
    goalCalories,
    goalSource: goalSummary.goalSource,
    goalObjective: goalSummary.goalObjective,
    goalPresetKey: goalSummary.goalPresetKey,
    goalLabel: goalSummary.goalLabel,
    goalDelta: goalSummary.goalDelta,
    consumedCalories,
    remainingCalories,
    overCalories,
    protein,
    carbs,
    fat,
    mealCount: todaysMeals.length,
    progressRatio,
    progressRatioCapped: clamp(progressRatio, 0, 1),
    overflowProgressRatioCapped: clamp(Math.max(0, progressRatio - 1), 0, 1),
    feedback: getCalorieFeedback({
      consumedCalories,
      goalCalories,
      mealCount: todaysMeals.length
    }),
    streakCount: getMealLoggingStreak(allMeals, referenceDate),
    todaysMeals,
    meals: allMeals,
    recentFoods: getRecentFoods(allMeals),
    frequentFoods: getFrequentFoods(allMeals),
    reminder: getSmartReminder(allMeals, referenceDate),
    isOver
  };
}
