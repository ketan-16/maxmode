let globalEventsBound = false;
let activeSliderShell = null;

function parseFiniteNumber(value, fallback = null) {
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function getStepPrecision(step) {
  if (!Number.isFinite(step)) return 2;
  const raw = String(step);
  const dotIndex = raw.indexOf(".");
  return dotIndex >= 0 ? raw.length - dotIndex - 1 : 0;
}

function formatSliderValue(value, precision) {
  if (!Number.isFinite(value)) return "0";
  const fixed = value.toFixed(Math.max(0, precision));
  return fixed.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}

function getSliderBounds(input) {
  const min = parseFiniteNumber(input.min, 0);
  const max = parseFiniteNumber(input.max, 100);
  const stepRaw = parseFiniteNumber(input.step, null);
  const step = (stepRaw !== null && stepRaw > 0) ? stepRaw : null;

  return {
    min,
    max: max > min ? max : min,
    step,
    precision: getStepPrecision(step || 0.01)
  };
}

function valueToPercent(value, bounds) {
  if (!bounds || bounds.max <= bounds.min) return 0;
  return ((value - bounds.min) / (bounds.max - bounds.min)) * 100;
}

function percentToValue(percent, bounds) {
  if (!bounds || bounds.max <= bounds.min) return bounds ? bounds.min : 0;
  const ratio = clamp(percent, 0, 100) / 100;
  return bounds.min + ((bounds.max - bounds.min) * ratio);
}

function snapValue(value, bounds) {
  if (!bounds || !bounds.step) {
    return clamp(value, bounds ? bounds.min : value, bounds ? bounds.max : value);
  }

  const raw = clamp(value, bounds.min, bounds.max);
  const stepIndex = Math.round((raw - bounds.min) / bounds.step);
  const snapped = bounds.min + (stepIndex * bounds.step);
  const safe = clamp(snapped, bounds.min, bounds.max);
  return parseFiniteNumber(safe.toFixed(bounds.precision), raw);
}

function releaseActiveSlider() {
  if (!activeSliderShell) return;
  activeSliderShell.classList.remove("is-active");
  activeSliderShell = null;
}

function setSliderActive(shell, isActive) {
  if (!shell) return;

  if (!isActive) {
    if (activeSliderShell === shell) {
      releaseActiveSlider();
    } else {
      shell.classList.remove("is-active");
    }
    return;
  }

  if (activeSliderShell && activeSliderShell !== shell) {
    activeSliderShell.classList.remove("is-active");
  }

  activeSliderShell = shell;
  shell.classList.add("is-active");
}

function bindGlobalEvents() {
  if (globalEventsBound) return;
  globalEventsBound = true;

  window.addEventListener("blur", releaseActiveSlider, { passive: true });
}

function buildSliderVisual() {
  const visual = document.createElement("div");
  visual.className = "apple-slider-visual";
  visual.setAttribute("aria-hidden", "true");
  visual.innerHTML = `
    <div class="apple-slider-track"></div>
    <div class="apple-slider-progress"></div>
    <div class="apple-slider-thumb">
      <div class="apple-slider-thumb-filter"></div>
      <div class="apple-slider-thumb-overlay"></div>
      <div class="apple-slider-thumb-specular"></div>
    </div>
  `;
  return visual;
}

function getSliderState(shell) {
  if (!shell._appleSliderState) {
    shell._appleSliderState = {
      dragging: false,
      pointerId: null,
      rawValue: null
    };
  }

  return shell._appleSliderState;
}

function ensureEnhanced(input) {
  if (!input || input.tagName !== "INPUT" || input.type !== "range") return null;

  bindGlobalEvents();

  let shell = input.closest(".apple-slider-shell");
  if (!shell) {
    shell = document.createElement("div");
    shell.className = "apple-slider-shell";
    input.parentNode.insertBefore(shell, input);
    shell.appendChild(input);
    shell.appendChild(buildSliderVisual());
  }

  input.classList.add("apple-slider-input");
  input.dataset.appleSliderReady = "1";
  getSliderState(shell);
  return shell;
}

function setSliderVisual(shell, value, bounds) {
  if (!shell || !bounds) return;
  const boundedValue = clamp(value, bounds.min, bounds.max);
  const percent = clamp(valueToPercent(boundedValue, bounds), 0, 100);
  shell.style.setProperty("--apple-slider-progress", `${percent}%`);
}

function emitSliderEvent(input, type) {
  input.dispatchEvent(new Event(type, { bubbles: true }));
}

function setLiveSliderValue(input, value) {
  const shell = ensureEnhanced(input);
  if (!shell) return;

  const state = getSliderState(shell);
  const bounds = getSliderBounds(input);
  const boundedValue = clamp(value, bounds.min, bounds.max);

  state.rawValue = boundedValue;
  input.dataset.appleSliderLiveValue = formatSliderValue(boundedValue, Math.max(bounds.precision, 2));
  setSliderVisual(shell, boundedValue, bounds);
  emitSliderEvent(input, "input");
}

function commitSliderValue(input, value, emitChange = true) {
  const shell = ensureEnhanced(input);
  if (!shell) return;

  const state = getSliderState(shell);
  const bounds = getSliderBounds(input);
  const snappedValue = snapValue(value, bounds);

  delete input.dataset.appleSliderLiveValue;
  input.value = formatSliderValue(snappedValue, bounds.precision);
  state.rawValue = snappedValue;
  setSliderVisual(shell, snappedValue, bounds);
  emitSliderEvent(input, "input");
  if (emitChange) {
    emitSliderEvent(input, "change");
  }
}

function updateSliderFromPointer(input, clientX) {
  const shell = ensureEnhanced(input);
  if (!shell) return;

  const bounds = getSliderBounds(input);
  const rect = shell.getBoundingClientRect();
  const offsetX = clamp(clientX - rect.left, 0, rect.width);
  const percent = rect.width > 0 ? (offsetX / rect.width) * 100 : 0;
  setLiveSliderValue(input, percentToValue(percent, bounds));
}

function handleSliderKeydown(input, event) {
  if (!input || input.disabled || !event) return;

  const bounds = getSliderBounds(input);
  const current = parseFiniteNumber(input.value, bounds.min);
  const step = bounds.step || ((bounds.max - bounds.min) / 100) || 1;
  let next = null;

  if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
    next = current - step;
  } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
    next = current + step;
  } else if (event.key === "PageDown") {
    next = current - (step * 2);
  } else if (event.key === "PageUp") {
    next = current + (step * 2);
  } else if (event.key === "Home") {
    next = bounds.min;
  } else if (event.key === "End") {
    next = bounds.max;
  }

  if (next === null) return;

  event.preventDefault();
  const shell = ensureEnhanced(input);
  if (shell) shell.classList.remove("is-dragging");
  commitSliderValue(input, next);
}

