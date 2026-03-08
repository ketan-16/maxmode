var CACHE_NAME = "maxmode-v16";

var PRECACHE_URLS = [
  "/",
  "/weights",
  "/calories",
  "/profile",
  "/offline",
  "/static/css/app.css",
  "/static/js/head-init.js",
  "/static/js/bootstrap.mjs",
  "/static/js/sw-register.js",
  "/static/js/modules/data-utils.mjs",
  "/static/js/modules/storage.mjs",
  "/static/js/modules/charts.mjs",
  "/static/js/views/dashboard-ui.mjs",
  "/static/js/views/profile-ui.mjs",
  "/static/js/views/weights-ui.mjs",
  "/static/vendor/htmx.min.js",
  "/static/manifest.json",
  "/static/icons/icon-192.png",
  "/static/icons/icon-512.png"
];

function isSameOrigin(requestUrl) {
  return requestUrl.origin === self.location.origin;
}

function isCacheableResponse(response) {
  return !!(response && response.ok && (response.type === "basic" || response.type === "default"));
}

self.addEventListener("install", function (event) {
  event.waitUntil(
    caches.open(CACHE_NAME).then(function (cache) {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  self.skipWaiting();
});

self.addEventListener("activate", function (event) {
  event.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(
        keys
          .filter(function (key) { return key !== CACHE_NAME; })
          .map(function (key) { return caches.delete(key); })
      );
    })
  );
  self.clients.claim();
});

self.addEventListener("message", function (event) {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", function (event) {
  var request = event.request;

  if (request.method !== "GET") return;
  if (request.headers.get("HX-Request")) return;

  var url = new URL(request.url);
  if (!isSameOrigin(url)) return;

  if (request.mode === "navigate") {
    event.respondWith(
      (async function () {
        try {
          var response = await fetch(request);

          if (isCacheableResponse(response)) {
            var cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
          }

          return response;
        } catch (_err) {
          var cachedPage = await caches.match(request);
          if (cachedPage) return cachedPage;
          return caches.match("/offline");
        }
      })()
    );
    return;
  }

  if (url.pathname.startsWith("/static/")) {
    event.respondWith(
      (async function () {
        var cachedAsset = await caches.match(request);
        if (cachedAsset) return cachedAsset;

        try {
          var response = await fetch(request);
          if (isCacheableResponse(response)) {
            var cache = await caches.open(CACHE_NAME);
            cache.put(request, response.clone());
          }
          return response;
        } catch (_err) {
          return cachedAsset || Response.error();
        }
      })()
    );
  }
});
