import {
  clearAllData,
  loadState,
  setUserName
} from "./modules/storage.mjs";
import { bindWeightChartThemeEvents } from "./modules/charts.mjs";
import { render as renderDashboard } from "./views/dashboard-ui.mjs";
import {
  handleEscape as handleProfileEscape,
  render as renderProfile,
  renderNavAvatar
} from "./views/profile-ui.mjs";
import {
  closeDeleteSheet,
  closeWeightModal,
  confirmDeleteWeight,
  handleDocumentClick as handleWeightsDocumentClick,
  handleDocumentTouchStart as handleWeightsDocumentTouchStart,
  handleEscape as handleWeightsEscape,
  handleWeightSubmit,
  onViewportChange,
  openWeightModal,
  render as renderWeights,
  resetViewUiState as resetWeightsViewUiState,
  setRequestRender
} from "./views/weights-ui.mjs";
import {
  handleDocumentClick as handleCaloriesDocumentClick,
  handleEscape as handleCaloriesEscape,
  handleSubmit as handleCaloriesSubmit,
  render as renderCalories,
  resetViewUiState as resetCaloriesViewUiState
} from "./views/calories-ui.mjs";

let globalEventsBound = false;
let renderFrame = null;
let navIndicatorFrame = null;
let sidebarIndicatorTrackFrame = null;
let sidebarIndicatorTrackUntil = 0;
let sidebarCollapsed = false;

const SIDEBAR_COLLAPSE_KEY = "maxmode_sidebar_collapsed";

function normalizePath(path) {
  if (!path || path === "/") return "/";
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

function getCurrentPath() {
  return normalizePath(window.location.pathname || "/");
}

function parseCssPixels(rawValue, fallback) {
  const parsed = Number.parseFloat(rawValue);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseCssDuration(rawValue, fallback) {
  if (!rawValue || typeof rawValue !== "string") return fallback;

  const value = rawValue.trim();
  if (!value) return fallback;

  if (value.endsWith("ms")) {
    const parsedMs = Number.parseFloat(value.slice(0, -2));
    return Number.isFinite(parsedMs) ? parsedMs : fallback;
  }

  if (value.endsWith("s")) {
    const parsedSeconds = Number.parseFloat(value.slice(0, -1));
    return Number.isFinite(parsedSeconds) ? parsedSeconds * 1000 : fallback;
  }

  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function getSidebarCollapseDuration() {
  const shell = document.getElementById("app-shell");
  if (!shell) return 240;

  const styles = window.getComputedStyle(shell);
  return parseCssDuration(styles.getPropertyValue("--sidebar-collapse-duration"), 240);
}

function trackSidebarIndicatorDuringCollapse() {
  sidebarIndicatorTrackUntil = Math.max(
    sidebarIndicatorTrackUntil,
    performance.now() + getSidebarCollapseDuration() + 80
  );

  if (sidebarIndicatorTrackFrame !== null) return;

  const step = () => {
    syncNavIndicators();
    if (performance.now() < sidebarIndicatorTrackUntil) {
      sidebarIndicatorTrackFrame = requestAnimationFrame(step);
      return;
    }

    sidebarIndicatorTrackFrame = null;
    queueNavIndicatorSync();
  };

  sidebarIndicatorTrackFrame = requestAnimationFrame(step);
}

function syncNavIndicator(containerSelector, indicatorSelector) {
  const container = document.querySelector(containerSelector);
  const indicator = document.querySelector(indicatorSelector);
  if (!container || !indicator) return;

  const activeLink = container.querySelector("[data-nav-path].is-active");
  if (!activeLink) {
    indicator.classList.remove("is-visible");
    indicator.style.width = "";
    indicator.style.height = "";
    indicator.style.transform = "";
    indicator.style.left = "";
    indicator.style.right = "";
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const linkRect = activeLink.getBoundingClientRect();
  if (containerRect.width <= 0 || containerRect.height <= 0 || linkRect.width <= 0 || linkRect.height <= 0) {
    indicator.classList.remove("is-visible");
    indicator.style.width = "";
    indicator.style.height = "";
    indicator.style.transform = "";
    indicator.style.left = "";
    indicator.style.right = "";
    return;
  }

  let x = linkRect.left - containerRect.left;
  const y = linkRect.top - containerRect.top;
  let width = linkRect.width;
  const mode = indicator.getAttribute("data-indicator-mode");
  const shell = document.getElementById("app-shell");
  const isCollapsedSidebarMode = mode === "sidebar-row"
    && !!(shell && shell.classList.contains("is-sidebar-collapsed"));

  if (mode === "sidebar-row" && !isCollapsedSidebarMode) {
    const style = window.getComputedStyle(container);
    const inset = parseCssPixels(style.getPropertyValue("--sidebar-indicator-inset"), 4);
    x = inset;
    indicator.style.left = `${inset}px`;
    indicator.style.right = `${inset}px`;
    indicator.style.width = "auto";
  } else {
    indicator.style.left = "0px";
    indicator.style.right = "auto";
    indicator.style.width = `${width}px`;
  }

  indicator.style.height = `${linkRect.height}px`;
  indicator.style.transform = `translate3d(${mode === "sidebar-row" && !isCollapsedSidebarMode ? 0 : x}px, ${y}px, 0)`;
  indicator.classList.add("is-visible");
}

function syncNavIndicators() {
  syncNavIndicator(".app-sidebar-nav", ".app-sidebar-indicator");
  syncNavIndicator(".app-bottom-nav-inner", ".app-bottom-indicator");
}

function queueNavIndicatorSync() {
  if (navIndicatorFrame !== null) return;

  navIndicatorFrame = requestAnimationFrame(() => {
    navIndicatorFrame = null;
    syncNavIndicators();
  });
}

function syncNavActiveState() {
  const path = getCurrentPath();
  const links = document.querySelectorAll("[data-nav-path]");
  for (let i = 0; i < links.length; i += 1) {
    const link = links[i];
    const linkPath = normalizePath(link.getAttribute("data-nav-path"));
    const isActive = path === linkPath;
    link.classList.toggle("is-active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  }

  queueNavIndicatorSync();
}

function syncConnectivityIndicator() {
  const indicator = document.getElementById("offline-indicator");
  if (!indicator) return;

  const isOffline = (typeof navigator.onLine === "boolean") ? !navigator.onLine : false;
  indicator.classList.toggle("is-visible", isOffline);
  indicator.setAttribute("aria-hidden", isOffline ? "false" : "true");
}

function readSidebarState() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSE_KEY) === "1";
  } catch (_err) {
    return false;
  }
}

function writeSidebarState(collapsed) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSE_KEY, collapsed ? "1" : "0");
  } catch (_err) {
    // Ignore localStorage write issues.
  }
}