function bindInputEvents(input) {
  if (!input || input.dataset.appleSliderBound === "1") return;

  const shell = ensureEnhanced(input);
  if (!shell) return;

  const state = getSliderState(shell);
  input.dataset.appleSliderBound = "1";

  input.addEventListener("input", () => {
    syncRangeInputVisual(input);
  });

  input.addEventListener("change", () => {
    syncRangeInputVisual(input);
  });

  input.addEventListener("pointerdown", (event) => {
    if (input.disabled) return;
    if (event.button !== undefined && event.button !== 0) return;

    state.dragging = true;
    state.pointerId = event.pointerId;
    shell.classList.add("is-dragging");
    setSliderActive(shell, true);

    if (typeof input.setPointerCapture === "function") {
      input.setPointerCapture(event.pointerId);
    }

    updateSliderFromPointer(input, event.clientX);
  });

  input.addEventListener("pointermove", (event) => {
    if (!state.dragging || state.pointerId !== event.pointerId) return;
    if (event.cancelable) event.preventDefault();
    updateSliderFromPointer(input, event.clientX);
  });

  function finishPointer(event) {
    if (!state.dragging || state.pointerId !== event.pointerId) return;

    state.dragging = false;
    state.pointerId = null;
    shell.classList.remove("is-dragging");
    setSliderActive(shell, false);

    const liveValue = parseFiniteNumber(input.dataset.appleSliderLiveValue, parseFiniteNumber(input.value, 0));
    commitSliderValue(input, liveValue);

    if (typeof input.releasePointerCapture === "function" && input.hasPointerCapture && input.hasPointerCapture(event.pointerId)) {
      input.releasePointerCapture(event.pointerId);
    }
  }

  input.addEventListener("pointerup", finishPointer);
  input.addEventListener("pointercancel", finishPointer);
  input.addEventListener("blur", () => {
    setSliderActive(shell, false);
  });
  input.addEventListener("keydown", (event) => {
    handleSliderKeydown(input, event);
  });
}

export function syncRangeInputVisual(input) {
  const shell = ensureEnhanced(input);
  if (!shell || !input) return;

  bindInputEvents(input);

  const state = getSliderState(shell);
  const bounds = getSliderBounds(input);
  const liveValue = parseFiniteNumber(input.dataset.appleSliderLiveValue, null);
  const inputValue = parseFiniteNumber(input.value, bounds.min);
  const value = (liveValue !== null && state.dragging) ? liveValue : inputValue;

  setSliderVisual(shell, value, bounds);
  shell.classList.toggle("is-disabled", !!input.disabled);
}

export function refreshRangeSliders(root = document) {
  bindGlobalEvents();

  const scope = root && typeof root.querySelectorAll === "function" ? root : document;
  const inputs = scope.querySelectorAll('input[type="range"]');
  for (let i = 0; i < inputs.length; i += 1) {
    syncRangeInputVisual(inputs[i]);
  }
}
