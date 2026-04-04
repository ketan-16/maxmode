import { getChartReadyWeights, normalizeWeights } from "./data-utils.mjs";
import {
  ACTIVITY_MULTIPLIERS,
  CALORIE_GOAL_OBJECTIVES,
  CALORIE_GENDERS,
  cmToFeetInches,
  feetInchesToCm,
  getMacroGoalDefaults,
  getCalorieGoalPreset,
  hasCalorieProfileBasics,
  normalizeMacroGoalObjective,
  normalizeProteinMultiplierGPerKg,
  weightToKg
} from "./calories-utils.mjs";
import { normalizeMeals } from "./meal-utils.mjs";

const LEGACY_KEYS = {
  USER: "maxmode_user",
  WEIGHTS: "maxmode_weights",
  MEALS: "maxmode_meals",
  CALORIE_TRACKER_META: "maxmode_calorie_tracker_meta"
};

const STORES = {
  PROFILE: "profile",
  WEIGHTS: "weights",
  MEALS: "meals",
  PENDING_MUTATIONS: "pending_mutations",
  SYNC_STATE: "sync_state",
  AUTH_STATE: "auth_state",
  LEGACY_MIGRATION: "legacy_migration"
};

const FALLBACK_KEYS = {
  PROFILE: "maxmode_store_profile",
  WEIGHTS: "maxmode_store_weights",
  MEALS: "maxmode_store_meals",
  PENDING_MUTATIONS: "maxmode_store_pending_mutations",
  SYNC_STATE: "maxmode_store_sync_state",
  AUTH_STATE: "maxmode_store_auth_state",
  LEGACY_MIGRATION: "maxmode_store_legacy_migration"
};

const SINGLETON_KEY = "main";
const DB_NAME = "maxmode-app";
const DB_VERSION = 1;
const SYNC_DEBOUNCE_MS = 320;

const DEFAULT_PREFERENCES = Object.freeze({
  heightUnit: "cm",
  weightUnit: "kg",
  proteinMultiplierGPerKg: getMacroGoalDefaults("maintain").proteinMultiplierGPerKg,
  aiCalculationMode: "balanced"
});

const DEFAULT_CALORIE_TRACKER_META = Object.freeze({
  reminderOptIn: false,
  lastReminderDay: ""
});

const DEFAULT_AUTH_STATE = Object.freeze({
  status: "guest",
  email: "",
  hasServerData: false,
  checkedAt: "",
  lastError: ""
});

const DEFAULT_SYNC_STATE = Object.freeze({
  deviceId: "",
  lastPulledVersion: 0,
  syncStatus: "idle",
  lastSyncAt: "",
  lastError: ""
});

let adapter = null;
let memoryState = createDefaultMemoryState();
let cachedState = buildPublicState(memoryState);
let initPromise = null;
let initialized = false;
let syncBootstrapLoaded = false;
let writeChain = Promise.resolve();
let syncTimer = null;
let syncPromise = null;
let stateChangeEventName = "maxmode:state-changed";

function createDefaultMemoryState() {
  return {
    user: null,
    weights: [],
    meals: [],
    calorieTrackerMeta: { ...DEFAULT_CALORIE_TRACKER_META },
    auth: { ...DEFAULT_AUTH_STATE },
    syncState: { ...DEFAULT_SYNC_STATE },
    pendingMutations: []
  };
}

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

function normalizePreferences(rawPreferences, goalObjective = null) {
  const source = (rawPreferences && typeof rawPreferences === "object") ? rawPreferences : {};
  const normalizedObjective = normalizeMacroGoalObjective(goalObjective);

  return {
    heightUnit: source.heightUnit === "ft-in" ? "ft-in" : DEFAULT_PREFERENCES.heightUnit,
    weightUnit: source.weightUnit === "lb" ? "lb" : DEFAULT_PREFERENCES.weightUnit,
    proteinMultiplierGPerKg: normalizeProteinMultiplierGPerKg(source.proteinMultiplierGPerKg, normalizedObjective),
    aiCalculationMode: source.aiCalculationMode === "aggressive"
      ? "aggressive"
      : DEFAULT_PREFERENCES.aiCalculationMode
  };
}

function normalizeCalorieTrackerMeta(rawMeta) {
  const source = (rawMeta && typeof rawMeta === "object") ? rawMeta : {};
  const lastReminderDay = (typeof source.lastReminderDay === "string" && /^\d{4}-\d{2}-\d{2}$/.test(source.lastReminderDay))
    ? source.lastReminderDay
    : DEFAULT_CALORIE_TRACKER_META.lastReminderDay;

  return {
    reminderOptIn: source.reminderOptIn === true,
    lastReminderDay
  };
}

function normalizeCalorieGoal(rawGoal) {
  const source = (rawGoal && typeof rawGoal === "object") ? rawGoal : {};
  const preset = getCalorieGoalPreset(source.presetKey);
  const normalizedObjective = CALORIE_GOAL_OBJECTIVES.includes(source.objective)
    ? source.objective
    : null;

  if (preset) {
    return {
      objective: preset.objective,
      presetKey: preset.key
    };
  }

  return {
    objective: normalizedObjective,
    presetKey: null
  };
}

function normalizeUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") return null;

  const name = (typeof rawUser.name === "string") ? rawUser.name.trim() : "";
  if (!name) return null;

  const createdAt = (typeof rawUser.createdAt === "string" && rawUser.createdAt)
    ? rawUser.createdAt
    : new Date().toISOString();
  const calorieGoal = normalizeCalorieGoal(rawUser.calorieGoal);
  const preferences = normalizePreferences(rawUser.preferences, calorieGoal.objective);

  return {
    name,
    createdAt,
    calorieProfile: normalizeCalorieProfile(rawUser.calorieProfile),
    calorieGoal,
    preferences
  };
}

function normalizeAuthState(rawAuth) {
  const source = (rawAuth && typeof rawAuth === "object") ? rawAuth : {};
  const status = source.status === "authenticated" ? "authenticated" : "guest";
  return {
    status,
    email: (typeof source.email === "string") ? source.email.trim() : "",
    hasServerData: source.hasServerData === true,
    checkedAt: (typeof source.checkedAt === "string") ? source.checkedAt : "",
    lastError: (typeof source.lastError === "string") ? source.lastError : ""
  };
}

