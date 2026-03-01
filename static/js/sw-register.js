if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    navigator.serviceWorker.register("/service-worker.js", { updateViaCache: "none" })
      .then(function (registration) {
        // Ensure newly-deployed workers are activated promptly.
        function promptWaitingWorker(waiting) {
          if (!waiting) return;
          waiting.postMessage({ type: "SKIP_WAITING" });
        }

        if (registration.waiting) {
          promptWaitingWorker(registration.waiting);
        }

        registration.addEventListener("updatefound", function () {
          var worker = registration.installing;
          if (!worker) return;

          worker.addEventListener("statechange", function () {
            if (worker.state === "installed" && registration.waiting) {
              promptWaitingWorker(registration.waiting);
            }
          });
        });
      })
      .catch(function (err) {
        console.error("Service Worker registration failed:", err);
      });
  });
}
