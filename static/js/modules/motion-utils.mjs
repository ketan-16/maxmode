export function cssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") {
    return window.CSS.escape(value);
  }
  return String(value).replace(/([\\\"'])/g, "\\$1");
}

export function parseCssTimeMs(rawValue) {
  if (!rawValue) return 0;

  const value = String(rawValue).trim();
  if (!value) return 0;

  if (value.endsWith("ms")) {
    const millis = parseFloat(value.slice(0, -2));
    return Number.isFinite(millis) ? millis : 0;
  }

  if (value.endsWith("s")) {
    const seconds = parseFloat(value.slice(0, -1));
    return Number.isFinite(seconds) ? seconds * 1000 : 0;
  }

  return 0;
}

export function getMaxTransitionMs(element) {
  if (!element) return 0;

  const style = window.getComputedStyle(element);
  const durations = String(style.transitionDuration || "").split(",");
  const delays = String(style.transitionDelay || "").split(",");
  const total = Math.max(durations.length, delays.length);
  let maxMs = 0;

  for (let i = 0; i < total; i += 1) {
    const duration = parseCssTimeMs(durations[i % durations.length]);
    const delay = parseCssTimeMs(delays[i % delays.length]);
    if ((duration + delay) > maxMs) {
      maxMs = duration + delay;
    }
  }

  return maxMs;
}

export function onTransitionEndOrTimeout(element, fallbackMs, callback) {
  if (!element || typeof callback !== "function") {
    return () => {};
  }

  let done = false;
  let timer = null;

  function finish() {
    if (done) return;
    done = true;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    element.removeEventListener("transitionend", onEnd);
    callback();
  }

  function onEnd(event) {
    if (event.target !== element) return;
    finish();
  }

  element.addEventListener("transitionend", onEnd);
  timer = window.setTimeout(finish, Math.max(24, Math.ceil(fallbackMs)));

  return function cleanup() {
    if (done) return;
    done = true;
    if (timer !== null) {
      window.clearTimeout(timer);
    }
    element.removeEventListener("transitionend", onEnd);
  };
}