function normalizeSyncState(rawSyncState) {
  const source = (rawSyncState && typeof rawSyncState === "object") ? rawSyncState : {};
  const lastPulledVersion = parseWholeNumber(source.lastPulledVersion);
  const syncStatus = (source.syncStatus === "syncing" || source.syncStatus === "paused" || source.syncStatus === "error")
    ? source.syncStatus
    : "idle";
  return {
    deviceId: (typeof source.deviceId === "string") ? source.deviceId : "",
    lastPulledVersion: (lastPulledVersion !== null && lastPulledVersion >= 0) ? lastPulledVersion : 0,
    syncStatus,
    lastSyncAt: (typeof source.lastSyncAt === "string") ? source.lastSyncAt : "",
    lastError: (typeof source.lastError === "string") ? source.lastError : ""
  };
}

function normalizePendingMutation(rawMutation) {
  const source = (rawMutation && typeof rawMutation === "object") ? rawMutation : {};
  const mutationId = (typeof source.mutationId === "string" && source.mutationId) ? source.mutationId : null;
  const type = (typeof source.type === "string" && source.type) ? source.type : null;
  if (!mutationId || !type) return null;
  return {
    mutationId,
    type,
    entityId: (typeof source.entityId === "string" && source.entityId) ? source.entityId : null,
    payload: (source.payload && typeof source.payload === "object") ? source.payload : {},
    enqueuedAt: (typeof source.enqueuedAt === "string" && source.enqueuedAt) ? source.enqueuedAt : new Date().toISOString()
  };
}

function normalizePendingMutations(source) {
  if (!Array.isArray(source)) return [];
  const normalized = [];
  for (let i = 0; i < source.length; i += 1) {
    const mutation = normalizePendingMutation(source[i]);
    if (mutation) normalized.push(mutation);
  }
  return normalized;
}

function normalizeWeightInput(value, unit) {
  const normalizedUnit = (unit === "lb") ? "lb" : "kg";
  return roundToTwo(weightToKg(value, normalizedUnit));
}

function createEntryId() {
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function buildPublicState(source) {
  const weights = Array.isArray(source.weights) ? source.weights.slice() : [];
  const meals = Array.isArray(source.meals) ? source.meals.slice() : [];
  const auth = normalizeAuthState(source.auth);
  const syncState = normalizeSyncState(source.syncState);
  return {
    user: source.user ? normalizeUser(source.user) : null,
    weights,
    chartSeries: getChartReadyWeights(weights),
    meals,
    calorieTrackerMeta: normalizeCalorieTrackerMeta(source.calorieTrackerMeta),
    auth: {
      ...auth,
      deviceId: syncState.deviceId,
      pendingMutationCount: Array.isArray(source.pendingMutations) ? source.pendingMutations.length : 0,
      syncStatus: syncState.syncStatus,
      lastSyncAt: syncState.lastSyncAt,
      lastSyncError: syncState.lastError
    }
  };
}

function emitStateChange() {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent(stateChangeEventName));
  } catch {
    window.dispatchEvent(new Event(stateChangeEventName));
  }
}

function setMemoryState(nextState, { emit = true } = {}) {
  memoryState = {
    user: nextState.user ? normalizeUser(nextState.user) : null,
    weights: Array.isArray(nextState.weights) ? nextState.weights.slice() : [],
    meals: Array.isArray(nextState.meals) ? nextState.meals.slice() : [],
    calorieTrackerMeta: normalizeCalorieTrackerMeta(nextState.calorieTrackerMeta),
    auth: normalizeAuthState(nextState.auth),
    syncState: normalizeSyncState(nextState.syncState),
    pendingMutations: normalizePendingMutations(nextState.pendingMutations)
  };
  cachedState = buildPublicState(memoryState);
  if (emit) emitStateChange();
}

function ensureSynchronousBootstrap() {
  if (initialized || syncBootstrapLoaded) return;
  const legacy = readLegacySnapshot();
  setMemoryState(legacy, { emit: false });
  syncBootstrapLoaded = true;
}

function readLegacySnapshot() {
  if (typeof localStorage === "undefined") {
    return {
      user: null,
      weights: [],
      meals: [],
      calorieTrackerMeta: normalizeCalorieTrackerMeta(null),
      auth: DEFAULT_AUTH_STATE,
      syncState: DEFAULT_SYNC_STATE,
      pendingMutations: []
    };
  }
  const rawUser = (typeof localStorage !== "undefined") ? parseJson(localStorage.getItem(LEGACY_KEYS.USER)) : null;
  const rawWeights = (typeof localStorage !== "undefined") ? parseJson(localStorage.getItem(LEGACY_KEYS.WEIGHTS)) : null;
  const rawMeals = (typeof localStorage !== "undefined") ? parseJson(localStorage.getItem(LEGACY_KEYS.MEALS)) : null;
  const rawCalorieTrackerMeta = (typeof localStorage !== "undefined") ? parseJson(localStorage.getItem(LEGACY_KEYS.CALORIE_TRACKER_META)) : null;
  const nowIso = new Date().toISOString();
  const normalizedUser = normalizeUser(rawUser);
  const normalizedWeights = normalizeWeights(rawWeights, nowIso).weights;
  const normalizedMeals = normalizeMeals(rawMeals, nowIso).meals;
  const normalizedMeta = normalizeCalorieTrackerMeta(rawCalorieTrackerMeta);

  if (!normalizedUser) {
    localStorage.removeItem(LEGACY_KEYS.USER);
  } else {
    localStorage.setItem(LEGACY_KEYS.USER, JSON.stringify(normalizedUser));
  }
  localStorage.setItem(LEGACY_KEYS.WEIGHTS, JSON.stringify(normalizedWeights));
  localStorage.setItem(LEGACY_KEYS.MEALS, JSON.stringify(normalizedMeals));
  localStorage.setItem(LEGACY_KEYS.CALORIE_TRACKER_META, JSON.stringify(normalizedMeta));

  return {
    user: normalizedUser,
    weights: normalizedWeights,
    meals: normalizedMeals,
    calorieTrackerMeta: normalizedMeta,
    auth: DEFAULT_AUTH_STATE,
    syncState: DEFAULT_SYNC_STATE,
    pendingMutations: []
  };
}

function hasMeaningfulLocalData(state = memoryState) {
  const source = state || memoryState;
  return !!(
    source.user
    || (Array.isArray(source.weights) && source.weights.length > 0)
    || (Array.isArray(source.meals) && source.meals.length > 0)
    || (source.calorieTrackerMeta && (source.calorieTrackerMeta.reminderOptIn || source.calorieTrackerMeta.lastReminderDay))
  );
}

function snapshotProfileRecord(state = memoryState) {
  return {
    key: SINGLETON_KEY,
    user: state.user ? normalizeUser(state.user) : null,
    calorieTrackerMeta: normalizeCalorieTrackerMeta(state.calorieTrackerMeta)
  };
}

