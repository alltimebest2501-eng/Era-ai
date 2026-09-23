// ERA AI Service Worker V8.2.7
self.addEventListener('install', event => { event.waitUntil(self.skipWaiting()); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', event => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch (_) { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Era AI';
  const options = {
    body: data.body || 'New ERA AI market update',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.data?.type || 'era-ai',
    renotify: true,
    data: data.data || {},
    actions: [{ action: 'open', title: 'Open ERA' }]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) { if ('focus' in client) return client.focus(); }
    return clients.openWindow('/');
  }));
});
