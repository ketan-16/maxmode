export const WEIGHT_CHART_RANGES = {
  "7d": 7 * 24 * 60 * 60 * 1000,
  "30d": 30 * 24 * 60 * 60 * 1000,
  "90d": 90 * 24 * 60 * 60 * 1000,
  all: null
};

function createEntryId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

export function normalizeWeights(raw, nowIso) {
  if (!Array.isArray(raw)) return { weights: [], changed: raw !== null };

  const normalized = [];
  let changed = false;
  const fallbackIso = nowIso || new Date().toISOString();

  for (let i = 0; i < raw.length; i += 1) {
    const item = raw[i];
    if (!item || typeof item !== "object") {
      changed = true;
      continue;
    }

    const parsedWeight = (typeof item.weight === "number") ? item.weight : parseFloat(item.weight);
    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) {
      changed = true;
      continue;
    }

    const normalizedItem = {
      id: (typeof item.id === "string" && item.id.length > 0) ? item.id : createEntryId(),
      weight: parsedWeight,
      unit: (typeof item.unit === "string" && item.unit.length > 0) ? item.unit : "kg",
      timestamp: (typeof item.timestamp === "string" && item.timestamp.length > 0) ? item.timestamp : fallbackIso
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

  return { weights: normalized, changed };
}

export function getChartReadyWeights(weights) {
  const source = Array.isArray(weights) ? weights : [];
  const points = [];

  for (let i = 0; i < source.length; i += 1) {
    const entry = source[i];
    if (!entry || typeof entry !== "object") continue;

    const parsedWeight = (typeof entry.weight === "number") ? entry.weight : parseFloat(entry.weight);
    const parsedTimestamp = new Date(entry.timestamp).getTime();

    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) continue;
    if (!Number.isFinite(parsedTimestamp)) continue;

    points.push({
      id: entry.id,
      weight: parsedWeight,
      unit: entry.unit || "kg",
      iso: entry.timestamp,
      timestamp: parsedTimestamp
    });
  }

  points.sort((a, b) => a.timestamp - b.timestamp);
  return points;
}

export function filterWeightSeriesForRange(points, rangeKey) {
  if (!Array.isArray(points) || points.length === 0) return [];
  if (!Object.prototype.hasOwnProperty.call(WEIGHT_CHART_RANGES, rangeKey) || rangeKey === "all") {
    return points.slice();
  }

  const windowMs = WEIGHT_CHART_RANGES[rangeKey];
  if (!windowMs) return points.slice();

  const latestTimestamp = points[points.length - 1].timestamp;
  const cutoff = latestTimestamp - windowMs;
  const filtered = [];

  for (let i = 0; i < points.length; i += 1) {
    if (points[i].timestamp >= cutoff) filtered.push(points[i]);
  }

  if (filtered.length === 1) {
    for (let j = points.length - 1; j >= 0; j -= 1) {
      if (points[j].timestamp < cutoff) {
        filtered.unshift(points[j]);
        break;
      }
    }
  }

  return filtered;
}

export function weightChartRangeLabel(rangeKey) {
  if (rangeKey === "7d") return "last 7 days";
  if (rangeKey === "30d") return "last 30 days";
  if (rangeKey === "90d") return "last 90 days";
  return "all time";
}

export function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export function formatTime(iso) {
  const d = new Date(iso);
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

export function relativeTime(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return formatDate(iso);
}

export function relativeTimeStrict(iso) {
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return "No entries yet";

  let diff = Date.now() - timestamp;
  if (!Number.isFinite(diff) || diff < 0) diff = 0;

  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;

  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;

  const days = Math.floor(hrs / 24);
  if (days <= 2) return "yesterday";
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  const years = Math.max(1, Math.floor(days / 365));
  return `${years}y ago`;
}

export function formatWeightNumber(value) {
  const rounded = Math.round(value * 100) / 100;
  if (!Number.isFinite(rounded)) return "--";
  return rounded.toFixed(2).replace(/\.?0+$/, "");
}

export function formatSignedWeightDelta(value, unit) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "--";

  const normalizedUnit = unit || "kg";
  const magnitude = Math.abs(value);
  if (magnitude < 0.005) return `0 ${normalizedUnit}`;

  const sign = value > 0 ? "+" : "-";
  return `${sign}${formatWeightNumber(magnitude)} ${normalizedUnit}`;
}

export function buildDashboardTrendNote(change30d, unit) {
  if (typeof change30d !== "number" || !Number.isFinite(change30d)) {
    return "Add one more entry to unlock 30D trend insights.";
  }

  const normalizedUnit = unit || "kg";
  if (Math.abs(change30d) < 0.005) {
    return "Stable over the last 30 days.";
  }

  const direction = change30d > 0 ? "Up" : "Down";
  return `${direction} ${formatWeightNumber(Math.abs(change30d))} ${normalizedUnit} over 30 days.`;
}

export function buildWeightLogGroups(weights) {
  const source = Array.isArray(weights) ? weights : [];
  const sorted = [];

  for (let i = 0; i < source.length; i += 1) {
    const entry = source[i];
    if (!entry || typeof entry !== "object") continue;

    const parsedWeight = (typeof entry.weight === "number") ? entry.weight : parseFloat(entry.weight);
    const timestampMs = new Date(entry.timestamp).getTime();

    if (!Number.isFinite(parsedWeight) || parsedWeight <= 0) continue;
    if (!Number.isFinite(timestampMs)) continue;

    sorted.push({
      id: entry.id,
      weight: parsedWeight,
      unit: entry.unit || "kg",
      timestamp: entry.timestamp,
      timestampMs
    });
  }

  sorted.sort((a, b) => b.timestampMs - a.timestampMs);

  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const msDay = 24 * 60 * 60 * 1000;
  const todayStartMs = startOfToday.getTime();
  const last7StartMs = todayStartMs - (7 * msDay);
  const last30StartMs = todayStartMs - (30 * msDay);

  const groups = [
    { key: "today", title: "Today", entries: [] },
    { key: "last-7-days", title: "Last 7 Days", entries: [] },
    { key: "last-30-days", title: "Last 30 Days", entries: [] },
    { key: "older", title: "Older", entries: [] }
  ];

  for (let j = 0; j < sorted.length; j += 1) {
    const item = sorted[j];
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

export function weightLogHasEntries(groups) {
  if (!Array.isArray(groups)) return false;
  for (let i = 0; i < groups.length; i += 1) {
    if (groups[i].entries && groups[i].entries.length > 0) return true;
  }
  return false;
}

export function formatEntryCount(count) {
  if (count === 1) return "1 entry";
  return `${count} entries`;
}

export function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(String(str)));
  return div.innerHTML;
}