function normalizeSnapshot(rawSnapshot) {
  const source = (rawSnapshot && typeof rawSnapshot === "object") ? rawSnapshot : {};
  const profileRecord = (source.profile && typeof source.profile === "object") ? source.profile : null;
  const rawUser = profileRecord && profileRecord.user ? profileRecord.user : source.user;
  const rawMeta = profileRecord && profileRecord.calorieTrackerMeta ? profileRecord.calorieTrackerMeta : source.calorieTrackerMeta;
  const nowIso = new Date().toISOString();
  const normalizedWeights = normalizeWeights(Array.isArray(source.weights) ? source.weights : [], nowIso).weights;
  const normalizedMeals = normalizeMeals(Array.isArray(source.meals) ? source.meals : [], nowIso).meals;
  return {
    user: normalizeUser(rawUser),
    weights: normalizedWeights,
    meals: normalizedMeals,
    calorieTrackerMeta: normalizeCalorieTrackerMeta(rawMeta),
    auth: normalizeAuthState(source.authState || source.auth),
    syncState: normalizeSyncState(source.syncState),
    pendingMutations: normalizePendingMutations(source.pendingMutations)
  };
}

function getAdapter() {
  if (adapter) return adapter;
  adapter = (typeof indexedDB !== "undefined")
    ? createIndexedDbAdapter()
    : createFallbackAdapter();
  return adapter;
}

function createIndexedDbAdapter() {
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORES.PROFILE)) {
          db.createObjectStore(STORES.PROFILE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.WEIGHTS)) {
          db.createObjectStore(STORES.WEIGHTS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.MEALS)) {
          db.createObjectStore(STORES.MEALS, { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains(STORES.PENDING_MUTATIONS)) {
          db.createObjectStore(STORES.PENDING_MUTATIONS, { keyPath: "mutationId" });
        }
        if (!db.objectStoreNames.contains(STORES.SYNC_STATE)) {
          db.createObjectStore(STORES.SYNC_STATE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.AUTH_STATE)) {
          db.createObjectStore(STORES.AUTH_STATE, { keyPath: "key" });
        }
        if (!db.objectStoreNames.contains(STORES.LEGACY_MIGRATION)) {
          db.createObjectStore(STORES.LEGACY_MIGRATION, { keyPath: "key" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Unable to open IndexedDB."));
    });
    return dbPromise;
  }

  function txDone(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onabort = () => reject(tx.error || new Error("IndexedDB transaction aborted."));
      tx.onerror = () => reject(tx.error || new Error("IndexedDB transaction failed."));
    });
  }

  function requestValue(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("IndexedDB request failed."));
    });
  }

  async function readSnapshot() {
    const db = await openDb();
    const tx = db.transaction(Object.values(STORES), "readonly");
    const profileRequest = tx.objectStore(STORES.PROFILE).get(SINGLETON_KEY);
    const weightsRequest = tx.objectStore(STORES.WEIGHTS).getAll();
    const mealsRequest = tx.objectStore(STORES.MEALS).getAll();
    const pendingRequest = tx.objectStore(STORES.PENDING_MUTATIONS).getAll();
    const syncStateRequest = tx.objectStore(STORES.SYNC_STATE).get(SINGLETON_KEY);
    const authStateRequest = tx.objectStore(STORES.AUTH_STATE).get(SINGLETON_KEY);
    const legacyMigrationRequest = tx.objectStore(STORES.LEGACY_MIGRATION).get(SINGLETON_KEY);
    const [
      profile,
      weights,
      meals,
      pendingMutations,
      syncState,
      authState,
      legacyMigration
    ] = await Promise.all([
      requestValue(profileRequest),
      requestValue(weightsRequest),
      requestValue(mealsRequest),
      requestValue(pendingRequest),
      requestValue(syncStateRequest),
      requestValue(authStateRequest),
      requestValue(legacyMigrationRequest)
    ]);
    await txDone(tx);
    return {
      profile,
      weights,
      meals,
      pendingMutations,
      syncState,
      authState,
      legacyMigration
    };
  }

  async function putSingleton(storeName, payload) {
    const db = await openDb();
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).put({ key: SINGLETON_KEY, ...payload });
    await txDone(tx);
  }

  async function clearStore(storeName) {
    const db = await openDb();
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).clear();
    await txDone(tx);
  }

  async function replaceRecords(storeName, records, keyField = "id") {
    const db = await openDb();
    const tx = db.transaction([storeName], "readwrite");
    const store = tx.objectStore(storeName);
    store.clear();
    for (let i = 0; i < records.length; i += 1) {
      const record = records[i];
      if (!record || !record[keyField]) continue;
      store.put(record);
    }
    await txDone(tx);
  }

  async function putRecord(storeName, record) {
    if (!record) return;
    const db = await openDb();
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).put(record);
    await txDone(tx);
  }

  async function deleteRecord(storeName, key) {
    const db = await openDb();
    const tx = db.transaction([storeName], "readwrite");
    tx.objectStore(storeName).delete(key);
    await txDone(tx);
  }

  return {
    readSnapshot,
    async setProfile(profileRecord) {
      if (!profileRecord) {
        await clearStore(STORES.PROFILE);
        return;
      }
      await putSingleton(STORES.PROFILE, {
        user: profileRecord.user || null,
        calorieTrackerMeta: profileRecord.calorieTrackerMeta || { ...DEFAULT_CALORIE_TRACKER_META }
      });
    },
    setWeights(weights) {
      return replaceRecords(STORES.WEIGHTS, Array.isArray(weights) ? weights : []);
    },
    putWeight(weight) {
      return putRecord(STORES.WEIGHTS, weight);
    },
    deleteWeight(id) {
      return deleteRecord(STORES.WEIGHTS, id);
    },
    setMeals(meals) {
      return replaceRecords(STORES.MEALS, Array.isArray(meals) ? meals : []);
    },
    putMeal(meal) {
      return putRecord(STORES.MEALS, meal);
    },
    deleteMeal(id) {
      return deleteRecord(STORES.MEALS, id);
    },
    setPendingMutations(mutations) {
      return replaceRecords(STORES.PENDING_MUTATIONS, Array.isArray(mutations) ? mutations : [], "mutationId");
    },
    putPendingMutation(mutation) {
      return putRecord(STORES.PENDING_MUTATIONS, mutation);
    },
    deletePendingMutation(id) {
      return deleteRecord(STORES.PENDING_MUTATIONS, id);
    },
    setSyncState(syncState) {
      return putSingleton(STORES.SYNC_STATE, syncState);
    },
    setAuthState(authState) {
      return putSingleton(STORES.AUTH_STATE, authState);
    },
    setLegacyMigration(record) {
      return putSingleton(STORES.LEGACY_MIGRATION, record);
    },
    async clearDomainData() {
      await Promise.all([
        clearStore(STORES.PROFILE),
        clearStore(STORES.WEIGHTS),
        clearStore(STORES.MEALS),
        clearStore(STORES.PENDING_MUTATIONS),
        clearStore(STORES.SYNC_STATE)
      ]);
    }
  };
}

