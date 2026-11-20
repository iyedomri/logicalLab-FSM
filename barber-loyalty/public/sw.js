/* Service worker — coquille statique + Web Push (relances & anniversaire) */
const CACHE = 'barbier-v2';
const SHELL = ['/', '/index.html', '/css/style.css', '/js/card.js', '/icon.svg', '/img/barbershop.jpg'];
self.addEventListener('install', (e) => { self.skipWaiting(); e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).catch(() => {})); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.pathname.startsWith('/api/')) return; // API : toujours le réseau
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {});
    return res;
  }).catch(() => caches.match(e.request).then(cached => cached || caches.match('/'))));
});
/* Web Push : relance « votre chevelure s'impatiente », anniversaire… */
self.addEventListener('push', (e) => {
  let data = { title: 'CarteBarber', body: 'Votre chevelure réclame le barbier.' };
  try { if (e.data) data = Object.assign(data, e.data.json()); } catch { try { data.body = e.data.text(); } catch {} }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body,
    icon: '/icon.svg',
    badge: '/icon.svg',
    tag: 'barbier-notif',
    renotify: true,
    data: { url: (data && data.url) || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = (e.notification.data && e.notification.data.url) || '/';
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    for (const client of list) { if ('focus' in client) { client.navigate(target); return client.focus(); } }
    return clients.openWindow(target);
  }));
});
