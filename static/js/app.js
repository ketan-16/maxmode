// Legacy compatibility shim.
// The application is now bootstrapped from /static/js/bootstrap.mjs.
(function () {
  "use strict";

  if (window.MaxMode) return;

  import("/static/js/bootstrap.mjs").catch(function (err) {
    console.error("Failed to load MaxMode bootstrap module:", err);
  });
})();