function createFallbackAdapter() {
  const local = (typeof localStorage !== "undefined") ? localStorage : null;
  const memory = new Map();

  function getRaw(key) {
    if (local) return local.getItem(key);
    return memory.has(key) ? memory.get(key) : null;
  }

  function setRaw(key, value) {
    if (local) {
      local.setItem(key, value);
      return;
    }
    memory.set(key, value);
  }

  function removeRaw(key) {
    if (local) {
      local.removeItem(key);
      return;
    }
    memory.delete(key);
  }

  return {
    async readSnapshot() {
      return {
        profile: parseJson(getRaw(FALLBACK_KEYS.PROFILE)),
        weights: parseJson(getRaw(FALLBACK_KEYS.WEIGHTS)) || [],
        meals: parseJson(getRaw(FALLBACK_KEYS.MEALS)) || [],
        pendingMutations: parseJson(getRaw(FALLBACK_KEYS.PENDING_MUTATIONS)) || [],
        syncState: parseJson(getRaw(FALLBACK_KEYS.SYNC_STATE)),
        authState: parseJson(getRaw(FALLBACK_KEYS.AUTH_STATE)),
        legacyMigration: parseJson(getRaw(FALLBACK_KEYS.LEGACY_MIGRATION))
      };
    },
    async setProfile(profileRecord) {
      if (!profileRecord) {
        removeRaw(FALLBACK_KEYS.PROFILE);
        return;
      }
      setRaw(FALLBACK_KEYS.PROFILE, JSON.stringify(profileRecord));
    },
    async setWeights(weights) {
      setRaw(FALLBACK_KEYS.WEIGHTS, JSON.stringify(weights || []));
    },
    async putWeight(weight) {
      const current = parseJson(getRaw(FALLBACK_KEYS.WEIGHTS)) || [];
      const next = current.filter((entry) => entry.id !== weight.id);
      next.push(weight);
      setRaw(FALLBACK_KEYS.WEIGHTS, JSON.stringify(next));
    },
    async deleteWeight(id) {
      const current = parseJson(getRaw(FALLBACK_KEYS.WEIGHTS)) || [];
      setRaw(FALLBACK_KEYS.WEIGHTS, JSON.stringify(current.filter((entry) => entry.id !== id)));
    },
    async setMeals(meals) {
      setRaw(FALLBACK_KEYS.MEALS, JSON.stringify(meals || []));
    },
    async putMeal(meal) {
      const current = parseJson(getRaw(FALLBACK_KEYS.MEALS)) || [];
      const next = current.filter((entry) => entry.id !== meal.id);
      next.push(meal);
      setRaw(FALLBACK_KEYS.MEALS, JSON.stringify(next));
    },
    async deleteMeal(id) {
      const current = parseJson(getRaw(FALLBACK_KEYS.MEALS)) || [];
      setRaw(FALLBACK_KEYS.MEALS, JSON.stringify(current.filter((entry) => entry.id !== id)));
    },
    async setPendingMutations(mutations) {
      setRaw(FALLBACK_KEYS.PENDING_MUTATIONS, JSON.stringify(mutations || []));
    },
    async putPendingMutation(mutation) {
      const current = parseJson(getRaw(FALLBACK_KEYS.PENDING_MUTATIONS)) || [];
      const next = current.filter((entry) => entry.mutationId !== mutation.mutationId);
      next.push(mutation);
      setRaw(FALLBACK_KEYS.PENDING_MUTATIONS, JSON.stringify(next));
    },
    async deletePendingMutation(id) {
      const current = parseJson(getRaw(FALLBACK_KEYS.PENDING_MUTATIONS)) || [];
      setRaw(FALLBACK_KEYS.PENDING_MUTATIONS, JSON.stringify(current.filter((entry) => entry.mutationId !== id)));
    },
    async setSyncState(syncState) {
      setRaw(FALLBACK_KEYS.SYNC_STATE, JSON.stringify(syncState || {}));
    },
    async setAuthState(authState) {
      setRaw(FALLBACK_KEYS.AUTH_STATE, JSON.stringify(authState || {}));
    },
    async setLegacyMigration(record) {
      setRaw(FALLBACK_KEYS.LEGACY_MIGRATION, JSON.stringify(record || {}));
    },
    async clearDomainData() {
      removeRaw(FALLBACK_KEYS.PROFILE);
      removeRaw(FALLBACK_KEYS.WEIGHTS);
      removeRaw(FALLBACK_KEYS.MEALS);
      removeRaw(FALLBACK_KEYS.PENDING_MUTATIONS);
      removeRaw(FALLBACK_KEYS.SYNC_STATE);
    }
  };
}

function enqueueWrite(task) {
  writeChain = writeChain
    .then(() => task())
    .catch((error) => {
      if (typeof console !== "undefined" && console.error) {
        console.error("MaxMode storage write failed:", error);
      }
    });
  return writeChain;
}

export function flushStorageWrites() {
  return writeChain;
}

function persistProfile() {
  return enqueueWrite(() => getAdapter().setProfile(snapshotProfileRecord()));
}

function persistWeights() {
  return enqueueWrite(() => getAdapter().setWeights(memoryState.weights));
}

function persistMeals() {
  return enqueueWrite(() => getAdapter().setMeals(memoryState.meals));
}

function persistAuthState() {
  return enqueueWrite(() => getAdapter().setAuthState(memoryState.auth));
}

function persistSyncState() {
  return enqueueWrite(() => getAdapter().setSyncState(memoryState.syncState));
}

function persistPendingMutations() {
  return enqueueWrite(() => getAdapter().setPendingMutations(memoryState.pendingMutations));
}

