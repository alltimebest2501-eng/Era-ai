// Era AI Service Worker

const CACHE_NAME = "era-ai-v2";

const STATIC_ASSETS = [
  "/",
  "/sw.js"
];

// ================================
// INSTALL
// ================================
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(STATIC_ASSETS))
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
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request)
      .then((response) => {
        if (response && response.status === 200) {
          const responseClone = response.clone();

          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone).catch(() => {});
          });
        }

        return response;
      })
      .catch(() => {
        return caches.match(event.request);
      })
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
    data = {
      title: "Era AI",
      body: event.data ? event.data.text() : "New market update."
    };
  }

  const title = data.title || "Era AI Signal Alert";

  const options = {
    body: data.body || "New market opportunity detected.",
    icon: data.icon || "/icon.png",
    badge: data.badge || "/icon.png",
    tag: data.tag || "era-ai-alert",
    renotify: true,
    requireInteraction: data.requireInteraction === true,
    data: {
      url: data.url || "/?from=notification"
    }
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

  const targetUrl =
    event.notification?.data?.url || "/";

  event.waitUntil(
    clients.matchAll({
      type: "window",
      includeUncontrolled: true
    }).then((clientList) => {

      for (const client of clientList) {
        if ("focus" in client) {
          client.navigate(targetUrl);
          return client.focus();
        }
      }

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
  // Reserved for future Era AI notification analytics.
});
