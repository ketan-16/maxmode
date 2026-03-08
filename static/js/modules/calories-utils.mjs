export const CALORIE_GENDERS = ["male", "female"];

export const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  "lightly-active": 1.375,
  "moderately-active": 1.55,
  "very-active": 1.725,
  "extra-active": 1.9
};

export const ACTIVITY_OPTIONS = [
  {
    key: "sedentary",
    icon: "armchair",
    title: "Sedentary",
    description: "Mostly sitting with little to no planned exercise."
  },
  {
    key: "lightly-active",
    icon: "footprints",
    title: "Lightly active",
    description: "Light movement daily or training 1 to 3 days per week."
  },
  {
    key: "moderately-active",
    icon: "dumbbell",
    title: "Moderately active",
    description: "Consistent activity and workouts 3 to 5 days per week."
  },
  {
    key: "very-active",
    icon: "zap",
    title: "Very active",
    description: "Hard training most days or physically demanding routine."
  },
  {
    key: "extra-active",
    icon: "flame",
    title: "Extra active",
    description: "Intense training or manual labor nearly every day."
  }
];

const LB_TO_KG = 0.45359237;

function parseNumber(value) {
  const parsed = (typeof value === "number") ? value : parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function cmToFeetInches(cmValue) {
  const cm = parseNumber(cmValue);
  if (!cm || cm <= 0) return { ft: 0, in: 0 };

  const totalInches = cm / 2.54;
  const ft = Math.floor(totalInches / 12);
  const inchRemainder = Math.round(totalInches - (ft * 12));

  if (inchRemainder >= 12) {
    return { ft: ft + 1, in: 0 };
  }

  return { ft, in: inchRemainder };
}

export function feetInchesToCm(ftValue, inValue) {
  const ft = parseNumber(ftValue);
  const inches = parseNumber(inValue);
  if (ft === null || inches === null) return null;
  if (ft < 0 || inches < 0 || inches >= 12) return null;

  const totalInches = (ft * 12) + inches;
  if (totalInches <= 0) return null;

  return totalInches * 2.54;
}

export function kgToLb(kgValue) {
  const kg = parseNumber(kgValue);
  if (kg === null) return null;
  return kg / LB_TO_KG;
}

export function lbToKg(lbValue) {
  const lb = parseNumber(lbValue);
  if (lb === null) return null;
  return lb * LB_TO_KG;
}

export function weightToKg(value, unit) {
  const parsed = parseNumber(value);
  if (parsed === null || parsed <= 0) return null;

  if (unit === "lb") {
    return lbToKg(parsed);
  }

  return parsed;
}

export function heightToCm(heightInput) {
  if (!heightInput || typeof heightInput !== "object") return null;

  const unit = (heightInput.unit === "ft-in") ? "ft-in" : "cm";

  if (unit === "ft-in") {
    return feetInchesToCm(heightInput.ft, heightInput.in);
  }

  const cm = parseNumber(heightInput.cm);
  if (cm === null || cm <= 0) return null;
  return cm;
}

function isValidGender(gender) {
  return CALORIE_GENDERS.includes(gender);
}

function isValidActivityLevel(activityLevel) {
  return Object.prototype.hasOwnProperty.call(ACTIVITY_MULTIPLIERS, activityLevel);
}

export function getActivityOption(activityLevel) {
  for (let i = 0; i < ACTIVITY_OPTIONS.length; i += 1) {
    if (ACTIVITY_OPTIONS[i].key === activityLevel) return ACTIVITY_OPTIONS[i];
  }
  return null;
}

export function formatActivityLevel(activityLevel, fallback = "Not set") {
  const option = getActivityOption(activityLevel);
  return option ? option.title : fallback;
}

function normalizeAge(ageValue) {
  const age = parseNumber(ageValue);
  if (age === null) return null;

  const roundedAge = Math.round(age);
  if (!Number.isFinite(roundedAge) || roundedAge < 1 || roundedAge > 120) return null;
  return roundedAge;
}

function normalizeHeightCm(heightValue) {
  const heightCm = parseNumber(heightValue);
  if (heightCm === null || heightCm <= 0) return null;
  return heightCm;
}

export function hasCalorieProfileBasics(profile) {
  if (!profile || typeof profile !== "object") return false;

  const age = normalizeAge(profile.age);
  const gender = (typeof profile.gender === "string") ? profile.gender : "";
  const activityLevel = (typeof profile.activityLevel === "string") ? profile.activityLevel : "";
  const heightCm = normalizeHeightCm(profile.height && profile.height.heightCm);

  return !!(age && isValidGender(gender) && isValidActivityLevel(activityLevel) && heightCm);
}

function extractWeightEntries(state) {
  if (state && Array.isArray(state.chartSeries) && state.chartSeries.length > 0) {
    return state.chartSeries;
  }

  const entries = [];
  const source = state && Array.isArray(state.weights) ? state.weights : [];
  for (let i = 0; i < source.length; i += 1) {
    const item = source[i];
    if (!item || typeof item !== "object") continue;

    const weight = parseNumber(item.weight);
    const timestamp = new Date(item.timestamp).getTime();
    if (weight === null || weight <= 0 || !Number.isFinite(timestamp)) continue;

    entries.push({
      weight,
      timestamp
    });
  }

  entries.sort((a, b) => a.timestamp - b.timestamp);
  return entries;
}

export function getLatestWeightKg(state) {
  const entries = extractWeightEntries(state);
  if (entries.length === 0) return null;

  const latest = entries[entries.length - 1];
  const kg = parseNumber(latest.weight);
  if (kg === null || kg <= 0) return null;
  return kg;
}

export function calculateBmr({ age, gender, heightCm, weightKg }) {
  const normalizedAge = normalizeAge(age);
  const normalizedHeightCm = normalizeHeightCm(heightCm);
  const normalizedWeightKg = parseNumber(weightKg);

  if (!normalizedAge || !normalizedHeightCm || normalizedWeightKg === null || normalizedWeightKg <= 0) {
    return null;
  }

  if (!isValidGender(gender)) return null;

  const base = (10 * normalizedWeightKg) + (6.25 * normalizedHeightCm) - (5 * normalizedAge);
  return (gender === "male") ? (base + 5) : (base - 161);
}

export function calculateMaintenanceCalories({ bmr, activityLevel }) {
  const normalizedBmr = parseNumber(bmr);
  if (normalizedBmr === null || normalizedBmr <= 0) return null;
  if (!isValidActivityLevel(activityLevel)) return null;

  return normalizedBmr * ACTIVITY_MULTIPLIERS[activityLevel];
}

export function roundCalories(value) {
  const parsed = parseNumber(value);
  if (parsed === null) return null;
  return Math.round(parsed);
}

export function getCalorieMissingReasons(state) {
  const reasons = [];
  const user = state && state.user ? state.user : null;
  const profile = user && user.calorieProfile ? user.calorieProfile : null;

  const age = normalizeAge(profile && profile.age);
  if (!age) reasons.push("age");

  const gender = (profile && typeof profile.gender === "string") ? profile.gender : "";
  if (!isValidGender(gender)) reasons.push("gender");

  const heightCm = normalizeHeightCm(profile && profile.height && profile.height.heightCm);
  if (!heightCm) reasons.push("height");

  const activityLevel = (profile && typeof profile.activityLevel === "string") ? profile.activityLevel : "";
  if (!isValidActivityLevel(activityLevel)) reasons.push("activityLevel");

  const weightKg = getLatestWeightKg(state);
  if (!weightKg) reasons.push("weight");

  return reasons;
}

export function isCalorieDataComplete(state) {
  return getCalorieMissingReasons(state).length === 0;
}

export function calculateMaintenanceFromState(state) {
  const user = state && state.user ? state.user : null;
  const profile = user && user.calorieProfile ? user.calorieProfile : null;
  if (!profile) return null;

  const weightKg = getLatestWeightKg(state);
  if (!weightKg) return null;

  const age = normalizeAge(profile.age);
  const gender = profile.gender;
  const heightCm = normalizeHeightCm(profile.height && profile.height.heightCm);
  const activityLevel = profile.activityLevel;

  if (!age || !heightCm || !isValidGender(gender) || !isValidActivityLevel(activityLevel)) {
    return null;
  }

  const bmr = calculateBmr({
    age,
    gender,
    heightCm,
    weightKg
  });

  const maintenance = calculateMaintenanceCalories({
    bmr,
    activityLevel
  });

  if (!maintenance) return null;

  return {
    age,
    gender,
    heightCm,
    weightKg,
    activityLevel,
    bmr,
    maintenance,
    maintenanceRounded: roundCalories(maintenance)
  };
}