async function requestPersistentStorage() {
  if (typeof navigator === "undefined" || !navigator.storage || typeof navigator.storage.persist !== "function") {
    return false;
  }
  try {
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}

function clearLegacyKeys() {
  if (typeof localStorage === "undefined") return;
  localStorage.removeItem(LEGACY_KEYS.USER);
  localStorage.removeItem(LEGACY_KEYS.WEIGHTS);
  localStorage.removeItem(LEGACY_KEYS.MEALS);
  localStorage.removeItem(LEGACY_KEYS.CALORIE_TRACKER_META);
}

async function maybeMigrateLegacy(rawSnapshot) {
  const legacyMigration = rawSnapshot && rawSnapshot.legacyMigration;
  if (legacyMigration && legacyMigration.completed) {
    return normalizeSnapshot(rawSnapshot);
  }

  const normalizedSnapshot = normalizeSnapshot(rawSnapshot);
  if (hasMeaningfulLocalData(normalizedSnapshot)) {
    await getAdapter().setLegacyMigration({
      completed: true,
      migratedAt: new Date().toISOString()
    });
    return normalizedSnapshot;
  }

  const legacySnapshot = readLegacySnapshot();
  if (!hasMeaningfulLocalData(legacySnapshot)) {
    await getAdapter().setLegacyMigration({
      completed: true,
      migratedAt: new Date().toISOString()
    });
    return normalizedSnapshot;
  }

  const merged = {
    ...normalizedSnapshot,
    user: legacySnapshot.user,
    weights: legacySnapshot.weights,
    meals: legacySnapshot.meals,
    calorieTrackerMeta: legacySnapshot.calorieTrackerMeta
  };

  await Promise.all([
    getAdapter().setProfile(snapshotProfileRecord(merged)),
    getAdapter().setWeights(merged.weights),
    getAdapter().setMeals(merged.meals),
    getAdapter().setLegacyMigration({
      completed: true,
      migratedAt: new Date().toISOString()
    })
  ]);
  clearLegacyKeys();
  return merged;
}

function generateDeviceId() {
  return createEntryId();
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

function mergePreferences(currentPreferences, patch, goalObjective = null) {
  const sourcePatch = (patch && typeof patch === "object") ? patch : {};
  return normalizePreferences({
    ...normalizePreferences(currentPreferences, goalObjective),
    ...sourcePatch
  }, goalObjective);
}

function mergeCalorieGoal(currentGoal, patch) {
  const sourcePatch = (patch && typeof patch === "object") ? patch : {};
  return normalizeCalorieGoal({
    ...normalizeCalorieGoal(currentGoal),
    ...sourcePatch
  });
}

function upsertWeightInMemory(weight) {
  const next = memoryState.weights.filter((entry) => entry.id !== weight.id);
  next.push(weight);
  const normalized = normalizeWeights(next, new Date().toISOString()).weights;
  memoryState.weights = normalized;
  cachedState = buildPublicState(memoryState);
}

function upsertMealInMemory(meal) {
  const next = memoryState.meals.filter((entry) => entry.id !== meal.id);
  next.push(meal);
  const normalized = normalizeMeals(next, new Date().toISOString()).meals;
  memoryState.meals = normalized;
  cachedState = buildPublicState(memoryState);
}

function queueMutation(type, entityId, payload) {
  const mutation = {
    mutationId: createEntryId(),
    type,
    entityId: entityId || null,
    payload,
    enqueuedAt: new Date().toISOString()
  };
  memoryState.pendingMutations = memoryState.pendingMutations.concat(mutation);
  cachedState = buildPublicState(memoryState);
  enqueueWrite(() => getAdapter().putPendingMutation(mutation));
  scheduleSync();
  return mutation;
}

function queueProfileMutation() {
  queueMutation("profile.upsert", SINGLETON_KEY, {
    user: memoryState.user,
    calorieTrackerMeta: normalizeCalorieTrackerMeta(memoryState.calorieTrackerMeta)
  });
}

function replacePendingMutations(nextMutations) {
  memoryState.pendingMutations = normalizePendingMutations(nextMutations);
  cachedState = buildPublicState(memoryState);
  persistPendingMutations();
}

function seedPendingMutationsFromSnapshot() {
  const seedMutations = [];
  if (memoryState.user || memoryState.calorieTrackerMeta.reminderOptIn || memoryState.calorieTrackerMeta.lastReminderDay) {
    seedMutations.push({
      mutationId: createEntryId(),
      type: "profile.upsert",
      entityId: SINGLETON_KEY,
      payload: {
        user: memoryState.user,
        calorieTrackerMeta: normalizeCalorieTrackerMeta(memoryState.calorieTrackerMeta)
      },
      enqueuedAt: new Date().toISOString()
    });
  }

  for (let i = 0; i < memoryState.weights.length; i += 1) {
    const weight = memoryState.weights[i];
    seedMutations.push({
      mutationId: createEntryId(),
      type: "weight.upsert",
      entityId: weight.id,
      payload: { ...weight },
      enqueuedAt: new Date().toISOString()
    });
  }

  for (let i = 0; i < memoryState.meals.length; i += 1) {
    const meal = memoryState.meals[i];
    seedMutations.push({
      mutationId: createEntryId(),
      type: "meal.upsert",
      entityId: meal.id,
      payload: { ...meal },
      enqueuedAt: new Date().toISOString()
    });
  }

  replacePendingMutations(seedMutations);
}

function updateAuthState(patch, { emit = true } = {}) {
  memoryState.auth = normalizeAuthState({
    ...memoryState.auth,
    ...patch
  });
  cachedState = buildPublicState(memoryState);
  persistAuthState();
  if (emit) emitStateChange();
}

function updateSyncState(patch, { emit = true } = {}) {
  memoryState.syncState = normalizeSyncState({
    ...memoryState.syncState,
    ...patch
  });
  cachedState = buildPublicState(memoryState);
  persistSyncState();
  if (emit) emitStateChange();
}

export async function initStorage() {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await requestPersistentStorage();
    const rawSnapshot = await getAdapter().readSnapshot();
    const migratedSnapshot = await maybeMigrateLegacy(rawSnapshot);
    const nextSnapshot = normalizeSnapshot(migratedSnapshot);

    if (!nextSnapshot.syncState.deviceId) {
      nextSnapshot.syncState = {
        ...nextSnapshot.syncState,
        deviceId: generateDeviceId()
      };
      await getAdapter().setSyncState(nextSnapshot.syncState);
    }

    setMemoryState(nextSnapshot, { emit: false });
    initialized = true;
    syncBootstrapLoaded = true;
    return loadState();
  })();

  return initPromise;
}

export function invalidateState() {
  initialized = false;
  syncBootstrapLoaded = false;
  initPromise = null;
  memoryState = createDefaultMemoryState();
  cachedState = buildPublicState(memoryState);
}

export function loadState() {
  ensureSynchronousBootstrap();
  return cachedState;
}

function isBrowserOnline() {
  if (typeof navigator === "undefined" || typeof navigator.onLine !== "boolean") return true;
  return navigator.onLine;
}

