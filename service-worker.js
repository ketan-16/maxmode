var CACHE_NAME = __CACHE_NAME__;

var PRECACHE_URLS = __PRECACHE_URLS__;

function isSameOrigin(requestUrl) {
  return requestUrl.origin === self.location.origin;
}

function isCacheableResponse(response) {
  return !!(response && response.ok && (response.type === "basic" || response.type === "default"));
}

function isAvatarRequest(requestUrl) {
  return isSameOrigin(requestUrl) && requestUrl.pathname === "/api/profile/picture";
}

function isCacheableAvatarResponse(response) {
  return !!(
    response
    && (
      response.type === "opaque"
      || response.type === "cors"
      || response.type === "basic"
      || response.type === "default"
    )
    && (response.ok || response.type === "opaque")
  );
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
  var avatarRequest = isAvatarRequest(url);
  if (!isSameOrigin(url)) return;

  if (avatarRequest) {
    event.respondWith(
      (async function () {
        var cachedAvatar = await caches.match(request);
        if (cachedAvatar) return cachedAvatar;

        try {
          var avatarResponse = await fetch(request);
          if (isCacheableAvatarResponse(avatarResponse)) {
            var avatarCache = await caches.open(CACHE_NAME);
            avatarCache.put(request, avatarResponse.clone());
          }
          return avatarResponse;
        } catch (_err) {
          return cachedAvatar || Response.error();
        }
      })()
    );
    return;
  }

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
