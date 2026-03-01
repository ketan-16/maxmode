import {
  clearAllData,
  loadState,
  setUserName
} from "./modules/storage.mjs";
import { bindWeightChartThemeEvents } from "./modules/charts.mjs";
import { render as renderDashboard } from "./views/dashboard-ui.mjs";
import { render as renderProfile, renderNavAvatar } from "./views/profile-ui.mjs";
import {
  closeDeleteSheet,
  closeWeightModal,
  confirmDeleteWeight,
  handleDocumentClick,
  handleDocumentTouchStart,
  handleEscape,
  handleWeightSubmit,
  onViewportChange,
  openWeightModal,
  render as renderWeights,
  resetViewUiState,
  setRequestRender
} from "./views/weights-ui.mjs";

let globalEventsBound = false;
let renderFrame = null;

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
  return "none";
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

  const activeView = detectActiveView();

  if (activeView === "dashboard") {
    renderDashboard(state);
    return;
  }

  if (activeView === "weights") {
    renderWeights(state);
    return;
  }

  if (activeView === "profile") {
    renderProfile(state);
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

  document.addEventListener("click", (event) => {
    const target = event.target;

    if (handleDocumentClick(event)) return;

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
    }
  });

  document.addEventListener("touchstart", (event) => {
    handleDocumentTouchStart(event);
  }, { passive: true });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    handleEscape();
  });

  window.addEventListener("resize", () => onViewportChange(), { passive: true });
  window.addEventListener("orientationchange", () => onViewportChange(), { passive: true });
}

function configureViewTransitions() {
  if (window.htmx && window.htmx.config) {
    const has = typeof document.startViewTransition === "function";
    window.htmx.config.globalViewTransitions = has;
  }
}

function onPageLoad() {
  configureViewTransitions();
  resetViewUiState();
  bindGlobalEvents();
  renderActiveView();
}

document.addEventListener("DOMContentLoaded", onPageLoad);
document.body.addEventListener("htmx:afterSwap", (event) => {
  if (event.detail && event.detail.target && event.detail.target.id === "main-content") {
    resetViewUiState();
    queueRender();
  }
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