async function registerBackgroundSync() {
  if (typeof navigator === "undefined" || !navigator.serviceWorker || !navigator.serviceWorker.ready) return;
  try {
    const registration = await navigator.serviceWorker.ready;
    if (registration.sync && typeof registration.sync.register === "function") {
      await registration.sync.register("maxmode-sync");
    }
  } catch {
    // Background Sync is best-effort.
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, {
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    ...options
  });
  const text = await response.text();
  const payload = text ? parseJson(text) : null;
  return { response, payload };
}

function removeAppliedMutations(appliedIds) {
  if (!Array.isArray(appliedIds) || appliedIds.length === 0) return;
  const idSet = new Set(appliedIds);
  memoryState.pendingMutations = memoryState.pendingMutations.filter((mutation) => !idSet.has(mutation.mutationId));
  cachedState = buildPublicState(memoryState);
  enqueueWrite(async () => {
    for (let i = 0; i < appliedIds.length; i += 1) {
      await getAdapter().deletePendingMutation(appliedIds[i]);
    }
  });
}

function applyProfilePayload(payload, profileChanged) {
  if (!profileChanged) return;
  const user = payload && payload.user ? normalizeUser(payload.user) : null;
  const meta = payload && payload.calorieTrackerMeta
    ? normalizeCalorieTrackerMeta(payload.calorieTrackerMeta)
    : { ...DEFAULT_CALORIE_TRACKER_META };
  memoryState.user = user;
  memoryState.calorieTrackerMeta = meta;
  enqueueWrite(() => getAdapter().setProfile(snapshotProfileRecord()));
}

function applyRemoteWeight(weight) {
  if (weight && weight.deletedAt) {
    memoryState.weights = memoryState.weights.filter((entry) => entry.id !== weight.id);
    enqueueWrite(() => getAdapter().deleteWeight(weight.id));
    return;
  }
  const normalized = normalizeWeights([weight], new Date().toISOString()).weights;
  if (normalized.length === 0) return;
  upsertWeightInMemory(normalized[0]);
  enqueueWrite(() => getAdapter().putWeight(normalized[0]));
}

function applyRemoteMeal(meal) {
  if (meal && meal.deletedAt) {
    memoryState.meals = memoryState.meals.filter((entry) => entry.id !== meal.id);
    enqueueWrite(() => getAdapter().deleteMeal(meal.id));
    return;
  }
  const normalized = normalizeMeals([meal], new Date().toISOString()).meals;
  if (normalized.length === 0) return;
  upsertMealInMemory(normalized[0]);
  enqueueWrite(() => getAdapter().putMeal(normalized[0]));
}

function finalizeSyncSuccess(serverVersion) {
  memoryState.syncState = normalizeSyncState({
    ...memoryState.syncState,
    lastPulledVersion: serverVersion,
    syncStatus: "idle",
    lastSyncAt: new Date().toISOString(),
    lastError: ""
  });
  if (hasMeaningfulLocalData(memoryState)) {
    memoryState.auth = normalizeAuthState({
      ...memoryState.auth,
      hasServerData: true,
      lastError: ""
    });
  }
  cachedState = buildPublicState(memoryState);
  persistSyncState();
  persistAuthState();
  emitStateChange();
}

function handleSyncError(message, { unauthorized = false } = {}) {
  if (unauthorized) {
    memoryState.auth = normalizeAuthState({
      ...memoryState.auth,
      status: "guest",
      email: "",
      hasServerData: false,
      checkedAt: new Date().toISOString(),
      lastError: ""
    });
    memoryState.syncState = normalizeSyncState({
      ...memoryState.syncState,
      syncStatus: "paused",
      lastError: ""
    });
  } else {
    memoryState.syncState = normalizeSyncState({
      ...memoryState.syncState,
      syncStatus: "error",
      lastError: message || "Unable to sync right now."
    });
  }
  cachedState = buildPublicState(memoryState);
  persistAuthState();
  persistSyncState();
  emitStateChange();
}

export async function syncNow() {
  if (syncPromise) return syncPromise;
  if (memoryState.auth.status !== "authenticated") {
    return loadState();
  }
  if (!isBrowserOnline()) {
    updateSyncState({ syncStatus: "paused" });
    return loadState();
  }

  syncPromise = (async () => {
    updateSyncState({ syncStatus: "syncing", lastError: "" });

    try {
      const { response, payload } = await fetchJson("/api/sync", {
        method: "POST",
        body: JSON.stringify({
          deviceId: memoryState.syncState.deviceId,
          lastPulledVersion: memoryState.syncState.lastPulledVersion,
          mutations: memoryState.pendingMutations
        })
      });

      if (response.status === 401) {
        handleSyncError("", { unauthorized: true });
        return loadState();
      }
      if (!response.ok || !payload) {
        throw new Error(payload && payload.detail ? payload.detail : "Unable to sync right now.");
      }

      removeAppliedMutations(payload.appliedMutationIds || []);
      applyProfilePayload(payload.profile || null, payload.profileChanged === true);

      const remoteWeights = Array.isArray(payload.weights) ? payload.weights : [];
      for (let i = 0; i < remoteWeights.length; i += 1) {
        applyRemoteWeight(remoteWeights[i]);
      }

      const remoteMeals = Array.isArray(payload.meals) ? payload.meals : [];
      for (let i = 0; i < remoteMeals.length; i += 1) {
        applyRemoteMeal(remoteMeals[i]);
      }

      finalizeSyncSuccess(parseWholeNumber(payload.serverVersion) || 0);
      return loadState();
    } catch (error) {
      handleSyncError(error instanceof Error ? error.message : "Unable to sync right now.");
      return loadState();
    } finally {
      syncPromise = null;
    }
  })();

  return syncPromise;
}

function scheduleSync() {
  if (memoryState.auth.status !== "authenticated") return;
  registerBackgroundSync();
  if (syncTimer !== null) {
    clearTimeout(syncTimer);
  }
  syncTimer = setTimeout(() => {
    syncTimer = null;
    syncNow();
  }, SYNC_DEBOUNCE_MS);
}

export async function refreshAuthSession() {
  if (!isBrowserOnline()) return loadState();

  try {
    const { response, payload } = await fetchJson("/api/auth/session", { method: "GET" });
    if (!response.ok || !payload) {
      throw new Error("Unable to verify your session.");
    }

    memoryState.auth = normalizeAuthState({
      status: payload.authenticated ? "authenticated" : "guest",
      email: payload.authenticated ? (payload.email || "") : "",
      hasServerData: payload.authenticated ? payload.hasServerData === true : false,
      checkedAt: new Date().toISOString(),
      lastError: ""
    });
    if (!payload.authenticated) {
      memoryState.syncState = normalizeSyncState({
        ...memoryState.syncState,
        syncStatus: "paused",
        lastError: ""
      });
    }
    cachedState = buildPublicState(memoryState);
    persistAuthState();
    persistSyncState();
    emitStateChange();

    if (payload.authenticated) {
      scheduleSync();
    }
    return loadState();
  } catch (error) {
    updateAuthState({
      checkedAt: new Date().toISOString(),
      lastError: error instanceof Error ? error.message : "Unable to verify your session."
    });
    return loadState();
  }
}

