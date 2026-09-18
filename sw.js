// sw.js - Site band hone par notification dikhane ke liye
self.addEventListener('push', function(event) {
  const data = event.data ? event.data.json() : {};
  const title = data.title || "Era AI Signal Alert";
  const options = {
    body: data.body || "New market opportunity detected.",
    icon: "/icon.png",
    data: { url: data.url || "/?from=notification" }
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    clients.openWindow(event.notification.data.url)
  );
});