function applySidebarState(collapsed) {
  const shell = document.getElementById("app-shell");
  if (!shell) return;

  shell.classList.toggle("is-sidebar-collapsed", collapsed);

  const toggle = document.getElementById("sidebar-toggle");
  if (!toggle) return;

  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.setAttribute("aria-label", collapsed ? "Expand sidebar" : "Collapse sidebar");
}

function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  applySidebarState(sidebarCollapsed);
  writeSidebarState(sidebarCollapsed);
  queueNavIndicatorSync();
  trackSidebarIndicatorDuringCollapse();
}

function initSidebarState() {
  // TODO(maxmode): Re-enable sidebar collapse toggling once alignment behavior is redesigned.
  sidebarCollapsed = false;
  writeSidebarState(false);
  applySidebarState(false);
}

function detectActiveView() {
  if (document.getElementById("weight-desktop-groups") || document.getElementById("weight-mobile-groups")) {
    return "weights";
  }
  if (document.getElementById("latest-weight-value")) {
    return "dashboard";
  }
  if (document.getElementById("profile-name")) {
    return "profile";
  }
  if (document.getElementById("calories-page-root")) {
    return "calories";
  }
  return "none";
}

function resetAllViewUiState() {
  resetWeightsViewUiState();
  resetCaloriesViewUiState();
}

function maybeOpenWeightModalFromQuery(activeView) {
  if (activeView !== "weights") return;

  const url = new URL(window.location.href);
  if (url.searchParams.get("open_weight_modal") !== "1") return;

  openWeightModal();
  url.searchParams.delete("open_weight_modal");
  const nextUrl = `${url.pathname}${url.search ? url.search : ""}${url.hash}`;
  window.history.replaceState(window.history.state, "", nextUrl);
}

function applyOnboarding(state) {
  const overlay = document.getElementById("onboarding-overlay");
  if (!overlay) return;

  if (!state.user) {
    overlay.classList.remove("hidden");
    return;
  }

  overlay.classList.add("hidden");
}

