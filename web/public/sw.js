/* Texas After Dark — order-tracking service worker: shows web-push messages and opens the tracking page on tap. */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = data.title || 'Texas After Dark';
  const options = {
    body: data.body || '',
    icon: '/brand/texas-after-dark-transparent-4000px.png',
    badge: '/brand/texas-after-dark-transparent-4000px.png',
    tag: data.order ? `order-${data.order}` : undefined,
    renotify: Boolean(data.order),
    data: { url: data.url || '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (w.url === target && 'focus' in w) return w.focus();
    }
    for (const w of wins) {
      if (new URL(w.url).pathname.startsWith('/t/') && 'navigate' in w) { await w.navigate(target); return w.focus(); }
    }
    return self.clients.openWindow(target);
  })());
});
