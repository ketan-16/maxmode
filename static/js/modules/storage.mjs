import { getChartReadyWeights, normalizeWeights } from "./data-utils.mjs";

const KEYS = {
  USER: "maxmode_user",
  WEIGHTS: "maxmode_weights"
};

let cachedState = null;

function parseJson(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return null;

  const name = (typeof rawUser.name === "string") ? rawUser.name.trim() : "";
  if (!name) return null;

  const createdAt = (typeof rawUser.createdAt === "string" && rawUser.createdAt)
    ? rawUser.createdAt
    : new Date().toISOString();

  return { name, createdAt };
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
  if (!user && rawUser) writeUser(null);

  return {
    user,
    weights,
    chartSeries: getChartReadyWeights(weights)
  };
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

function replaceWeights(nextWeights) {
  writeWeights(nextWeights);
  invalidateState();
  return loadState();
}

export function setUser(user) {
  writeUser(user);
  invalidateState();
  return loadState();
}

export function setUserName(name) {
  const trimmed = (typeof name === "string") ? name.trim() : "";
  if (!trimmed) return loadState();

  const current = loadState();
  const createdAt = current.user && current.user.createdAt ? current.user.createdAt : new Date().toISOString();
  return setUser({ name: trimmed, createdAt });
}

function createEntryId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function addWeight(value) {
  const state = loadState();
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return state;

  const entry = {
    id: createEntryId(),
    weight: parsed,
    unit: "kg",
    timestamp: new Date().toISOString()
  };

  return replaceWeights([entry].concat(state.weights));
}

export function updateWeight(id, value) {
  if (!id) return false;

  const parsed = (typeof value === "number") ? value : parseFloat(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;

  const state = loadState();
  let updated = false;

  const next = state.weights.map((entry) => {
    if (entry.id !== id) return entry;
    updated = true;
    return {
      id: entry.id,
      weight: parsed,
      unit: entry.unit,
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
  return `https://api.dicebear.com/9.x/notionists/svg?seed=${encodeURIComponent(name)}`;
}
