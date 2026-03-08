import { getChartReadyWeights, normalizeWeights } from "./data-utils.mjs";
import {
  ACTIVITY_MULTIPLIERS,
  CALORIE_GENDERS,
  cmToFeetInches,
  feetInchesToCm,
  hasCalorieProfileBasics,
  weightToKg
} from "./calories-utils.mjs";

const KEYS = {
  USER: "maxmode_user",
  WEIGHTS: "maxmode_weights"
};

const DEFAULT_PREFERENCES = Object.freeze({
  heightUnit: "cm",
  weightUnit: "kg"
});

let cachedState = null;

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function parseFiniteNumber(value) {
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseWholeNumber(value) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed);
}

function parsePositiveNumber(value) {
  const parsed = parseFiniteNumber(value);
  if (parsed === null || parsed <= 0) return null;
  return parsed;
}

function parseNonNegativeWholeNumber(value) {
  const parsed = parseWholeNumber(value);
  if (parsed === null || parsed < 0) return null;
  return parsed;
}

function roundToTwo(value) {
  if (!Number.isFinite(value)) return null;
  return Math.round(value * 100) / 100;
}

function normalizeHeight(rawHeight) {
  const source = (rawHeight && typeof rawHeight === "object") ? rawHeight : {};

  const unit = (source.unit === "ft-in") ? "ft-in" : "cm";
  const cmCandidate = roundToTwo(parsePositiveNumber(source.cm));
  const ft = parseNonNegativeWholeNumber(source.ft);
  const rawInches = parseNonNegativeWholeNumber(source.in);
  const inches = (rawInches !== null && rawInches < 12) ? rawInches : null;

  const legacyHeightCm = roundToTwo(parsePositiveNumber(source.heightCm));
  const fromImperial = (ft !== null && inches !== null)
    ? feetInchesToCm(ft, inches)
    : null;

  const canonicalHeightCmRaw = legacyHeightCm || cmCandidate || fromImperial;
  const canonicalHeightCm = canonicalHeightCmRaw ? roundToTwo(canonicalHeightCmRaw) : null;

  let normalizedFt = ft;
  let normalizedInches = inches;

  if ((normalizedFt === null || normalizedInches === null) && canonicalHeightCm) {
    const converted = cmToFeetInches(canonicalHeightCm);
    normalizedFt = converted.ft;
    normalizedInches = converted.in;
  }

  return {
    unit,
    cm: canonicalHeightCm,
    ft: normalizedFt,
    in: normalizedInches,
    heightCm: canonicalHeightCm
  };
}

function normalizeCalorieProfile(rawProfile) {
  const source = (rawProfile && typeof rawProfile === "object") ? rawProfile : {};

  const ageCandidate = parseWholeNumber(source.age);
  const age = (ageCandidate !== null && ageCandidate >= 1 && ageCandidate <= 120) ? ageCandidate : null;

  const gender = CALORIE_GENDERS.includes(source.gender) ? source.gender : null;
  const activityLevel = Object.prototype.hasOwnProperty.call(ACTIVITY_MULTIPLIERS, source.activityLevel)
    ? source.activityLevel
    : null;

  return {
    age,
    gender,
    activityLevel,
    height: normalizeHeight(source.height)
  };
}

function normalizePreferences(rawPreferences) {
  const source = (rawPreferences && typeof rawPreferences === "object") ? rawPreferences : {};

  return {
    heightUnit: source.heightUnit === "ft-in" ? "ft-in" : DEFAULT_PREFERENCES.heightUnit,
    weightUnit: source.weightUnit === "lb" ? "lb" : DEFAULT_PREFERENCES.weightUnit
  };
}

function normalizeUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return null;

  const name = (typeof rawUser.name === "string") ? rawUser.name.trim() : "";
  if (!name) return null;

  const createdAt = (typeof rawUser.createdAt === "string" && rawUser.createdAt)
    ? rawUser.createdAt
    : new Date().toISOString();

  return {
    name,
    createdAt,
    calorieProfile: normalizeCalorieProfile(rawUser.calorieProfile),
    preferences: normalizePreferences(rawUser.preferences)
  };
}

function writeUser(user) {
  if (!user) {
    localStorage.removeItem(KEYS.USER);
    return;
  }
  localStorage.setItem(KEYS.USER, JSON.stringify(user));
}

function writeWeights(weights) {
  localStorage.setItem(KEYS.WEIGHTS, JSON.stringify(weights));
}

function readFromStorage() {
  const rawUser = parseJson(localStorage.getItem(KEYS.USER));
  const rawWeights = parseJson(localStorage.getItem(KEYS.WEIGHTS));

  const user = normalizeUser(rawUser);
  const { weights, changed } = normalizeWeights(rawWeights, new Date().toISOString());

  if (changed) writeWeights(weights);

  if (rawUser) {
    if (!user) {
      writeUser(null);
    } else if (JSON.stringify(rawUser) !== JSON.stringify(user)) {
      writeUser(user);
    }
  }

  return {
    user,
    weights,
    chartSeries: getChartReadyWeights(weights)
  };
}

