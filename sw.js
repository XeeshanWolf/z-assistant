// Z Assistant offline worker and notification handler.
// Bump VERSION whenever any file changes so phones pick up the update.
const VERSION = 'z-assistant-2.0.1';
const SHELL = ['./', 'index.html', 'manifest.json', 'lib/supabase.js', 'fonts/unbounded.woff2', 'fonts/manrope.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-512.png', 'icons/apple-touch-icon.png'];
// Fetched fresh when online, saved copy when offline.
const FRESH = ['index.html', 'config.js'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION)
    .then(c => c.addAll(SHELL).then(() => c.add('config.js').catch(() => {})))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', e => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  const name = url.pathname.split('/').pop();
  if (req.mode === 'navigate' || FRESH.includes(name)) {
    const keyName = req.mode === 'navigate' ? 'index.html' : name;
    // no-cache: always ask the server, so a new app version or new settings are never stuck behind the browser cache.
    e.respondWith(fetch(url.href, { cache: 'no-cache', credentials: 'same-origin' }).then(res => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(keyName, copy)); }
      return res;
    }).catch(() => caches.match(keyName)));
    return;
  }
  e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
    if (res.ok) { const copy = res.clone(); caches.open(VERSION).then(c => c.put(req, copy)); }
    return res;
  })));
});

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.title || 'Z Assistant', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: 'icons/icon-192.png',
    data: { url: d.url || './#today' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const target = new URL((e.notification.data && e.notification.data.url) || './#today', self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope)) {
        c.postMessage({ open: target });
        return c.focus();
      }
    }
    return self.clients.openWindow(target);
  }));
});