function confirmServerReplacement() {
  if (typeof window === "undefined" || typeof window.confirm !== "function") return true;
  return window.confirm("This account already has server data. Signing in here will replace this device's current guest data with the server copy. Continue?");
}

function clearDomainMemory() {
  memoryState.user = null;
  memoryState.weights = [];
  memoryState.meals = [];
  memoryState.calorieTrackerMeta = { ...DEFAULT_CALORIE_TRACKER_META };
  memoryState.pendingMutations = [];
  cachedState = buildPublicState(memoryState);
}

async function clearDomainPersistence() {
  await getAdapter().clearDomainData();
}

export async function signUp(email, password) {
  const { response, payload } = await fetchJson("/api/auth/sign-up", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  if (!response.ok || !payload || !payload.authenticated) {
    throw new Error(payload && payload.detail ? payload.detail : "Unable to create your account.");
  }

  memoryState.auth = normalizeAuthState({
    status: "authenticated",
    email: payload.email || "",
    hasServerData: payload.hasServerData === true,
    checkedAt: new Date().toISOString(),
    lastError: ""
  });
  cachedState = buildPublicState(memoryState);
  persistAuthState();
  seedPendingMutationsFromSnapshot();
  emitStateChange();
  await syncNow();
  return loadState();
}

export async function signIn(email, password) {
  const { response, payload } = await fetchJson("/api/auth/sign-in", {
    method: "POST",
    body: JSON.stringify({ email, password })
  });

  if (!response.ok || !payload || !payload.authenticated) {
    throw new Error(payload && payload.detail ? payload.detail : "Unable to sign in.");
  }

  const hasLocalSnapshot = hasMeaningfulLocalData(memoryState);
  const shouldReplace = payload.hasServerData === true && hasLocalSnapshot;

  if (shouldReplace && !confirmServerReplacement()) {
    await signOut({ suppressError: true });
    throw new Error("Sign-in cancelled.");
  }

  memoryState.auth = normalizeAuthState({
    status: "authenticated",
    email: payload.email || "",
    hasServerData: payload.hasServerData === true,
    checkedAt: new Date().toISOString(),
    lastError: ""
  });
  cachedState = buildPublicState(memoryState);
  persistAuthState();

  if (shouldReplace) {
    clearDomainMemory();
    await clearDomainPersistence();
    memoryState.syncState = normalizeSyncState({
      ...memoryState.syncState,
      lastPulledVersion: 0,
      syncStatus: "idle",
      lastError: ""
    });
    persistSyncState();
  } else {
    seedPendingMutationsFromSnapshot();
  }

  emitStateChange();
  await syncNow();
  return loadState();
}

export async function signOut(options = {}) {
  if (!isBrowserOnline()) {
    if (options.suppressError) return loadState();
    throw new Error("Signing out needs an online connection.");
  }

  const { response, payload } = await fetchJson("/api/auth/sign-out", {
    method: "POST",
    body: JSON.stringify({})
  });
  if (!response.ok && !options.suppressError) {
    throw new Error(payload && payload.detail ? payload.detail : "Unable to sign out.");
  }

  memoryState.auth = normalizeAuthState({
    status: "guest",
    email: "",
    hasServerData: false,
    checkedAt: new Date().toISOString(),
    lastError: ""
  });
  memoryState.syncState = normalizeSyncState({
    ...memoryState.syncState,
    syncStatus: "paused",
    lastError: ""
  });
  cachedState = buildPublicState(memoryState);
  persistAuthState();
  persistSyncState();
  emitStateChange();
  return loadState();
}

export function getAuthState(state) {
  const source = state || loadState();
  return source && source.auth ? source.auth : buildPublicState(createDefaultMemoryState()).auth;
}

export function setUser(user) {
  ensureSynchronousBootstrap();
  memoryState.user = normalizeUser(user);
  cachedState = buildPublicState(memoryState);
  persistProfile();
  queueProfileMutation();
  emitStateChange();
  return loadState();
}

export function setUserName(name) {
  const trimmed = (typeof name === "string") ? name.trim() : "";
  if (!trimmed) return loadState();

  ensureSynchronousBootstrap();
  const current = loadState();
  const createdAt = current.user && current.user.createdAt ? current.user.createdAt : new Date().toISOString();
  const calorieProfile = current.user && current.user.calorieProfile
    ? current.user.calorieProfile
    : normalizeCalorieProfile(null);
  const calorieGoal = current.user && current.user.calorieGoal
    ? current.user.calorieGoal
    : normalizeCalorieGoal(null);
  const preferences = current.user && current.user.preferences
    ? current.user.preferences
    : normalizePreferences(null, calorieGoal.objective);

  return setUser({
    name: trimmed,
    createdAt,
    calorieProfile,
    calorieGoal,
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

export function getCalorieGoal(state) {
  const source = state || loadState();
  if (!source.user) return normalizeCalorieGoal(null);
  return normalizeCalorieGoal(source.user.calorieGoal);
}

export function setCalorieGoal(goalPatch) {
  const current = loadState();
  if (!current.user) return current;

  const currentGoal = normalizeCalorieGoal(current.user.calorieGoal);
  const calorieGoal = mergeCalorieGoal(current.user.calorieGoal, goalPatch);
  const previousObjective = normalizeMacroGoalObjective(currentGoal.objective);
  const nextObjective = normalizeMacroGoalObjective(calorieGoal.objective);
  const preferences = previousObjective !== nextObjective
    ? mergePreferences(
      current.user.preferences,
      {
        proteinMultiplierGPerKg: getMacroGoalDefaults(nextObjective).proteinMultiplierGPerKg
      },
      nextObjective
    )
    : mergePreferences(current.user.preferences, null, nextObjective);

  return setUser({
    ...current.user,
    calorieGoal,
    preferences
  });
}

export function getUserPreferences(state) {
  const source = state || loadState();
  const goalObjective = source && source.user && source.user.calorieGoal
    ? source.user.calorieGoal.objective
    : null;
  if (!source.user) return normalizePreferences(null, goalObjective);
  return normalizePreferences(source.user.preferences, goalObjective);
}

export function setUserPreferences(preferencesPatch) {
  const current = loadState();
  if (!current.user) return current;

  const preferences = mergePreferences(
    current.user.preferences,
    preferencesPatch,
    current.user.calorieGoal ? current.user.calorieGoal.objective : null
  );
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

  upsertWeightInMemory(entry);
  enqueueWrite(() => getAdapter().putWeight(entry));
  queueMutation("weight.upsert", entry.id, entry);
  emitStateChange();
  return loadState();
}

export function updateWeight(id, value, unit = "kg") {
  if (!id) return false;

  const normalizedKg = normalizeWeightInput(value, unit);
  if (!normalizedKg) return false;

  const state = loadState();
  let updatedEntry = null;
  const next = state.weights.map((entry) => {
    if (entry.id !== id) return entry;
    updatedEntry = {
      id: entry.id,
      weight: normalizedKg,
      unit: "kg",
      timestamp: entry.timestamp
    };
    return updatedEntry;
  });

  if (!updatedEntry) return false;
  memoryState.weights = next;
  cachedState = buildPublicState(memoryState);
  enqueueWrite(() => getAdapter().putWeight(updatedEntry));
  queueMutation("weight.upsert", id, updatedEntry);
  emitStateChange();
  return true;
}

export function deleteWeight(id) {
  if (!id) return false;

  const state = loadState();
  const next = state.weights.filter((entry) => entry.id !== id);
  if (next.length === state.weights.length) return false;

  memoryState.weights = next;
  cachedState = buildPublicState(memoryState);
  enqueueWrite(() => getAdapter().deleteWeight(id));
  queueMutation("weight.delete", id, {
    id,
    deletedAt: new Date().toISOString()
  });
  emitStateChange();
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

export function getMeals(state) {
  const source = state || loadState();
  return Array.isArray(source.meals) ? source.meals.slice() : [];
}

export function addMeal(mealInput) {
  const state = loadState();
  const nowIso = new Date().toISOString();
  const normalized = normalizeMeals([{
    ...mealInput,
    loggedAt: mealInput && mealInput.loggedAt ? mealInput.loggedAt : nowIso
  }], nowIso).meals;

  if (normalized.length === 0) return state;
  upsertMealInMemory(normalized[0]);
  enqueueWrite(() => getAdapter().putMeal(normalized[0]));
  queueMutation("meal.upsert", normalized[0].id, normalized[0]);
  emitStateChange();
  return loadState();
}

export function updateMeal(id, mealPatch) {
  if (!id) return false;

  const state = loadState();
  let updated = false;
  let nextEntry = null;
  const nowIso = new Date().toISOString();

  const next = state.meals.map((entry) => {
    if (entry.id !== id) return entry;
    updated = true;
    const normalized = normalizeMeals([{
      ...entry,
      ...mealPatch,
      id: entry.id,
      loggedAt: (mealPatch && mealPatch.loggedAt) ? mealPatch.loggedAt : entry.loggedAt
    }], nowIso).meals;
    nextEntry = normalized[0] || entry;
    return nextEntry;
  });

  if (!updated || !nextEntry) return false;
  memoryState.meals = next;
  cachedState = buildPublicState(memoryState);
  enqueueWrite(() => getAdapter().putMeal(nextEntry));
  queueMutation("meal.upsert", id, nextEntry);
  emitStateChange();
  return true;
}

export function deleteMeal(id) {
  if (!id) return false;

  const state = loadState();
  const next = state.meals.filter((entry) => entry.id !== id);
  if (next.length === state.meals.length) return false;

  memoryState.meals = next;
  cachedState = buildPublicState(memoryState);
  enqueueWrite(() => getAdapter().deleteMeal(id));
  queueMutation("meal.delete", id, {
    id,
    deletedAt: new Date().toISOString()
  });
  emitStateChange();
  return true;
}

export function getMealById(id) {
  if (!id) return null;
  const state = loadState();
  for (let i = 0; i < state.meals.length; i += 1) {
    if (state.meals[i].id === id) return state.meals[i];
  }
  return null;
}

export function getCalorieTrackerMeta(state) {
  const source = state || loadState();
  return normalizeCalorieTrackerMeta(source.calorieTrackerMeta);
}

export function setCalorieTrackerMeta(metaPatch) {
  const current = getCalorieTrackerMeta(loadState());
  const next = normalizeCalorieTrackerMeta({
    ...current,
    ...((metaPatch && typeof metaPatch === "object") ? metaPatch : {})
  });

  memoryState.calorieTrackerMeta = next;
  cachedState = buildPublicState(memoryState);
  persistProfile();
  queueProfileMutation();
  emitStateChange();
  return loadState();
}

export async function clearAllData() {
  if (memoryState.auth.status === "authenticated") {
    if (!isBrowserOnline()) {
      throw new Error("Resetting account data needs an online connection.");
    }
    const mutation = {
      mutationId: createEntryId(),
      type: "account.reset",
      entityId: SINGLETON_KEY,
      payload: {},
      enqueuedAt: new Date().toISOString()
    };
    memoryState.pendingMutations = [mutation];
    cachedState = buildPublicState(memoryState);
    await getAdapter().setPendingMutations(memoryState.pendingMutations);
    await syncNow();
    clearDomainMemory();
    memoryState.syncState = normalizeSyncState({
      ...memoryState.syncState,
      lastError: "",
      syncStatus: "idle"
    });
    cachedState = buildPublicState(memoryState);
    await clearDomainPersistence();
    persistProfile();
    persistSyncState();
    emitStateChange();
    return loadState();
  }

  clearDomainMemory();
  memoryState.syncState = normalizeSyncState({
    ...DEFAULT_SYNC_STATE,
    deviceId: memoryState.syncState.deviceId || generateDeviceId()
  });
  cachedState = buildPublicState(memoryState);
  await clearDomainPersistence();
  persistSyncState();
  emitStateChange();
  return loadState();
}

function normalizeAvatarGender(gender) {
  if (gender === "male" || gender === "female") return gender;
  return "neutral";
}

function normalizeAvatarSize(size) {
  const parsed = (typeof size === "number") ? size : parseInt(size, 10);
  if (!Number.isFinite(parsed)) return 96;
  return Math.max(64, Math.min(256, Math.round(parsed)));
}

export function avatarUrl(name, gender, size = 96) {
  const params = new URLSearchParams();
  const trimmedName = (typeof name === "string" && name.trim()) ? name.trim() : "MaxMode Member";

  params.set("name", trimmedName);
  params.set("gender", normalizeAvatarGender(gender));
  params.set("size", String(normalizeAvatarSize(size)));

  return `/api/profile/picture?${params.toString()}`;
}