function normalizeWeightInput(value, unit) {
  const normalizedUnit = (unit === "lb") ? "lb" : "kg";
  return roundToTwo(weightToKg(value, normalizedUnit));
}

function createEntryId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function mergeCalorieProfile(currentProfile, patch) {
  const normalizedCurrent = normalizeCalorieProfile(currentProfile);
  const sourcePatch = (patch && typeof patch === "object") ? patch : {};

  return normalizeCalorieProfile({
    ...normalizedCurrent,
    ...sourcePatch,
    height: {
      ...normalizedCurrent.height,
      ...((sourcePatch.height && typeof sourcePatch.height === "object") ? sourcePatch.height : {})
    }
  });
}

function mergePreferences(currentPreferences, patch) {
  const sourcePatch = (patch && typeof patch === "object") ? patch : {};
  return normalizePreferences({
    ...normalizePreferences(currentPreferences),
    ...sourcePatch
  });
}

function replaceWeights(nextWeights) {
  writeWeights(nextWeights);
  invalidateState();
  return loadState();
}

export function invalidateState() {
  cachedState = null;
}

export function loadState() {
  if (!cachedState) {
    cachedState = readFromStorage();
  }
  return cachedState;
}

export function setUser(user) {
  writeUser(normalizeUser(user));
  invalidateState();
  return loadState();
}

export function setUserName(name) {
  const trimmed = (typeof name === "string") ? name.trim() : "";
  if (!trimmed) return loadState();

  const current = loadState();
  const createdAt = current.user && current.user.createdAt ? current.user.createdAt : new Date().toISOString();
  const calorieProfile = current.user && current.user.calorieProfile
    ? current.user.calorieProfile
    : normalizeCalorieProfile(null);
  const preferences = current.user && current.user.preferences
    ? current.user.preferences
    : normalizePreferences(null);

  return setUser({
    name: trimmed,
    createdAt,
    calorieProfile,
    preferences
  });
}

export function getCalorieProfile(state) {
  const source = state || loadState();
  if (!source.user) return normalizeCalorieProfile(null);
  return normalizeCalorieProfile(source.user.calorieProfile);
}

export function setCalorieProfile(profilePatch) {
  const current = loadState();
  if (!current.user) return current;

  const calorieProfile = mergeCalorieProfile(current.user.calorieProfile, profilePatch);

  return setUser({
    ...current.user,
    calorieProfile
  });
}

export function getUserPreferences(state) {
  const source = state || loadState();
  if (!source.user) return normalizePreferences(null);
  return normalizePreferences(source.user.preferences);
}

export function setUserPreferences(preferencesPatch) {
  const current = loadState();
  if (!current.user) return current;

  const preferences = mergePreferences(current.user.preferences, preferencesPatch);
  return setUser({
    ...current.user,
    preferences
  });
}

export function isCalorieProfileComplete(state) {
  const source = state || loadState();
  const profile = source && source.user ? source.user.calorieProfile : null;
  return hasCalorieProfileBasics(profile);
}

export function isCalorieDataComplete(state) {
  const source = state || loadState();
  if (!isCalorieProfileComplete(source)) return false;
  return !!(source && Array.isArray(source.chartSeries) && source.chartSeries.length > 0);
}

export function addWeight(value, unit = "kg") {
  const state = loadState();
  const normalizedKg = normalizeWeightInput(value, unit);
  if (!normalizedKg) return state;

  const entry = {
    id: createEntryId(),
    weight: normalizedKg,
    unit: "kg",
    timestamp: new Date().toISOString()
  };

  return replaceWeights([entry].concat(state.weights));
}

export function updateWeight(id, value, unit = "kg") {
  if (!id) return false;

  const normalizedKg = normalizeWeightInput(value, unit);
  if (!normalizedKg) return false;

  const state = loadState();
  let updated = false;

  const next = state.weights.map((entry) => {
    if (entry.id !== id) return entry;
    updated = true;
    return {
      id: entry.id,
      weight: normalizedKg,
      unit: "kg",
      timestamp: entry.timestamp
    };
  });

  if (!updated) return false;
  replaceWeights(next);
  return true;
}

export function deleteWeight(id) {
  if (!id) return false;

  const state = loadState();
  const next = state.weights.filter((entry) => entry.id !== id);
  if (next.length === state.weights.length) return false;

  replaceWeights(next);
  return true;
}

export function getWeightById(id) {
  if (!id) return null;
  const state = loadState();
  for (let i = 0; i < state.weights.length; i += 1) {
    if (state.weights[i].id === id) return state.weights[i];
  }
  return null;
}

export function clearAllData() {
  localStorage.removeItem(KEYS.USER);
  localStorage.removeItem(KEYS.WEIGHTS);
  invalidateState();
}

export function avatarUrl(name) {
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(name)}&size=96`;
}
