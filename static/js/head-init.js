(function () {
  "use strict";

  var root = document.documentElement;

  function setUiPlatform() {
    var compact = window.matchMedia("(max-width: 1024px)").matches;
    var noHover = window.matchMedia("(hover: none)").matches;
    var coarsePointer = window.matchMedia("(pointer: coarse)").matches;
    root.setAttribute("data-ui-platform", (compact || noHover || coarsePointer) ? "ios" : "macos");
  }

  setUiPlatform();
  window.addEventListener("resize", setUiPlatform, { passive: true });

  var hasViewTransition = typeof document.startViewTransition === "function";
  root.classList.add(hasViewTransition ? "has-view-transition" : "no-view-transition");

  if (window.htmx && window.htmx.config) {
    window.htmx.config.globalViewTransitions = hasViewTransition;
  } else {
    window.__MAXMODE_VIEW_TRANSITIONS__ = hasViewTransition;
  }
})();
