window.MaxMode = (function () {
  "use strict";

  // ── Storage Keys ──────────────────────────────────────────────────
  const KEYS = { USER: "maxmode_user", WEIGHTS: "maxmode_weights" };

  // ── Storage Helpers ───────────────────────────────────────────────
  function getUser() {
    try { return JSON.parse(localStorage.getItem(KEYS.USER)); }
    catch { return null; }
  }

  function setUser(user) {
    localStorage.setItem(KEYS.USER, JSON.stringify(user));
  }

  function getWeights() {
    try { return JSON.parse(localStorage.getItem(KEYS.WEIGHTS)) || []; }
    catch { return []; }
  }

  function saveWeights(weights) {
    localStorage.setItem(KEYS.WEIGHTS, JSON.stringify(weights));
  }

  function addWeight(entry) {
    var weights = getWeights();
    weights.unshift(entry);
    saveWeights(weights);
  }

  function clearAllData() {
    localStorage.removeItem(KEYS.USER);
    localStorage.removeItem(KEYS.WEIGHTS);
  }

  // ── Avatar ────────────────────────────────────────────────────────
  function avatarUrl(name) {
    return "https://api.dicebear.com/9.x/notionists/svg?seed=" + encodeURIComponent(name);
  }

  // ── Formatting ────────────────────────────────────────────────────
  function formatDate(iso) {
    var d = new Date(iso);
    return d.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
  }

  function formatTime(iso) {
    var d = new Date(iso);
    return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }

  function relativeTime(iso) {
    var diff = Date.now() - new Date(iso).getTime();
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "Just now";
    if (mins < 60) return mins + "m ago";
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + "h ago";
    var days = Math.floor(hrs / 24);
    if (days < 7) return days + "d ago";
    return formatDate(iso);
  }

  // ── Onboarding ────────────────────────────────────────────────────
  function checkOnboarding() {
    var overlay = document.getElementById("onboarding-overlay");
    if (!overlay) return;

    var user = getUser();
    if (!user) {
      overlay.classList.remove("hidden");
    } else {
      overlay.classList.add("hidden");
      updateNavAvatar(user.name);
    }
  }

  function handleOnboardingSubmit(e) {
    e.preventDefault();
    var input = document.getElementById("onboarding-name");
    var name = input.value.trim();
    if (!name) return;

    setUser({ name: name, createdAt: new Date().toISOString() });
    checkOnboarding();
    onPageLoad();
  }

  // ── Nav Avatar ────────────────────────────────────────────────────
  function updateNavAvatar(name) {
    var img = document.getElementById("nav-avatar");
    if (img) img.src = avatarUrl(name);
  }

  // ── Dashboard ─────────────────────────────────────────────────────
  function populateDashboard() {
    var valueEl = document.getElementById("latest-weight-value");
    if (!valueEl) return;

    var timeEl = document.getElementById("latest-weight-time");
    var weights = getWeights();

    if (weights.length === 0) {
      valueEl.textContent = "--";
      timeEl.textContent = "No entries yet";
    } else {
      var latest = weights[0];
      valueEl.textContent = latest.weight + " " + latest.unit;
      timeEl.textContent = relativeTime(latest.timestamp) + " · " + formatDate(latest.timestamp);
    }
  }

  // ── Weights ───────────────────────────────────────────────────────
  function populateWeights() {
    var tbody = document.getElementById("weight-table-body");
    if (!tbody) return;

    var weights = getWeights();
    var emptyState = document.getElementById("weight-empty-state");
    var tableContainer = document.getElementById("weight-table-container");

    if (weights.length === 0) {
      if (emptyState) emptyState.classList.remove("hidden");
      if (tableContainer) tableContainer.classList.add("hidden");
    } else {
      if (emptyState) emptyState.classList.add("hidden");
      if (tableContainer) tableContainer.classList.remove("hidden");
      tbody.innerHTML = weights.map(function (w) {
        return '<tr class="border-b border-gray-100 dark:border-gray-700/50 last:border-0">'
          + '<td class="px-4 py-3 text-sm">' + escapeHtml(formatDate(w.timestamp)) + "</td>"
          + '<td class="px-4 py-3 text-sm text-gray-500 dark:text-gray-400">' + escapeHtml(formatTime(w.timestamp)) + "</td>"
          + '<td class="px-4 py-3 text-sm font-semibold text-right">' + escapeHtml(w.weight + " " + w.unit) + "</td>"
          + "</tr>";
      }).join("");
    }
  }

  function openWeightModal() {
    var modal = document.getElementById("weight-modal");
    if (modal) {
      modal.classList.remove("hidden");
      var input = document.getElementById("weight-input");
      if (input) { input.value = ""; input.focus(); }
    }
  }

  function closeWeightModal() {
    var modal = document.getElementById("weight-modal");
    if (modal) modal.classList.add("hidden");
  }

  function handleWeightSubmit(e) {
    e.preventDefault();
    var input = document.getElementById("weight-input");
    var value = parseFloat(input.value);
    if (isNaN(value) || value <= 0) return;

    addWeight({
      id: (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2)),
      weight: value,
      unit: "kg",
      timestamp: new Date().toISOString()
    });

    closeWeightModal();
    populateWeights();
  }

  // ── Profile ───────────────────────────────────────────────────────
  function populateProfile() {
    var nameEl = document.getElementById("profile-name");
    if (!nameEl) return;

    var user = getUser();
    if (!user) return;

    nameEl.textContent = user.name;

    var avatarEl = document.getElementById("profile-avatar");
    if (avatarEl) avatarEl.src = avatarUrl(user.name);

    var sinceEl = document.getElementById("profile-since");
    if (sinceEl) sinceEl.textContent = "Member since " + formatDate(user.createdAt);

    var totalEl = document.getElementById("profile-total-entries");
    if (totalEl) totalEl.textContent = getWeights().length;
  }

  function resetData() {
    if (!confirm("This will permanently delete all your data. Are you sure?")) return;
    clearAllData();
    window.location.href = "/";
  }

  // ── Escape HTML ───────────────────────────────────────────────────
  function escapeHtml(str) {
    var div = document.createElement("div");
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
  }

  // ── Master Page Load ──────────────────────────────────────────────
  function onPageLoad() {
    checkOnboarding();
    populateDashboard();
    populateWeights();
    populateProfile();
  }

  // ── Event Listeners ───────────────────────────────────────────────
  document.addEventListener("DOMContentLoaded", onPageLoad);
  document.body.addEventListener("htmx:afterSwap", function (e) {
    if (e.detail && e.detail.target && e.detail.target.id === "main-content") {
      onPageLoad();
    }
  });

  // Close weight modal on Escape key
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") closeWeightModal();
  });

  // Close weight modal on backdrop click
  document.addEventListener("click", function (e) {
    var modal = document.getElementById("weight-modal");
    if (e.target === modal) closeWeightModal();
  });

  // ── Public API ────────────────────────────────────────────────────
  return {
    handleOnboardingSubmit: handleOnboardingSubmit,
    handleWeightSubmit: handleWeightSubmit,
    openWeightModal: openWeightModal,
    closeWeightModal: closeWeightModal,
    resetData: resetData,
    onPageLoad: onPageLoad
  };
})();