function renderActiveView() {
  const state = loadState();

  applyOnboarding(state);
  renderNavAvatar(state.user);
  syncNavActiveState();

  const activeView = detectActiveView();

  if (activeView === "dashboard") {
    renderDashboard(state);
    return;
  }

  if (activeView === "weights") {
    renderWeights(state);
    maybeOpenWeightModalFromQuery(activeView);
    return;
  }

  if (activeView === "profile") {
    renderProfile(state);
    return;
  }

  if (activeView === "calories") {
    renderCalories(state);
  }
}

function queueRender() {
  if (renderFrame !== null) return;

  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    renderActiveView();
  });
}

setRequestRender(queueRender);

function handleOnboardingSubmit(event) {
  if (event) event.preventDefault();
  const input = document.getElementById("onboarding-name");
  if (!input) return;

  const name = input.value.trim();
  if (!name) return;

  setUserName(name);
  queueRender();
}

function resetData() {
  if (!confirm("This will permanently delete all your data. Are you sure?")) return;
  clearAllData();
  window.location.href = "/";
}

function bindGlobalEvents() {
  if (globalEventsBound) return;
  globalEventsBound = true;

  bindWeightChartThemeEvents(() => queueRender());
  window.addEventListener("online", syncConnectivityIndicator, { passive: true });
  window.addEventListener("offline", syncConnectivityIndicator, { passive: true });

  document.addEventListener("click", (event) => {
    const target = event.target;

    if (handleWeightsDocumentClick(event)) return;
    if (handleCaloriesDocumentClick(event)) return;

    const action = target && target.closest ? target.closest("[data-action]") : null;
    if (!action) return;

    const actionName = action.getAttribute("data-action");

    if (actionName === "open-weight-modal") {
      openWeightModal();
      return;
    }

    if (actionName === "close-weight-modal") {
      closeWeightModal();
      return;
    }

    if (actionName === "reset-data") {
      resetData();
      return;
    }

    if (actionName === "toggle-sidebar") {
      toggleSidebar();
      return;
    }

    if (actionName === "retry-offline") {
      window.location.reload();
    }
  });

  document.addEventListener("submit", (event) => {
    const form = event.target;

    if (form && form.id === "onboarding-form") {
      handleOnboardingSubmit(event);
      return;
    }

    if (form && form.id === "weight-form") {
      handleWeightSubmit(event);
      return;
    }

    if (handleCaloriesSubmit(event)) {
      return;
    }
  });

  document.addEventListener("touchstart", (event) => {
    handleWeightsDocumentTouchStart(event);
  }, { passive: true });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    handleWeightsEscape();
    handleCaloriesEscape();
    handleProfileEscape();
  });

  const handleViewportEvents = () => {
    onViewportChange();
    queueNavIndicatorSync();
  };
  window.addEventListener("resize", handleViewportEvents, { passive: true });
  window.addEventListener("orientationchange", handleViewportEvents, { passive: true });
  const shell = document.getElementById("app-shell");
  if (shell) {
    shell.addEventListener("transitionrun", (event) => {
      if (event && event.propertyName === "grid-template-columns") {
        trackSidebarIndicatorDuringCollapse();
      }
    });
    shell.addEventListener("transitionend", (event) => {
      if (event && event.propertyName === "grid-template-columns") {
        queueNavIndicatorSync();
      }
    });
  }
  window.addEventListener("popstate", () => {
    syncNavActiveState();
    queueRender();
  });
}

function configureViewTransitions() {
  if (window.htmx && window.htmx.config) {
    const has = typeof document.startViewTransition === "function";
    window.htmx.config.globalViewTransitions = has;
  }
}

function onPageLoad() {
  configureViewTransitions();
  initSidebarState();
  resetAllViewUiState();
  bindGlobalEvents();
  syncConnectivityIndicator();
  renderActiveView();
}

document.addEventListener("DOMContentLoaded", onPageLoad);
document.body.addEventListener("htmx:afterSwap", (event) => {
  if (event.detail && event.detail.target && event.detail.target.id === "main-content") {
    resetAllViewUiState();
    queueRender();
    queueNavIndicatorSync();
  }
});
document.body.addEventListener("htmx:historyRestore", () => {
  resetAllViewUiState();
  queueRender();
  queueNavIndicatorSync();
});

window.MaxMode = {
  handleOnboardingSubmit,
  handleWeightSubmit,
  openWeightModal,
  closeWeightModal,
  closeDeleteSheet,
  confirmDeleteWeight,
  resetData,
  onPageLoad
};
