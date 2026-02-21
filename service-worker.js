var CACHE_NAME = "maxmode-v1";

var PRECACHE_URLS = [
  "/",
  "/weights",
  "/profile",
  "/offline",
  "/static/css/app.css",
  "/static/js/app.js",
  "/static/js/sw-register.js",
  "/static/manifest.json"
];

// Install — precache app shell
self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

// Activate — clean old caches
self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (k) { return k !== CACHE_NAME; })
          .map(function (k) { return caches.delete(k); })
      );
    })
  );
  self.clients.claim();
});

// Fetch — network-first for navigation, cache-first for static assets
self.addEventListener("fetch", function (event) {
  // Skip HTMX partial requests to avoid caching partials under full-page URLs
  if (event.request.headers.get("HX-Request")) return;

  // Navigation requests (HTML pages)
  if (event.request.mode === "navigate") {
    event.respondWith(
      fetch(event.request)
        .then(function (response) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
          return response;
        })
        .catch(function () {
          return caches.match(event.request).then(function (cached) {
            return cached || caches.match("/offline");
          });
        })
    );
    return;
  }

  // Static assets — cache-first
  var url = new URL(event.request.url);
  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      caches.match(event.request).then(function (cached) {
        return cached || fetch(event.request).then(function (response) {
          var clone = response.clone();
          caches.open(CACHE_NAME).then(function (cache) {
            cache.put(event.request, clone);
          });
          return response;
        });
      })
    );
  }
});
