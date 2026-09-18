const CACHE_NAME = "era-ai-v6-cache-v1";

const APP_SHELL = [
  "/",
  "/index.html",
  "/sw.js"
];

// ================================
// INSTALL
// ================================
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {})
  );

  self.skipWaiting();
});

// ================================
// ACTIVATE
// ================================
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );

  self.clients.claim();
});

// ================================
// FETCH
// ================================
self.addEventListener("fetch", (event) => {
  const request = event.request;

  if (request.method !== "GET") return;

  const url = new URL(request.url);

  // API requests should always use network
  if (
    url.pathname.startsWith("/api/") ||
    url.pathname.includes("upstox") ||
    url.pathname.includes("openrouter")
  ) {
    return;
  }

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (
          response &&
          response.status === 200 &&
          response.type === "basic"
        ) {
          const copy = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, copy);
          });
        }

        return response;
      })
      .catch(() => caches.match(request))
  );
});

// ================================
// PUSH NOTIFICATION
// ================================
self.addEventListener("push", (event) => {
  let data = {};

  try {
    data = event.data ? event.data.json() : {};
  } catch (error) {
    try {
      data = {
        title: "Era AI",
        body: event.data ? event.data.text() : "New market update"
      };
    } catch (e) {
      data = {};
    }
  }

  const title = data.title || "Era AI";

  const options = {
    body: data.body || "New market update available.",
    icon: data.icon || "/icon-192.png",
    badge: data.badge || "/icon-192.png",

    tag: data.tag || "era-ai-market",

    renotify: data.renotify !== false,

    requireInteraction:
      data.requireInteraction === true,

    data: {
      url: data.url || "/",
      type: data.type || "market"
    },

    vibrate: [200, 100, 200],

    actions: Array.isArray(data.actions)
      ? data.actions
      : []
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ================================
// NOTIFICATION CLICK
// ================================
self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const notificationData =
    event.notification.data || {};

  const targetUrl =
    notificationData.url || "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then((clientList) => {

      // Existing Era AI tab
      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

      // Open new Era AI tab
      if (clients.openWindow) {
        return clients.openWindow(targetUrl);
      }

      return null;
    })
  );
});

// ================================
// NOTIFICATION CLOSE
// ================================
self.addEventListener("notificationclose", (event) => {
  // Reserved for future notification analytics.
});

// ================================
// MESSAGE HANDLER
// ================================
self.addEventListener("message", (event) => {

  if (!event.data) return;

  // Force service worker update
  if (event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }

});
